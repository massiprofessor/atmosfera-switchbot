/* ========================================================================
   ATMOSFERA — logica dashboard
   ======================================================================== */
'use strict';

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const WIDGET_LABELS = {
  temperature: 'Temperatura',
  humidity:    'Umidità',
  feelslike:   'Temperatura percepita',
  dewpoint:    'Punto di rugiada',
  abshumidity: 'Umidità assoluta',
  comfort:     'Indice di comfort',
  co2:         'CO₂ (se disponibile)',
  battery:     'Batteria',
  sparkline:   'Mini-grafico (sparkline)',
};

const state = {
  config: null,
  readings: {},
  history: {},
  rangeHours: 24,
  timer: null,
  reduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
};

/* ------------------------------------------------------------------ */
/*  Conversioni & formattazione                                       */
/* ------------------------------------------------------------------ */
function unit() { return state.config?.temperature_unit || 'C'; }
function toDisplayTemp(c) {
  if (c === null || c === undefined) return null;
  return unit() === 'F' ? c * 9 / 5 + 32 : c;
}
function tSym() { return unit() === 'F' ? '°F' : '°C'; }
function fmt(v, d = 1) { return v === null || v === undefined ? '—' : Number(v).toFixed(d); }

/* ------------------------------------------------------------------ */
/*  Palette dinamica in base alla temperatura                         */
/* ------------------------------------------------------------------ */
const TEMP_STOPS = [
  [-10, [59, 130, 246]],   // blu glaciale
  [ 5,  [56, 189, 248]],   // celeste
  [ 14, [34, 211, 238]],   // ciano
  [ 19, [45, 212, 191]],   // teal
  [ 22, [52, 211, 153]],   // verde-menta (comfort)
  [ 26, [251, 191, 36]],   // ambra
  [ 30, [251, 146, 60]],   // arancio
  [ 36, [248, 113, 113]],  // corallo
];
function lerp(a, b, t) { return a + (b - a) * t; }
function tempColor(c) {
  if (c === null || c === undefined) c = 21;
  c = clamp(c, TEMP_STOPS[0][0], TEMP_STOPS[TEMP_STOPS.length - 1][0]);
  let lo = TEMP_STOPS[0], hi = TEMP_STOPS[TEMP_STOPS.length - 1];
  for (let i = 0; i < TEMP_STOPS.length - 1; i++) {
    if (c >= TEMP_STOPS[i][0] && c <= TEMP_STOPS[i + 1][0]) { lo = TEMP_STOPS[i]; hi = TEMP_STOPS[i + 1]; break; }
  }
  const t = (c - lo[0]) / (hi[0] - lo[0] || 1);
  const rgb = [0, 1, 2].map(i => Math.round(lerp(lo[1][i], hi[1][i], t)));
  const lighter = rgb.map(v => Math.round(lerp(v, 255, 0.28)));
  return {
    accent:  `rgb(${rgb.join(',')})`,
    accent2: `rgb(${lighter.join(',')})`,
    glow:    `rgba(${rgb.join(',')}, 0.35)`,
    rgb,
  };
}

function applyAtmosphere(avgTemp) {
  const theme = state.config?.theme || 'auto';
  let col;
  if (theme === 'midnight')  col = tempColor(-4);
  else if (theme === 'dark') col = { accent: '#8B93A7', accent2: '#B8C0D4', glow: 'rgba(139,147,167,0.25)' };
  else                        col = tempColor(avgTemp);
  const root = document.documentElement.style;
  root.setProperty('--accent', col.accent);
  root.setProperty('--accent-2', col.accent2);
  root.setProperty('--glow', col.glow);
  if (particles) particles.tint = col.rgb || [140, 150, 170];
}

/* ------------------------------------------------------------------ */
/*  Orologio                                                          */
/* ------------------------------------------------------------------ */
function tickClock() {
  const now = new Date();
  $('#clockTime').textContent = now.toLocaleTimeString('it-IT');
  $('#clockDate').textContent = now.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
}
setInterval(tickClock, 1000); tickClock();

