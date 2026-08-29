#!/usr/bin/env python3
"""
Atmosfera — Dashboard meteo per sensori SwitchBot
--------------------------------------------------
Backend Flask che:
  - firma le richieste all'API SwitchBot v1.1 (HMAC-SHA256, base64, uppercase)
  - scansiona i dispositivi e individua i sensori di temperatura/umidità
  - legge i dati in tempo reale e li salva nello storico (history.json)
  - salva/legge le impostazioni (config.json)
  - calcola grandezze derivate: punto di rugiada, umidità assoluta,
    temperatura percepita, indice di comfort

Autore: preparato per Massimo — pronto per Raspberry Pi + systemd.
"""

import os
import json
import time
import uuid
import hmac
import base64
import hashlib
import logging
import threading
import math
from datetime import datetime

import requests
from flask import Flask, jsonify, request, render_template

# --------------------------------------------------------------------------- #
#  Percorsi e costanti
# --------------------------------------------------------------------------- #
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")
HISTORY_PATH = os.path.join(BASE_DIR, "history.json")
WEATHER_CACHE_PATH = os.path.join(BASE_DIR, "weather_cache.json")
WEATHER_DAILY_PATH = os.path.join(BASE_DIR, "weather_daily.json")

SWITCHBOT_BASE = "https://api.switch-bot.com"
OWM_URL = "https://api.openweathermap.org/data/2.5/weather"

# Tipi di dispositivo SwitchBot che espongono temperatura/umidità
METER_TYPES = {
    "Meter",
    "MeterPlus",
    "WoIOSensor",        # sensore esterno IP65 (Indoor/Outdoor)
    "MeterPro",
    "MeterPro(CO2)",
    "Hub 2",             # anche l'Hub 2 misura temp/umidità
}

# Valore sentinella: se il frontend lo rimanda, NON sovrascriviamo la credenziale
MASK = "••••••••"

# Lock per accessi concorrenti ai file (thread di polling + richieste HTTP)
_file_lock = threading.Lock()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("atmosfera")

app = Flask(__name__)


# --------------------------------------------------------------------------- #
#  Configurazione di default
# --------------------------------------------------------------------------- #
def default_config():
    return {
        "credentials": {"token": "", "secret": ""},
        "poll_interval": 120,          # secondi tra un'interrogazione e l'altra
        "min_store_gap": 30,           # non salvare due letture più vicine di così
        "history_max_points": 3000,    # punti massimi di storico per sensore
        "temperature_unit": "C",       # "C" oppure "F"
        "theme": "auto",               # auto | dark | midnight
        "background_poll": True,        # continua a raccogliere anche a pagina chiusa
        "devices": [],                 # popolato dalla scansione
        "widgets": {                   # quali informazioni mostrare
            "temperature": True,
            "humidity": True,
            "battery": True,
            "dewpoint": True,
            "feelslike": True,
            "abshumidity": True,
            "comfort": True,
            "co2": True,
            "sparkline": True,
        },
        "openweather": {               # meteo esterno via OpenWeatherMap
            "enabled": False,
            "api_key": "",
            "city": "",                # es. "Molfetta,IT"
            "poll_interval": 600,      # ogni quanto aggiornare il meteo (s)
            "min_gap": 60,             # anti-spam: non richiamare più spesso di così
        },
    }


def load_config():
    with _file_lock:
        if not os.path.exists(CONFIG_PATH):
            cfg = default_config()
            with open(CONFIG_PATH, "w", encoding="utf-8") as f:
                json.dump(cfg, f, indent=2, ensure_ascii=False)
            return cfg
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    # merge con i default per campi mancanti dopo aggiornamenti
    base = default_config()
    for k, v in base.items():
        if k not in cfg:
            cfg[k] = v
        elif isinstance(v, dict):
            for sk, sv in v.items():
                cfg[k].setdefault(sk, sv)
    return cfg


def save_config(cfg):
    with _file_lock:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2, ensure_ascii=False)