/* ------------------------------------------------------------------ */
/*  Particelle di sfondo                                              */
/* ------------------------------------------------------------------ */
let particles = null;
function initParticles() {
  const canvas = $('#particles');
  const ctx = canvas.getContext('2d');
  let W, H, dots = [];
  const N = state.reduced ? 0 : 46;
  function resize() {
    W = canvas.width = window.innerWidth;
    H = canvas.height = window.innerHeight;
    dots = Array.from({ length: N }, () => ({
      x: Math.random() * W, y: Math.random() * H,
      r: Math.random() * 1.8 + 0.4,
      vx: (Math.random() - 0.5) * 0.18,
      vy: (Math.random() - 0.5) * 0.18 - 0.05,
      a: Math.random() * 0.4 + 0.1,
    }));
  }
  window.addEventListener('resize', resize); resize();
  particles = { tint: [140, 150, 170] };
  function frame() {
    ctx.clearRect(0, 0, W, H);
    const [r, g, b] = particles.tint;
    for (const d of dots) {
      d.x += d.vx; d.y += d.vy;
      if (d.x < 0) d.x = W; if (d.x > W) d.x = 0;
      if (d.y < 0) d.y = H; if (d.y > H) d.y = 0;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${r},${g},${b},${d.a})`;
      ctx.fill();
    }
    requestAnimationFrame(frame);
  }
  if (!state.reduced) frame();
}

/* ------------------------------------------------------------------ */
/*  Rendering dei sensori                                             */
/* ------------------------------------------------------------------ */
const GAUGE_R = 52;
const GAUGE_C = 2 * Math.PI * GAUGE_R;

function comfortClass(level) {
  return ({
    freddo: 'c-freddo', fresco: 'c-fresco', comfort: 'c-comfort',
    secco: 'c-secco', umido: 'c-umido', caldo: 'c-caldo', afoso: 'c-afoso',
  })[level] || 'c-neutro';
}

function sparklineSvg(series) {
  if (!series || series.length < 2) return '';
  const vals = series.map(p => p.temperature).filter(v => v !== null && v !== undefined);
  if (vals.length < 2) return '';
  const min = Math.min(...vals), max = Math.max(...vals), span = (max - min) || 1;
  const w = 300, h = 40;
  const step = w / (vals.length - 1);
  const pts = vals.map((v, i) => `${(i * step).toFixed(1)},${(h - ((v - min) / span) * h).toFixed(1)}`);
  const line = pts.join(' ');
  const area = `M0,${h} L${line.split(' ').join(' L')} L${w},${h} Z`;
  return `
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <defs>
        <linearGradient id="spk" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.35"/>
          <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path d="${area}" fill="url(#spk)"/>
      <polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
}

function cardHtml(dev, r) {
  const w = state.config.widgets;
  const tC = r.temperature;
  const tDisp = toDisplayTemp(tC);
  const feelsDisp = toDisplayTemp(r.feelslike);
  const dewDisp = toDisplayTemp(r.dewpoint);
  const rh = r.humidity;

  // frazione gauge: -10..45 °C
  const frac = clamp((tC - (-10)) / (45 - (-10)), 0, 1);
  const dash = GAUGE_C * (1 - frac);

  const battLow = (r.battery ?? 100) <= 20;
  const cm = r.comfort || { label: '—', level: 'neutro' };

  const metrics = [];
  if (w.feelslike)
    metrics.push(`<div class="metric"><div class="k">Percepita</div><div class="v">${fmt(feelsDisp)}<small>${tSym()}</small></div></div>`);
  if (w.dewpoint)
    metrics.push(`<div class="metric"><div class="k">Rugiada</div><div class="v">${fmt(dewDisp)}<small>${tSym()}</small></div></div>`);
  if (w.abshumidity)
    metrics.push(`<div class="metric"><div class="k">Umid. ass.</div><div class="v">${fmt(r.abshumidity)}<small>g/m³</small></div></div>`);
  if (w.co2 && r.co2 !== undefined)
    metrics.push(`<div class="metric"><div class="k">CO₂</div><div class="v">${fmt(r.co2, 0)}<small>ppm</small></div></div>`);
  if (w.comfort)
    metrics.push(`<div class="metric wide"><div class="k">Comfort</div><span class="comfort-pill ${comfortClass(cm.level)}">${cm.label}</span></div>`);
  if (w.battery)
    metrics.push(`<div class="metric"><div class="k">Batteria</div><div class="v"><span class="batt ${battLow ? 'low' : ''}"><span class="cell"><span class="lvl" style="width:${clamp(r.battery ?? 0,0,100)}%"></span></span> <small>${r.battery ?? '—'}%</small></span></div></div>`);

  const spark = w.sparkline ? sparklineSvg(state.history[dev.deviceId]) : '';

  return `
  <article class="card" data-id="${dev.deviceId}" draggable="true" style="--card-glow:${tempColor(tC).glow}">
    <div class="card-head">
      <div class="name">
        ${escapeHtml(dev.deviceName)}
        <span class="badge">${escapeHtml(dev.deviceType)}</span>
      </div>
      <span class="drag" title="Trascina per riordinare">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>
      </span>
    </div>
    <div class="card-body">
      ${w.temperature ? `
      <div class="gauge">
        <svg viewBox="0 0 120 120">
          <circle class="track" cx="60" cy="60" r="${GAUGE_R}"/>
          <circle class="fill" cx="60" cy="60" r="${GAUGE_R}"
            stroke-dasharray="${GAUGE_C.toFixed(1)}" stroke-dashoffset="${dash.toFixed(1)}"/>
        </svg>
        <div class="readout">
          <div class="t">${fmt(tDisp)}<sup>${tSym()}</sup></div>
          <div class="feels">${cm.label}</div>
        </div>
      </div>` : '<div></div>'}

      ${w.humidity ? `
      <div class="humidity">
        <div class="drop" style="--level:${clamp(rh ?? 0, 0, 100)}%">
          <div class="liquid"></div>
          <div class="rh-val">${rh ?? '—'}%</div>
        </div>
        <span class="cap">Umidità</span>
      </div>` : '<div></div>'}
    </div>

    ${metrics.length ? `<div class="metrics">${metrics.join('')}</div>` : ''}
    ${spark ? `<div class="sparkline"><div class="cap">Ultime letture · temperatura</div>${spark}</div>` : ''}
  </article>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function orderedDevices() {
  return (state.config.devices || [])
    .filter(d => d.enabled !== false)
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

function renderCards() {
  const grid = $('#grid');
  const devs = orderedDevices();
  grid.innerHTML = devs.map(d => {
    const r = state.readings[d.deviceId];
    return r ? cardHtml(d, r) : '';
  }).join('');
  enableDragReorder();
}

function renderSummary() {
  const devs = orderedDevices();
  const temps = [], hums = [], batts = [];
  for (const d of devs) {
    const r = state.readings[d.deviceId];
    if (!r) continue;
    if (r.temperature != null) temps.push(r.temperature);
    if (r.humidity != null) hums.push(r.humidity);
    if (r.battery != null) batts.push(r.battery);
  }
  if (!temps.length) { $('#summary').classList.add('hidden'); return; }
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  const min = a => Math.min(...a), max = a => Math.max(...a);
  const stats = [
    ['Media temp', `${fmt(toDisplayTemp(avg(temps)))}<small>${tSym()}</small>`],
    ['Escursione', `${fmt(toDisplayTemp(min(temps)))}–${fmt(toDisplayTemp(max(temps)))}<small>${tSym()}</small>`],
    ['Media umidità', `${fmt(avg(hums), 0)}<small>%</small>`],
    ['Sensori attivi', `${temps.length}<small>/${devs.length}</small>`],
    ...(batts.length ? [['Batteria min', `${fmt(min(batts), 0)}<small>%</small>`]] : []),
  ];
  $('#summary').innerHTML = stats.map(([l, v]) => `<div class="stat"><div class="lbl">${l}</div><div class="val">${v}</div></div>`).join('');
  $('#summary').classList.remove('hidden');
  applyAtmosphere(avg(temps));
}

/* ------------------------------------------------------------------ */
/*  Drag & drop per riordinare le card                                */
/* ------------------------------------------------------------------ */
function enableDragReorder() {
  let dragged = null;
  $$('.card').forEach(card => {
    card.addEventListener('dragstart', () => { dragged = card; card.classList.add('dragging'); });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      $$('.card').forEach(c => c.classList.remove('drag-over'));
      persistOrder();
    });
    card.addEventListener('dragover', e => {
      e.preventDefault();
      const after = getDragAfter($('#grid'), e.clientY, e.clientX);
      $$('.card').forEach(c => c.classList.remove('drag-over'));
      if (!dragged) return;
      if (after == null) $('#grid').appendChild(dragged);
      else $('#grid').insertBefore(dragged, after);
    });
  });
}
function getDragAfter(container, y, x) {
  const els = [...container.querySelectorAll('.card:not(.dragging)')];
  return els.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = (y - box.top - box.height / 2) + (x - box.left - box.width / 2) * 0.01;
    if (offset < 0 && offset > closest.offset) return { offset, element: child };
    return closest;
  }, { offset: -Infinity }).element || null;
}
function persistOrder() {
  const ids = $$('.card').map(c => c.dataset.id);
  state.config.devices.forEach(d => {
    const idx = ids.indexOf(d.deviceId);
    if (idx !== -1) d.order = idx;
  });
  saveConfig(true);
}

/* ------------------------------------------------------------------ */
/*  Grafici storico (Chart.js)                                        */
/* ------------------------------------------------------------------ */
let tempChart, humChart;
const PALETTE = ['#34D399', '#38BDF8', '#FBBF24', '#F87171', '#A78BFA', '#22D3EE', '#FB923C', '#4ADE80'];

function buildDatasets(field, convert) {
  const devs = orderedDevices();
  return devs.map((d, i) => {
    const series = (state.history[d.deviceId] || []);
    const color = PALETTE[i % PALETTE.length];
    return {
      label: d.deviceName,
      data: series.map(p => ({ x: p.t * 1000, y: convert ? convert(p[field]) : p[field] })),
      borderColor: color,
      backgroundColor: color + '22',
      borderWidth: 2, tension: 0.35, pointRadius: 0, pointHoverRadius: 4, fill: false,
      spanGaps: true,
    };
  });
}

function chartOpts(suffix) {
  return {
    responsive: true, maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { labels: { color: '#9AA4BE', font: { family: 'JetBrains Mono', size: 11 }, boxWidth: 10, boxHeight: 10, usePointStyle: true } },
      tooltip: {
        backgroundColor: '#0C0F17', borderColor: 'rgba(255,255,255,0.12)', borderWidth: 1,
        titleColor: '#EDF1FA', bodyColor: '#9AA4BE', padding: 12, cornerRadius: 10,
        callbacks: { label: c => ` ${c.dataset.label}: ${c.parsed.y?.toFixed(1)}${suffix}` },
      },
    },
    scales: {
      x: { type: 'time', time: { tooltipFormat: 'dd/MM HH:mm', displayFormats: { hour: 'HH:mm', day: 'dd/MM' } },
           grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#5C6580', font: { family: 'JetBrains Mono', size: 10 }, maxRotation: 0 } },
      y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#5C6580', font: { family: 'JetBrains Mono', size: 10 }, callback: v => v + suffix } },
    },
  };
}

function renderCharts() {
  if (typeof Chart === 'undefined') return;
  const tData = { datasets: buildDatasets('temperature', toDisplayTemp) };
  const hData = { datasets: buildDatasets('humidity', null) };
  if (tempChart) { tempChart.data = tData; tempChart.update('none'); }
  else tempChart = new Chart($('#tempChart'), { type: 'line', data: tData, options: chartOpts(tSym()) });
  if (humChart) { humChart.data = hData; humChart.update('none'); }
  else humChart = new Chart($('#humChart'), { type: 'line', data: hData, options: chartOpts('%') });
}

/* ------------------------------------------------------------------ */
/*  Chiamate al backend                                               */
/* ------------------------------------------------------------------ */
async function api(path, opts) {
  const r = await fetch(path, opts);
  return r.json();
}

async function loadConfig() {
  state.config = await api('/api/config');
}

async function pollStatus(manual) {
  const btn = $('#refreshBtn');
  if (manual) btn.classList.add('spin');
  try {
    const res = await api('/api/status');
    if (res.error === 'credentials-missing' || res.error === 'no-devices') {
      showEmpty(); setLive(false); return;
    }
    state.readings = res.readings || {};
    hideEmpty();
    renderSummary();
    renderCards();
    setLive(true, res.t);
    if (res.errors && Object.keys(res.errors).length) {
      toast(`Alcuni sensori non hanno risposto`, 'err');
    }
  } catch (e) {
    setLive(false);
    toast('Errore di rete durante la lettura', 'err');
  } finally {
    if (manual) setTimeout(() => btn.classList.remove('spin'), 600);
  }
}

async function fetchHistory() {
  try {
    const res = await api(`/api/history?hours=${state.rangeHours}`);
    state.history = res.history || {};
    renderCharts();
    renderCards(); // aggiorna sparkline
  } catch (e) { /* silenzioso */ }
}

async function saveConfig(silent) {
  const payload = {
    poll_interval: state.config.poll_interval,
    min_store_gap: state.config.min_store_gap,
    temperature_unit: state.config.temperature_unit,
    theme: state.config.theme,
    background_poll: state.config.background_poll,
    widgets: state.config.widgets,
    devices: state.config.devices,
  };
  await api('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!silent) toast('Impostazioni salvate', 'ok');
}

/* ------------------------------------------------------------------ */
/*  Stato UI                                                          */
/* ------------------------------------------------------------------ */
function setLive(online, t) {
  const b = $('#liveBadge');
  if (online) {
    b.classList.remove('offline');
    const time = t ? new Date(t * 1000).toLocaleTimeString('it-IT') : '';
    $('#liveText').textContent = time ? `live · ${time}` : 'live';
  } else {
    b.classList.add('offline');
    $('#liveText').textContent = 'in attesa';
  }
}
function showEmpty() {
  $('#empty').classList.remove('hidden');
  $('#grid').classList.add('hidden');
  $('#summary').classList.add('hidden');
  $('#historySec').classList.add('hidden');
}
function hideEmpty() {
  $('#empty').classList.add('hidden');
  $('#grid').classList.remove('hidden');
  $('#historySec').classList.remove('hidden');
}

let toastTimer;
function toast(msg, kind = 'ok') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.className = 'toast', 2800);
}

/* ------------------------------------------------------------------ */
/*  Drawer impostazioni                                               */
/* ------------------------------------------------------------------ */
function openDrawer() {
  fillDrawer();
  $('#drawer').classList.add('open');
  $('#scrim').classList.add('open');
  $('#drawer').setAttribute('aria-hidden', 'false');
}
function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#scrim').classList.remove('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
}

function fillDrawer() {
  const c = state.config;
  $('#fToken').value = c.credentials?.token || '';
  $('#fToken').placeholder = c.credentials?.has_token ? 'token salvato — lascia invariato' : 'incolla qui il token';
  $('#fSecret').value = '';
  $('#fSecret').placeholder = c.credentials?.has_secret ? '•••••••• salvato — lascia invariato' : 'incolla qui il secret';
  $('#fInterval').value = c.poll_interval;
  $('#fBgPoll').checked = !!c.background_poll;
  $('#fUnit').value = c.temperature_unit;
  $('#fTheme').value = c.theme;
  $('#testResult').className = 'test-result';

  // toggle widget
  $('#widgetToggles').innerHTML = Object.keys(WIDGET_LABELS).map(k => `
    <div class="toggle-row">
      <span class="tl">${WIDGET_LABELS[k]}</span>
      <label class="switch"><input type="checkbox" data-w="${k}" ${c.widgets[k] ? 'checked' : ''}><span class="slider"></span></label>
    </div>`).join('');

  renderDevList();
}

function renderDevList() {
  const devs = state.config.devices || [];
  const list = $('#devList');
  if (!devs.length) { list.innerHTML = '<p class="hint">Nessun sensore ancora. Avvia una scansione.</p>'; return; }
  list.innerHTML = devs.map(d => `
    <div class="dev-item">
      <div class="di">
        <div class="n">${escapeHtml(d.deviceName)}</div>
        <div class="m">${escapeHtml(d.deviceType)} · ${escapeHtml(d.deviceId)}</div>
      </div>
      <label class="switch"><input type="checkbox" data-dev="${d.deviceId}" ${d.enabled !== false ? 'checked' : ''}><span class="slider"></span></label>
    </div>`).join('');
}

function readDrawerIntoConfig() {
  const c = state.config;
  const tok = $('#fToken').value.trim();
  const sec = $('#fSecret').value.trim();
  c.credentials = c.credentials || {};
  // invieremo token/secret solo se cambiati (gestito nel payload sotto)
  c._newToken = (tok && !tok.includes('…')) ? tok : null;
  c._newSecret = sec || null;
  c.poll_interval = clamp(parseInt($('#fInterval').value) || 120, 30, 86400);
  c.background_poll = $('#fBgPoll').checked;
  c.temperature_unit = $('#fUnit').value;
  c.theme = $('#fTheme').value;
  $$('#widgetToggles input[data-w]').forEach(i => c.widgets[i.dataset.w] = i.checked);
  $$('#devList input[data-dev]').forEach(i => {
    const d = c.devices.find(x => x.deviceId === i.dataset.dev);
    if (d) d.enabled = i.checked;
  });
}

async function saveFromDrawer() {
  readDrawerIntoConfig();
  const c = state.config;
  const payload = {
    credentials: {},
    poll_interval: c.poll_interval,
    background_poll: c.background_poll,
    temperature_unit: c.temperature_unit,
    theme: c.theme,
    widgets: c.widgets,
    devices: c.devices,
  };
  if (c._newToken) payload.credentials.token = c._newToken;
  if (c._newSecret) payload.credentials.secret = c._newSecret;
  await api('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  await loadConfig();
  toast('Impostazioni salvate', 'ok');
  closeDrawer();
  restartPolling();
  await pollStatus();
  await fetchHistory();
}

async function doScan() {
  readDrawerIntoConfig();
  // se ha inserito nuove credenziali, salvale prima di scansionare
  const c = state.config;
  if (c._newToken || c._newSecret) {
    const creds = {};
    if (c._newToken) creds.token = c._newToken;
    if (c._newSecret) creds.secret = c._newSecret;
    await api('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credentials: creds }) });
  }
  const btn = $('#scanBtn');
  btn.disabled = true; btn.textContent = 'Scansione in corso…';
  try {
    const res = await api('/api/scan', { method: 'POST' });
    if (!res.ok) {
      toast(res.error === 'credentials-missing' ? 'Inserisci prima token e secret' : 'Scansione fallita: ' + res.error, 'err');
    } else {
      await loadConfig();
      renderDevList();
      toast(`Trovati ${res.count} sensori`, 'ok');
      hideEmpty();
      await pollStatus();
      await fetchHistory();
    }
  } catch (e) {
    toast('Errore di rete durante la scansione', 'err');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg> Scansiona i dispositivi';
  }
}

async function doTest() {
  const tok = $('#fToken').value.trim();
  const sec = $('#fSecret').value.trim();
  const creds = {};
  if (tok && !tok.includes('…')) creds.token = tok;
  if (sec) creds.secret = sec;
  const el = $('#testResult');
  el.className = 'test-result'; el.textContent = '';
  const btn = $('#testBtn');
  btn.disabled = true; btn.textContent = 'Verifica…';
  try {
    const res = await api('/api/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credentials: creds }) });
    if (res.ok) { el.className = 'test-result ok'; el.textContent = `✓ Credenziali valide — ${res.devices_total} dispositivi sull'account.`; }
    else { el.className = 'test-result err'; el.textContent = `✗ ${res.error}`; }
  } catch (e) {
    el.className = 'test-result err'; el.textContent = '✗ Errore di rete.';
  } finally {
    btn.disabled = false; btn.textContent = 'Verifica credenziali';
  }
}

/* ------------------------------------------------------------------ */
/*  Polling loop                                                      */
/* ------------------------------------------------------------------ */
function restartPolling() {
  if (state.timer) clearInterval(state.timer);
  const ms = clamp((state.config.poll_interval || 120), 30, 86400) * 1000;
  state.timer = setInterval(() => { pollStatus(); fetchHistory(); }, ms);
}

/* ------------------------------------------------------------------ */
/*  Eventi                                                            */
/* ------------------------------------------------------------------ */
function wireEvents() {
  $('#settingsBtn').addEventListener('click', openDrawer);
  $('#emptyCta').addEventListener('click', openDrawer);
  $('#closeDrawer').addEventListener('click', closeDrawer);
  $('#cancelBtn').addEventListener('click', closeDrawer);
  $('#scrim').addEventListener('click', closeDrawer);
  $('#saveBtn').addEventListener('click', saveFromDrawer);
  $('#scanBtn').addEventListener('click', doScan);
  $('#testBtn').addEventListener('click', doTest);
  $('#refreshBtn').addEventListener('click', () => { pollStatus(true); fetchHistory(); });
  $('#clearHistBtn').addEventListener('click', async () => {
    await api('/api/history', { method: 'DELETE' });
    state.history = {}; renderCharts(); renderCards();
    toast('Storico cancellato', 'ok');
  });
  $('#rangeTabs').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    $$('#rangeTabs button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    state.rangeHours = parseFloat(b.dataset.h);
    fetchHistory();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });
  // ricattura quando la scheda torna in primo piano
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { pollStatus(); fetchHistory(); } });
}

/* ------------------------------------------------------------------ */
/*  Avvio                                                             */
/* ------------------------------------------------------------------ */
async function init() {
  initParticles();
  wireEvents();
  await loadConfig();
  applyAtmosphere(21);

  const hasCreds = state.config.credentials?.has_token && state.config.credentials?.has_secret;
  const hasDevs = (state.config.devices || []).length > 0;

  if (!hasCreds || !hasDevs) {
    showEmpty();
    setLive(false);
  } else {
    hideEmpty();
    await pollStatus();     // cattura immediata all'apertura della pagina
    await fetchHistory();
    restartPolling();
  }
}

document.addEventListener('DOMContentLoaded', init);