def load_history():
    with _file_lock:
        if not os.path.exists(HISTORY_PATH):
            return {}
        try:
            with open(HISTORY_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except json.JSONDecodeError:
            return {}


def save_history(hist):
    with _file_lock:
        with open(HISTORY_PATH, "w", encoding="utf-8") as f:
            json.dump(hist, f, ensure_ascii=False)


# --------------------------------------------------------------------------- #
#  Autenticazione SwitchBot v1.1
# --------------------------------------------------------------------------- #
def sign_headers(token, secret):
    """Genera header firmati nuovi a ogni chiamata (il timestamp scade)."""
    nonce = str(uuid.uuid4())
    t = str(int(round(time.time() * 1000)))          # timestamp a 13 cifre
    string_to_sign = f"{token}{t}{nonce}".encode("utf-8")
    signature = base64.b64encode(
        hmac.new(secret.encode("utf-8"), string_to_sign, hashlib.sha256).digest()
    ).decode("utf-8").upper()
    return {
        "Authorization": token,
        "sign": signature,
        "t": t,
        "nonce": nonce,
        "Content-Type": "application/json",
    }


def sb_get(path, cfg, timeout=15):
    """GET autenticata verso l'API SwitchBot. Solleva eccezioni su errore."""
    token = cfg["credentials"]["token"]
    secret = cfg["credentials"]["secret"]
    if not token or not secret:
        raise RuntimeError("credentials-missing")
    r = requests.get(
        f"{SWITCHBOT_BASE}{path}",
        headers=sign_headers(token, secret),
        timeout=timeout,
    )
    r.raise_for_status()
    data = r.json()
    if data.get("statusCode") != 100:
        raise RuntimeError(f"switchbot-error:{data.get('statusCode')}:{data.get('message')}")
    return data["body"]


# --------------------------------------------------------------------------- #
#  Grandezze derivate (fisica dell'aria)
# --------------------------------------------------------------------------- #
def dew_point(t, rh):
    """Punto di rugiada (°C) — formula di Magnus."""
    if t is None or rh is None or rh <= 0:
        return None
    a, b = 17.625, 243.04
    gamma = math.log(rh / 100.0) + (a * t) / (b + t)
    return round((b * gamma) / (a - gamma), 1)


def absolute_humidity(t, rh):
    """Umidità assoluta (g/m³)."""
    if t is None or rh is None:
        return None
    ah = (6.112 * math.exp((17.67 * t) / (t + 243.5)) * rh * 2.1674) / (273.15 + t)
    return round(ah, 1)


def feels_like(t, rh):
    """Temperatura percepita (°C). Heat index sopra i 26°C, altrimenti la reale."""
    if t is None or rh is None:
        return t
    if t >= 26:
        # Heat index (Rothfusz) — versione in Celsius
        c1, c2, c3 = -8.784695, 1.611394, 2.338549
        c4, c5, c6 = -0.14611605, -0.012308094, -0.016424828
        c7, c8, c9 = 0.002211732, 0.00072546, -0.000003582
        hi = (c1 + c2 * t + c3 * rh + c4 * t * rh + c5 * t * t
              + c6 * rh * rh + c7 * t * t * rh + c8 * t * rh * rh
              + c9 * t * t * rh * rh)
        return round(hi, 1)
    return round(t, 1)


def comfort_index(t, rh):
    """Etichetta di comfort ambientale a partire da temperatura e umidità."""
    if t is None or rh is None:
        return {"label": "—", "level": "neutro"}
    if t < 16:
        return {"label": "Freddo", "level": "freddo"}
    if t < 19:
        return {"label": "Fresco", "level": "fresco"}
    if 19 <= t <= 25 and 35 <= rh <= 60:
        return {"label": "Confortevole", "level": "comfort"}
    if 19 <= t <= 25 and rh > 60:
        return {"label": "Umido", "level": "umido"}
    if 19 <= t <= 25 and rh < 35:
        return {"label": "Secco", "level": "secco"}
    if 25 < t <= 29:
        return {"label": "Caldo", "level": "caldo"}
    return {"label": "Afoso", "level": "afoso"}


def enrich(reading):
    """Aggiunge le grandezze derivate a una lettura {temperature, humidity, ...}."""
    t = reading.get("temperature")
    rh = reading.get("humidity")
    reading["dewpoint"] = dew_point(t, rh)
    reading["abshumidity"] = absolute_humidity(t, rh)
    reading["feelslike"] = feels_like(t, rh)
    reading["comfort"] = comfort_index(t, rh)
    return reading


# --------------------------------------------------------------------------- #
#  Meteo esterno — OpenWeatherMap
# --------------------------------------------------------------------------- #
# Cache in memoria dell'ultima lettura meteo valida. Serve per due cose:
#  1) non richiamare l'API a ogni apertura di pagina (rispetta i limiti);
#  2) se il limite viene superato, mostrare comunque l'ultimo dato noto.
_weather_cache = {"data": None, "t": 0, "rate_limited": False}


def load_weather_cache():
    global _weather_cache
    if os.path.exists(WEATHER_CACHE_PATH):
        try:
            with open(WEATHER_CACHE_PATH, "r", encoding="utf-8") as f:
                saved = json.load(f)
            if saved.get("data"):
                _weather_cache.update({"data": saved["data"], "t": saved.get("t", 0)})
        except (json.JSONDecodeError, OSError):
            pass


def save_weather_cache():
    try:
        with open(WEATHER_CACHE_PATH, "w", encoding="utf-8") as f:
            json.dump({"data": _weather_cache["data"], "t": _weather_cache["t"]}, f, ensure_ascii=False)
    except OSError:
        pass


# --------------------------------------------------------------------------- #
#  Archivio giornaliero del meteo esterno (min/max per giornata)
# --------------------------------------------------------------------------- #
def load_daily():
    with _file_lock:
        if not os.path.exists(WEATHER_DAILY_PATH):
            return {}
        try:
            with open(WEATHER_DAILY_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            return {}


def save_daily(daily):
    with _file_lock:
        try:
            with open(WEATHER_DAILY_PATH, "w", encoding="utf-8") as f:
                json.dump(daily, f, ensure_ascii=False)
        except OSError:
            pass


def _minmax(rec, key, value, ts):
    """Aggiorna min/max (e l'ora del massimo/minimo) di un campo nel record."""
    if value is None:
        return
    if rec.get(key + "_min") is None or value < rec[key + "_min"]:
        rec[key + "_min"] = value
        if key == "t":
            rec["t_min_t"] = ts
    if rec.get(key + "_max") is None or value > rec[key + "_max"]:
        rec[key + "_max"] = value
        if key == "t":
            rec["t_max_t"] = ts


def update_daily(data):
    """Aggiorna il record giornaliero (min/max di temp, umidità, pressione)."""
    t = data.get("temperature")
    if t is None:
        return
    ts = int(data.get("t", time.time()))
    day = time.strftime("%Y-%m-%d", time.localtime(ts))   # data locale
    daily = load_daily()
    rec = daily.get(day) or {"date": day, "samples": 0, "first": ts}
    _minmax(rec, "t", t, ts)
    _minmax(rec, "h", data.get("humidity"), ts)
    _minmax(rec, "p", data.get("pressure"), ts)
    rec["samples"] = rec.get("samples", 0) + 1
    rec["last"] = ts
    daily[day] = rec
    # conserva circa 400 giorni
    if len(daily) > 400:
        for k in sorted(daily.keys())[:-400]:
            del daily[k]
    save_daily(daily)


def compute_extremes(daily):
    """Giorno più caldo e più freddo, per l'anno in corso e in assoluto."""
    days = [r for r in daily.values() if r.get("t_max") is not None]

    def over(subset):
        if not subset:
            return None
        hottest = max(subset, key=lambda r: r["t_max"])
        coldest = min(subset, key=lambda r: r["t_min"])
        return {
            "hottest": {"date": hottest["date"], "value": hottest["t_max"]},
            "coldest": {"date": coldest["date"], "value": coldest["t_min"]},
        }

    year = time.strftime("%Y")
    year_days = [r for r in days if r["date"].startswith(year)]
    return {"year": over(year_days), "all": over(days), "current_year": year}


def normalize_weather(b):
    """Estrae i campi utili dalla risposta OpenWeatherMap e calcola il rugiada."""
    main = b.get("main", {}) or {}
    wind = b.get("wind", {}) or {}
    sysd = b.get("sys", {}) or {}
    weather = (b.get("weather") or [{}])[0]
    temp = main.get("temp")
    hum = main.get("humidity")
    return {
        "city": b.get("name"),
        "country": sysd.get("country"),
        "temperature": temp,
        "feels_like": main.get("feels_like"),
        "pressure": main.get("pressure"),        # hPa
        "humidity": hum,                         # %
        "dewpoint": dew_point(temp, hum),        # calcolato lato server
        "wind_speed": wind.get("speed"),         # m/s (units=metric)
        "wind_deg": wind.get("deg"),             # direzione (° da cui soffia)
        "wind_gust": wind.get("gust"),
        "condition_id": weather.get("id"),
        "condition_main": weather.get("main"),
        "description": weather.get("description"),
        "icon": weather.get("icon"),             # es. "10d" / "01n"
        "sunrise": sysd.get("sunrise"),
        "sunset": sysd.get("sunset"),
        "t": int(time.time()),
    }


def fetch_weather(cfg=None, force=False, override=None):
    """
    Legge il meteo da OpenWeatherMap con gestione robusta dei limiti.
    Ritorna sempre un dizionario: mai solleva eccezioni verso le rotte.
    Codici possibili in 'error': not-configured, rate-limit, invalid-key,
    city-not-found, network, http-XXX.
    """
    cfg = cfg or load_config()
    ow = dict(cfg.get("openweather", {}))
    if override:
        ow.update(override)
    key = (ow.get("api_key") or "").strip()
    city = (ow.get("city") or "").strip()
    if not key or not city:
        return {"ok": False, "error": "not-configured"}

    now = time.time()
    gap = ow.get("min_gap", 60)
    if not force and _weather_cache["data"] and (now - _weather_cache["t"]) < gap:
        return {"ok": True, "data": _weather_cache["data"], "cached": True,
                "rate_limited": _weather_cache["rate_limited"]}

    try:
        r = requests.get(OWM_URL, params={
            "q": city, "appid": key, "units": "metric", "lang": "it",
        }, timeout=15)
    except requests.RequestException:
        if _weather_cache["data"]:
            return {"ok": True, "data": _weather_cache["data"], "stale": True, "error": "network"}
        return {"ok": False, "error": "network"}

    # --- Limite di utilizzo superato: NON è un errore fatale ---
    if r.status_code == 429:
        _weather_cache["rate_limited"] = True
        log.warning("OpenWeatherMap: limite di utilizzo API superato (429).")
        if _weather_cache["data"]:
            return {"ok": True, "data": _weather_cache["data"], "rate_limited": True, "stale": True}
        return {"ok": False, "error": "rate-limit"}

    if r.status_code == 401:
        return {"ok": False, "error": "invalid-key"}
    if r.status_code == 404:
        return {"ok": False, "error": "city-not-found"}
    if r.status_code != 200:
        if _weather_cache["data"]:
            return {"ok": True, "data": _weather_cache["data"], "stale": True, "error": f"http-{r.status_code}"}
        return {"ok": False, "error": f"http-{r.status_code}"}

    data = normalize_weather(r.json())
    _weather_cache.update({"data": data, "t": now, "rate_limited": False})
    save_weather_cache()
    try:
        update_daily(data)
    except Exception as e:  # noqa: BLE001
        log.warning("Aggiornamento archivio giornaliero fallito: %s", e)
    return {"ok": True, "data": data}


# --------------------------------------------------------------------------- #
#  Lettura live + salvataggio storico
# --------------------------------------------------------------------------- #
def read_device_status(device_id, cfg):
    """Legge lo stato di un dispositivo e normalizza i campi utili."""
    body = sb_get(f"/v1.1/devices/{device_id}/status", cfg)
    reading = {
        "temperature": body.get("temperature"),
        "humidity": body.get("humidity"),
        "battery": body.get("battery"),
        "version": body.get("version"),
    }
    if "CO2" in body:
        reading["co2"] = body.get("CO2")
    return reading


def poll_and_store(cfg=None):
    """Interroga tutti i sensori abilitati, calcola i derivati, salva lo storico."""
    cfg = cfg or load_config()
    enabled = [d for d in cfg.get("devices", []) if d.get("enabled", True)]
    if not enabled:
        return {"ok": False, "reason": "no-devices", "readings": {}}

    hist = load_history()
    now = int(time.time())
    readings = {}
    errors = {}

    for dev in enabled:
        did = dev["deviceId"]
        try:
            r = read_device_status(did, cfg)
            enrich(r)
            r["t"] = now
            r["deviceName"] = dev.get("deviceName", did)
            r["deviceType"] = dev.get("deviceType", "")
            readings[did] = r

            # salva a storico rispettando il gap minimo
            series = hist.setdefault(did, [])
            gap = cfg.get("min_store_gap", 30)
            if not series or (now - series[-1]["t"]) >= gap:
                series.append({
                    "t": now,
                    "temperature": r.get("temperature"),
                    "humidity": r.get("humidity"),
                    "battery": r.get("battery"),
                    **({"co2": r["co2"]} if "co2" in r else {}),
                })
                # taglia lo storico alla dimensione massima
                cap = cfg.get("history_max_points", 3000)
                if len(series) > cap:
                    hist[did] = series[-cap:]
        except Exception as e:  # noqa: BLE001
            errors[did] = str(e)
            log.warning("Lettura fallita per %s: %s", did, e)

    save_history(hist)
    return {"ok": True, "readings": readings, "errors": errors, "t": now}


# --------------------------------------------------------------------------- #
#  Thread di polling in background
# --------------------------------------------------------------------------- #
_bg_thread = None
_bg_stop = threading.Event()
_last_weather = 0


def background_loop():
    global _last_weather
    log.info("Thread di polling avviato.")
    while not _bg_stop.is_set():
        cfg = load_config()
        interval = max(30, int(cfg.get("poll_interval", 120)))
        if cfg.get("background_poll", True) and cfg.get("credentials", {}).get("token"):
            try:
                poll_and_store(cfg)
            except Exception as e:  # noqa: BLE001
                log.warning("Polling in background fallito: %s", e)
        # meteo esterno: aggiornato al proprio ritmo, mai bloccante
        ow = cfg.get("openweather", {})
        if ow.get("enabled") and ow.get("api_key") and ow.get("city"):
            if time.time() - _last_weather >= int(ow.get("poll_interval", 600)):
                try:
                    fetch_weather(cfg, force=True)
                except Exception as e:  # noqa: BLE001
                    log.warning("Aggiornamento meteo fallito: %s", e)
                _last_weather = time.time()
        _bg_stop.wait(interval)


def start_background():
    global _bg_thread
    if _bg_thread is None or not _bg_thread.is_alive():
        _bg_stop.clear()
        _bg_thread = threading.Thread(target=background_loop, daemon=True)
        _bg_thread.start()


# --------------------------------------------------------------------------- #
#  Rotte
# --------------------------------------------------------------------------- #
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/config", methods=["GET"])
def api_get_config():
    cfg = load_config()
    creds = cfg["credentials"]
    # non esponiamo mai il secret: mandiamo solo se è impostato
    safe = json.loads(json.dumps(cfg))
    safe["credentials"] = {
        "token": (creds["token"][:4] + "…" + creds["token"][-4:]) if creds["token"] else "",
        "secret": MASK if creds["secret"] else "",
        "has_token": bool(creds["token"]),
        "has_secret": bool(creds["secret"]),
    }
    # non esponiamo mai la API key del meteo
    ow = cfg.get("openweather", {})
    safe["openweather"] = {
        "enabled": ow.get("enabled", False),
        "city": ow.get("city", ""),
        "poll_interval": ow.get("poll_interval", 600),
        "api_key": MASK if ow.get("api_key") else "",
        "has_key": bool(ow.get("api_key")),
    }
    return jsonify(safe)


@app.route("/api/config", methods=["POST"])
def api_set_config():
    cfg = load_config()
    data = request.get_json(force=True, silent=True) or {}

    # credenziali: sovrascrivi solo se arriva un valore nuovo e non mascherato
    creds = data.get("credentials", {})
    if "token" in creds and creds["token"] and "…" not in creds["token"] and creds["token"] != MASK:
        cfg["credentials"]["token"] = creds["token"].strip()
    if "secret" in creds and creds["secret"] and creds["secret"] != MASK:
        cfg["credentials"]["secret"] = creds["secret"].strip()

    for key in ("poll_interval", "min_store_gap", "history_max_points",
                "temperature_unit", "theme", "background_poll"):
        if key in data:
            cfg[key] = data[key]

    if "widgets" in data and isinstance(data["widgets"], dict):
        cfg["widgets"].update(data["widgets"])

    if "devices" in data and isinstance(data["devices"], list):
        # preserva enabled/order arrivati dal client
        cfg["devices"] = data["devices"]

    # meteo esterno OpenWeatherMap
    ow = data.get("openweather")
    if isinstance(ow, dict):
        cfg.setdefault("openweather", {})
        if "api_key" in ow and ow["api_key"] and ow["api_key"] != MASK:
            cfg["openweather"]["api_key"] = ow["api_key"].strip()
        for k in ("enabled", "city", "poll_interval", "min_gap"):
            if k in ow:
                cfg["openweather"][k] = (ow[k].strip() if isinstance(ow[k], str) else ow[k])

    save_config(cfg)
    return jsonify({"ok": True})


@app.route("/api/scan", methods=["POST"])
def api_scan():
    cfg = load_config()
    try:
        body = sb_get("/v1.1/devices", cfg)
    except RuntimeError as e:
        if str(e) == "credentials-missing":
            return jsonify({"ok": False, "error": "credentials-missing"}), 400
        return jsonify({"ok": False, "error": str(e)}), 502
    except requests.RequestException as e:
        return jsonify({"ok": False, "error": f"network:{e}"}), 502

    found = []
    for d in body.get("deviceList", []):
        if d.get("deviceType") in METER_TYPES:
            found.append({
                "deviceId": d["deviceId"],
                "deviceName": d.get("deviceName", d["deviceId"]),
                "deviceType": d.get("deviceType", ""),
            })

    # unisci con la config esistente: mantieni enabled/order dei già noti
    existing = {d["deviceId"]: d for d in cfg.get("devices", [])}
    merged = []
    for i, dev in enumerate(found):
        prev = existing.get(dev["deviceId"], {})
        merged.append({
            **dev,
            "enabled": prev.get("enabled", True),
            "order": prev.get("order", i),
        })
    merged.sort(key=lambda x: x["order"])
    cfg["devices"] = merged
    save_config(cfg)

    return jsonify({"ok": True, "devices": merged, "count": len(merged)})


@app.route("/api/status", methods=["GET"])
def api_status():
    """Lettura live: interroga i sensori adesso e salva a storico."""
    cfg = load_config()
    if not cfg["credentials"]["token"] or not cfg["credentials"]["secret"]:
        return jsonify({"ok": False, "error": "credentials-missing", "readings": {}}), 200
    if not cfg.get("devices"):
        return jsonify({"ok": False, "error": "no-devices", "readings": {}}), 200
    result = poll_and_store(cfg)
    return jsonify(result)


@app.route("/api/history", methods=["GET"])
def api_history():
    hours = float(request.args.get("hours", 24))
    since = int(time.time()) - int(hours * 3600)
    hist = load_history()
    out = {}
    for did, series in hist.items():
        out[did] = [p for p in series if p["t"] >= since]
    return jsonify({"ok": True, "history": out, "since": since})


@app.route("/api/history", methods=["DELETE"])
def api_clear_history():
    save_history({})
    return jsonify({"ok": True})


@app.route("/api/test", methods=["POST"])
def api_test():
    """Verifica rapida delle credenziali senza salvare nulla a storico."""
    cfg = load_config()
    data = request.get_json(force=True, silent=True) or {}
    creds = data.get("credentials", {})
    # usa credenziali di prova se fornite, altrimenti quelle salvate
    test_cfg = json.loads(json.dumps(cfg))
    if creds.get("token") and "…" not in creds["token"] and creds["token"] != MASK:
        test_cfg["credentials"]["token"] = creds["token"].strip()
    if creds.get("secret") and creds["secret"] != MASK:
        test_cfg["credentials"]["secret"] = creds["secret"].strip()
    try:
        body = sb_get("/v1.1/devices", test_cfg)
        n = len(body.get("deviceList", []))
        return jsonify({"ok": True, "devices_total": n})
    except Exception as e:  # noqa: BLE001
        return jsonify({"ok": False, "error": str(e)}), 200


@app.route("/api/weather", methods=["GET"])
def api_weather():
    """Meteo esterno. Non va mai in errore HTTP: comunica lo stato nel JSON."""
    cfg = load_config()
    if not cfg.get("openweather", {}).get("enabled"):
        return jsonify({"ok": False, "error": "disabled"})
    res = fetch_weather(cfg, force=(request.args.get("force") == "1"))
    return jsonify(res)


@app.route("/api/weather/test", methods=["POST"])
def api_weather_test():
    """Verifica API key e città senza attivare il widget."""
    cfg = load_config()
    data = request.get_json(force=True, silent=True) or {}
    ow = data.get("openweather", {}) or {}
    override = {}
    if ow.get("api_key") and ow["api_key"] != MASK:
        override["api_key"] = ow["api_key"].strip()
    if ow.get("city"):
        override["city"] = ow["city"].strip()
    res = fetch_weather(cfg, force=True, override=override)
    return jsonify(res)


@app.route("/api/weather/daily", methods=["GET"])
def api_weather_daily():
    """Storico giornaliero del meteo esterno (min/max) + estremi dell'anno."""
    daily = load_daily()
    days = sorted(daily.values(), key=lambda r: r["date"])
    return jsonify({"ok": True, "days": days, "extremes": compute_extremes(daily)})


# --------------------------------------------------------------------------- #
#  Avvio
# --------------------------------------------------------------------------- #
if __name__ == "__main__":
    load_config()          # crea config.json se non esiste
    load_weather_cache()   # ripristina l'ultimo meteo noto
    start_background()     # avvia il polling continuo
    port = int(os.environ.get("PORT", 5001))
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
