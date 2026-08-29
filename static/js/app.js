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
  weatherTimer: null,
  weatherData: null,
  wxDaily: [],
  wxExtremes: null,
  wxRangeDays: 30,
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
  // I sensori esterni WoIOSensor riportano un valore batteria fittizio (sempre 60): lo omettiamo.
  const hasBattery = dev.deviceType !== 'WoIOSensor';
  if (w.battery && hasBattery)
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
    // esclusi i WoIOSensor: riportano una batteria fittizia (sempre 60)
    if (r.battery != null && d.deviceType !== 'WoIOSensor') batts.push(r.battery);
  }
  if (!temps.length) { $('#summary').classList.add('hidden'); return; }
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  const min = a => Math.min(...a), max = a => Math.max(...a);
  const avgIndoor = avg(temps);

  // Δ interno/esterno: temperatura esterna (meteo) meno media interni
  let deltaStat = [];
  const out = state.weatherData?.temperature;
  if (out != null) {
    const d = toDisplayTemp(out) - toDisplayTemp(avgIndoor);
    const sign = d >= 0 ? '+' : '−';
    deltaStat = [['Δ est/int', `${sign}${fmt(Math.abs(d))}<small>${tSym()}</small>`]];
  }

  const stats = [
    ['Media temp', `${fmt(toDisplayTemp(avgIndoor))}<small>${tSym()}</small>`],
    ['Escursione', `${fmt(toDisplayTemp(min(temps)))}–${fmt(toDisplayTemp(max(temps)))}<small>${tSym()}</small>`],
    ['Media umidità', `${fmt(avg(hums), 0)}<small>%</small>`],
    ...deltaStat,
    ['Sensori attivi', `${temps.length}<small>/${devs.length}</small>`],
    ...(batts.length ? [['Batteria min', `${fmt(min(batts), 0)}<small>%</small>`]] : []),
  ];
  $('#summary').innerHTML = stats.map(([l, v]) => `<div class="stat"><div class="lbl">${l}</div><div class="val">${v}</div></div>`).join('');
  $('#summary').classList.remove('hidden');
  applyAtmosphere(avgIndoor);
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
/*  Meteo esterno (OpenWeatherMap) — widget con scene animate          */
/* ------------------------------------------------------------------ */
const WIND_DIRS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSO','SO','OSO','O','ONO','NO','NNO'];
function windCardinal(deg) {
  if (deg === null || deg === undefined) return '—';
  return WIND_DIRS[Math.round(deg / 22.5) % 16];
}

// Rosa dei venti mediterranea a 16 punti (settori da 22,5°).
// Il nome indica la direzione DA CUI soffia il vento.
const WIND_NAMES = [
  'Tramontana',           // N     0°
  'Greco-Tramontana',     // NNE  22,5°
  'Grecale',              // NE    45°
  'Greco-Levante',        // ENE  67,5°
  'Levante',              // E     90°
  'Scirocco-Levante',     // ESE 112,5°
  'Scirocco',             // SE   135°
  'Ostro-Scirocco',       // SSE 157,5°
  'Ostro',                // S    180°
  'Ostro-Libeccio',       // SSO 202,5°
  'Libeccio',             // SO   225°
  'Libeccio-Ponente',     // OSO 247,5°
  'Ponente',              // O    270°
  'Maestrale-Ponente',    // ONO 292,5°
  'Maestrale',            // NO   315°
  'Maestrale-Tramontana', // NNO 337,5°
];
const WIND_FROM = [
  'Nord', 'Nord-Nord-Est', 'Nord-Est', 'Est-Nord-Est', 'Est', 'Est-Sud-Est',
  'Sud-Est', 'Sud-Sud-Est', 'Sud', 'Sud-Sud-Ovest', 'Sud-Ovest', 'Ovest-Sud-Ovest',
  'Ovest', 'Ovest-Nord-Ovest', 'Nord-Ovest', 'Nord-Nord-Ovest',
];
function windName(deg) {
  if (deg === null || deg === undefined) return null;
  return WIND_NAMES[Math.round(deg / 22.5) % 16];
}
function windOrigin(deg) {
  if (deg === null || deg === undefined) return '';
  return WIND_FROM[Math.round(deg / 22.5) % 16];
}

// Intensità del vento — scala di Beaufort in italiano (soglie in km/h).
function windForce(kmh) {
  if (kmh === null || kmh === undefined) return null;
  const scale = [
    [1, 'Calma'], [6, 'Bava di vento'], [12, 'Brezza leggera'], [20, 'Brezza tesa'],
    [29, 'Vento moderato'], [39, 'Vento teso'], [50, 'Vento fresco'], [62, 'Vento forte'],
    [75, 'Burrasca'], [89, 'Burrasca forte'], [103, 'Tempesta'], [118, 'Fortunale'],
  ];
  for (const [max, label] of scale) if (kmh < max) return label;
  return 'Uragano';
}

function wxSceneClass(id, icon) {
  const night = typeof icon === 'string' && icon.endsWith('n');
  if (id >= 200 && id < 300) return 'thunder';
  if ((id >= 300 && id < 400) || (id >= 500 && id < 600)) return 'rain';
  if (id >= 600 && id < 700) return 'snow';
  if (id >= 700 && id < 800) return 'mist';
  if (id === 800) return night ? 'clear-night' : 'clear-day';
  return night ? 'clouds-night' : 'clouds-day';   // 80x nuvole
}

// generatori di elementi animati
function wxClouds(n) {
  let s = '';
  for (let i = 0; i < n; i++) {
    const top = 8 + Math.random() * 70, dur = 34 + Math.random() * 40, delay = -Math.random() * dur;
    s += `<div class="wx-cloud" style="top:${top}px;animation-duration:${dur}s;animation-delay:${delay}s"></div>`;
  }
  return s;
}
function wxRain(n) {
  let s = '';
  for (let i = 0; i < n; i++) {
    const left = Math.random() * 100, dur = 0.5 + Math.random() * 0.45, delay = -Math.random() * dur;
    s += `<div class="wx-drop" style="left:${left}%;animation-duration:${dur}s;animation-delay:${delay}s"></div>`;
  }
  return s;
}
function wxSnow(n) {
  let s = '';
  for (let i = 0; i < n; i++) {
    const left = Math.random() * 100, dur = 3 + Math.random() * 3.5, delay = -Math.random() * dur;
    const sway = Math.round(Math.random() * 40 - 20), sz = 4 + Math.random() * 5;
    s += `<div class="wx-flake" style="left:${left}%;width:${sz}px;height:${sz}px;--sway:${sway}px;animation-duration:${dur}s;animation-delay:${delay}s"></div>`;
  }
  return s;
}
function wxStars(n) {
  let s = '';
  for (let i = 0; i < n; i++) {
    const top = Math.random() * 120, left = Math.random() * 100, delay = -Math.random() * 3;
    s += `<div class="wx-star" style="top:${top}px;left:${left}%;animation-delay:${delay}s"></div>`;
  }
  return s;
}
function wxBands(n) {
  let s = '';
  for (let i = 0; i < n; i++) {
    const top = 26 + i * 32, dur = 8 + Math.random() * 6, delay = -Math.random() * dur;
    s += `<div class="wx-band" style="top:${top}px;animation-duration:${dur}s;animation-delay:${delay}s"></div>`;
  }
  return s;
}
const WX_BOLT = '<svg class="wx-bolt" viewBox="0 0 24 40"><path d="M13 0 2 22h7l-2 18 13-24h-8z"/></svg>';

function wxAnimLayer(scene) {
  let h = '';
  if (scene === 'clear-day') h = '<div class="wx-sun"></div>';
  else if (scene === 'clear-night') h = '<div class="wx-moon"></div>' + wxStars(7);
  else if (scene === 'clouds-day') h = wxClouds(3);
  else if (scene === 'clouds-night') h = wxStars(5) + wxClouds(3);
  else if (scene === 'rain') h = wxClouds(2) + wxRain(30);
  else if (scene === 'snow') h = wxClouds(2) + wxSnow(24);
  else if (scene === 'thunder') h = wxClouds(2) + wxRain(16) + WX_BOLT + '<div class="wx-flash"></div>';
  else if (scene === 'mist') h = wxBands(5);
  return `<div class="wx-anim">${h}</div>`;
}

function weatherBannerHtml(res) {
  const last = res.data ? new Date(res.data.t * 1000).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : '';
  if (res.rate_limited) {
    return `<div class="wx-banner"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg><span>Limite di utilizzo API OpenWeatherMap superato — mostro gli ultimi dati disponibili${last ? ` (agg. ${last})` : ''}.</span></div>`;
  }
  if (res.stale) {
    return `<div class="wx-banner info"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 2"/></svg><span>Dati meteo non aggiornati${last ? ` (ultimo agg. ${last})` : ''}.</span></div>`;
  }
  return '';
}

function renderWeather(res) {
  const sec = $('#weatherSec');

  // stati che nascondono del tutto il widget
  if (!res || res.error === 'disabled' || res.error === 'not-configured') {
    sec.classList.add('hidden'); sec.innerHTML = ''; return;
  }

  // errori senza dati in cache: mostro un messaggio, senza andare in crash
  if (!res.ok && !res.data) {
    const msg = {
      'rate-limit': 'Limite di utilizzo delle API OpenWeatherMap superato. I dati torneranno appena il limite si azzera.',
      'invalid-key': 'API key non valida. Controlla la chiave nelle impostazioni.',
      'city-not-found': 'Città non trovata. Prova con il formato "Città,IT".',
      'network': 'Meteo non raggiungibile in questo momento.',
    }[res.error] || 'Meteo non disponibile al momento.';
    sec.classList.remove('hidden');
    sec.innerHTML = `<div class="wx-card"><div class="wx-grid"><div class="wx-msg"><div class="big">Meteo esterno</div><p>${msg}</p></div></div></div>`;
    return;
  }

  const d = res.data;
  state.weatherData = d;                     // per la Δ interno/esterno nel riepilogo
  if (Object.keys(state.readings).length) renderSummary();
  const scene = wxSceneClass(d.condition_id, d.icon);
  const temp = toDisplayTemp(d.temperature);
  const feels = toDisplayTemp(d.feels_like);
  const dew = toDisplayTemp(d.dewpoint);
  const windKmh = d.wind_speed != null ? Math.round(d.wind_speed * 3.6) : null;
  const arrowRot = (d.wind_deg ?? 0) + 180;   // punta verso dove soffia il vento
  const calm = windKmh != null && windKmh < 2;
  const wName = calm ? 'Calma' : windName(d.wind_deg);
  const wForce = windForce(windKmh);
  const place = [d.city, d.country].filter(Boolean).join(', ');

  sec.classList.remove('hidden');
  sec.innerHTML = `
    <div class="wx-card">
      <div class="wx-grid">
        ${weatherBannerHtml(res)}
        <div class="wx-scene ${scene}">
          ${wxAnimLayer(scene)}
          <div class="wx-place">Meteo esterno · ${escapeHtml(place)}</div>
          <div>
            <div class="wx-temp">${fmt(temp, 0)}<sup>${tSym()}</sup></div>
            <div class="wx-desc">${escapeHtml(d.description || '')}</div>
            <div class="wx-feels">percepiti ${fmt(feels, 0)}${tSym()}</div>
          </div>
        </div>
        <div class="wx-metrics">
          <div class="wx-tile">
            <div class="k">Pressione</div>
            <div class="v">${fmt(d.pressure, 0)}<small>hPa</small></div>
          </div>
          <div class="wx-tile">
            <div class="k">Umidità</div>
            <div class="v">${fmt(d.humidity, 0)}<small>%</small></div>
          </div>
          <div class="wx-tile">
            <div class="k">Punto di rugiada</div>
            <div class="v">${fmt(dew, 1)}<small>${tSym()}</small></div>
          </div>
          <div class="wx-tile wx-wind">
            <div class="k">Vento</div>
            <div class="wx-wind-face">
              <div class="wx-compass" title="${calm ? 'aria calma' : ('da ' + windOrigin(d.wind_deg) + ' (' + windCardinal(d.wind_deg) + ' · ' + Math.round(d.wind_deg ?? 0) + '°)')}">
                <span class="n">N</span><span class="wx-arrow ${calm ? 'off' : ''}" style="transform:rotate(${arrowRot}deg)"></span>
              </div>
              <div class="wx-wind-info">
                <div class="card-dir">${wName || '—'}</div>
                ${!calm && d.wind_deg != null ? `<div class="spd">da ${windOrigin(d.wind_deg)} · ${windCardinal(d.wind_deg)}</div>` : ''}
                <div class="spd">${windKmh != null ? windKmh + ' km/h' : '—'}${wForce ? ` · ${wForce}` : ''}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>`;
}

async function pollWeather() {
  if (!state.config?.openweather?.enabled) {
    $('#weatherSec').classList.add('hidden');
    $('#wxHistorySec').classList.add('hidden');
    return;
  }
  try {
    const res = await api('/api/weather');
    renderWeather(res);
  } catch (e) { /* silenzioso: il meteo non deve mai rompere la dashboard */ }
  fetchWeatherDaily();
}

async function fetchWeatherDaily() {
  if (!state.config?.openweather?.enabled) return;
  try {
    const res = await api('/api/weather/daily');
    state.wxDaily = res.days || [];
    state.wxExtremes = res.extremes || null;
    renderWeatherHistory();
  } catch (e) { /* silenzioso */ }
}

function fmtDay(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' });
}

function renderWeatherHistory() {
  const sec = $('#wxHistorySec');
  if (!state.config?.openweather?.enabled) { sec.classList.add('hidden'); return; }
  sec.classList.remove('hidden');

  const days = state.wxDaily || [];
  if (!days.length) {
    $('#wxStats').innerHTML = `<div class="wx-stat-card"><div class="lbl">In raccolta</div><div class="big">—</div><div class="sub">Lo storico si popolerà con le prossime letture del meteo.</div></div>`;
    if (wxDailyChart) { wxDailyChart.destroy(); wxDailyChart = null; }
    return;
  }
  renderWxStats();
  renderWxDailyChart();

  // limiti del selettore data
  const picker = $('#wxDayPicker');
  picker.min = days[0].date;
  picker.max = days[days.length - 1].date;
}

function renderWxStats() {
  const ext = state.wxExtremes;
  const days = state.wxDaily;
  const year = ext?.current_year || new Date().getFullYear();
  const today = days[days.length - 1];
  const cards = [];

  if (ext?.year?.hottest) {
    cards.push(`<div class="wx-stat-card hot">
      <div class="lbl">Giorno più caldo · ${year}</div>
      <div class="big">${fmt(toDisplayTemp(ext.year.hottest.value))}<small>${tSym()}</small></div>
      <div class="sub">${fmtDay(ext.year.hottest.date)}</div>
    </div>`);
  }
  if (ext?.year?.coldest) {
    cards.push(`<div class="wx-stat-card cold">
      <div class="lbl">Giorno più freddo · ${year}</div>
      <div class="big">${fmt(toDisplayTemp(ext.year.coldest.value))}<small>${tSym()}</small></div>
      <div class="sub">${fmtDay(ext.year.coldest.date)}</div>
    </div>`);
  }
  if (today) {
    cards.push(`<div class="wx-stat-card">
      <div class="lbl">Oggi</div>
      <div class="big">${fmt(toDisplayTemp(today.t_min))}° / ${fmt(toDisplayTemp(today.t_max))}<small>${tSym()}</small></div>
      <div class="sub">min / max · ${today.samples} letture</div>
    </div>`);
  }
  cards.push(`<div class="wx-stat-card">
    <div class="lbl">Copertura dati</div>
    <div class="big">${days.length}<small>gg</small></div>
    <div class="sub">dal ${fmtDay(days[0].date)}</div>
  </div>`);

  $('#wxStats').innerHTML = cards.join('');
}

let wxDailyChart;
function renderWxDailyChart() {
  if (typeof Chart === 'undefined') return;
  const cutoff = state.wxRangeDays >= 99999 ? 0 : (Date.now() - state.wxRangeDays * 86400000);
  const days = state.wxDaily.filter(d => new Date(d.date + 'T00:00:00').getTime() >= cutoff);

  const maxData = days.map(d => ({ x: new Date(d.date + 'T00:00:00').getTime(), y: toDisplayTemp(d.t_max) }));
  const minData = days.map(d => ({ x: new Date(d.date + 'T00:00:00').getTime(), y: toDisplayTemp(d.t_min) }));

  const data = {
    datasets: [
      { label: 'Massima', data: maxData, borderColor: '#FB7185', backgroundColor: 'rgba(251,113,133,0.12)',
        borderWidth: 2, tension: 0.3, pointRadius: 0, pointHoverRadius: 4, fill: '+1' },
      { label: 'Minima', data: minData, borderColor: '#60A5FA', backgroundColor: 'rgba(96,165,250,0.0)',
        borderWidth: 2, tension: 0.3, pointRadius: 0, pointHoverRadius: 4, fill: false },
    ],
  };
  const opts = {
    responsive: true, maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { labels: { color: '#9AA4BE', font: { family: 'JetBrains Mono', size: 11 }, boxWidth: 10, boxHeight: 10, usePointStyle: true } },
      tooltip: {
        backgroundColor: '#0C0F17', borderColor: 'rgba(255,255,255,0.12)', borderWidth: 1,
        titleColor: '#EDF1FA', bodyColor: '#9AA4BE', padding: 12, cornerRadius: 10,
        callbacks: { label: c => ` ${c.dataset.label}: ${c.parsed.y?.toFixed(1)}${tSym()}` },
      },
    },
    scales: {
      x: { type: 'time', time: { tooltipFormat: 'dd/MM/yyyy', unit: 'day', displayFormats: { day: 'dd/MM' } },
           grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#5C6580', font: { family: 'JetBrains Mono', size: 10 }, maxRotation: 0 } },
      y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#5C6580', font: { family: 'JetBrains Mono', size: 10 }, callback: v => v + tSym() } },
    },
  };
  if (wxDailyChart) { wxDailyChart.data = data; wxDailyChart.options = opts; wxDailyChart.update('none'); }
  else wxDailyChart = new Chart($('#wxDailyChart'), { type: 'line', data, options: opts });
}

function wxDayLookup(dateStr) {
  const rec = (state.wxDaily || []).find(d => d.date === dateStr);
  const el = $('#wxDayResult');
  if (!rec) { el.innerHTML = `<span class="muted">Nessun dato registrato per il ${fmtDay(dateStr)}.</span>`; return; }
  el.innerHTML = `
    <div class="wx-day-grid">
      <div><span class="dl">Data</span><span class="dv">${fmtDay(rec.date)}</span></div>
      <div><span class="dl">Temp. min</span><span class="dv">${fmt(toDisplayTemp(rec.t_min))}${tSym()}</span></div>
      <div><span class="dl">Temp. max</span><span class="dv">${fmt(toDisplayTemp(rec.t_max))}${tSym()}</span></div>
      <div><span class="dl">Umidità</span><span class="dv">${rec.h_min ?? '—'}–${rec.h_max ?? '—'}%</span></div>
      <div><span class="dl">Pressione</span><span class="dv">${rec.p_min ?? '—'}–${rec.p_max ?? '—'} hPa</span></div>
      <div><span class="dl">Letture</span><span class="dv">${rec.samples}</span></div>
    </div>`;
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

  // meteo OpenWeatherMap
  const ow = c.openweather || {};
  $('#fOwEnabled').checked = !!ow.enabled;
  $('#fOwKey').value = '';
  $('#fOwKey').placeholder = ow.has_key ? '•••••••• salvata — lascia invariata' : 'incolla qui la API key';
  $('#fOwCity').value = ow.city || '';
  $('#fOwInterval').value = ow.poll_interval || 600;
  $('#owTestResult').className = 'test-result';

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

  // meteo OpenWeatherMap
  c.openweather = c.openweather || {};
  const owKey = $('#fOwKey').value.trim();
  c._newOwKey = owKey || null;
  c.openweather.enabled = $('#fOwEnabled').checked;
  c.openweather.city = $('#fOwCity').value.trim();
  c.openweather.poll_interval = clamp(parseInt($('#fOwInterval').value) || 600, 120, 86400);
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
    openweather: {
      enabled: c.openweather.enabled,
      city: c.openweather.city,
      poll_interval: c.openweather.poll_interval,
    },
  };
  if (c._newToken) payload.credentials.token = c._newToken;
  if (c._newSecret) payload.credentials.secret = c._newSecret;
  if (c._newOwKey) payload.openweather.api_key = c._newOwKey;
  await api('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  await loadConfig();
  toast('Impostazioni salvate', 'ok');
  closeDrawer();
  restartPolling();
  await pollStatus();
  await fetchHistory();
  await pollWeather();
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

async function doTestWeather() {
  const key = $('#fOwKey').value.trim();
  const city = $('#fOwCity').value.trim();
  const ow = {};
  if (key) ow.api_key = key;
  if (city) ow.city = city;
  const el = $('#owTestResult');
  el.className = 'test-result'; el.textContent = '';
  const btn = $('#owTestBtn');
  btn.disabled = true; btn.textContent = 'Verifica…';
  try {
    const res = await api('/api/weather/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ openweather: ow }) });
    if (res.ok && res.data) {
      el.className = 'test-result ok';
      el.textContent = `✓ ${res.data.city}: ${Math.round(res.data.temperature)}°C, ${res.data.description}.`;
    } else {
      const msg = {
        'rate-limit': 'limite di utilizzo API superato (riprova più tardi)',
        'invalid-key': 'API key non valida',
        'city-not-found': 'città non trovata (usa "Città,IT")',
        'not-configured': 'inserisci API key e città',
        'network': 'errore di rete',
      }[res.error] || res.error;
      el.className = 'test-result err'; el.textContent = `✗ ${msg}`;
    }
  } catch (e) {
    el.className = 'test-result err'; el.textContent = '✗ Errore di rete.';
  } finally {
    btn.disabled = false; btn.textContent = 'Verifica meteo';
  }
}

/* ------------------------------------------------------------------ */
/*  Polling loop                                                      */
/* ------------------------------------------------------------------ */
function restartPolling() {
  if (state.timer) clearInterval(state.timer);
  const ms = clamp((state.config.poll_interval || 120), 30, 86400) * 1000;
  state.timer = setInterval(() => { pollStatus(); fetchHistory(); }, ms);

  if (state.weatherTimer) clearInterval(state.weatherTimer);
  if (state.config.openweather?.enabled) {
    // il backend ha una cache anti-spam, quindi possiamo interrogare con calma
    const wms = clamp((state.config.openweather.poll_interval || 600), 120, 86400) * 1000;
    state.weatherTimer = setInterval(pollWeather, wms);
  }
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
  $('#owTestBtn').addEventListener('click', doTestWeather);
  $('#refreshBtn').addEventListener('click', () => { pollStatus(true); fetchHistory(); pollWeather(); });
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
  $('#wxRangeTabs').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    $$('#wxRangeTabs button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    state.wxRangeDays = parseFloat(b.dataset.d);
    renderWxDailyChart();
  });
  $('#wxDayPicker').addEventListener('change', e => wxDayLookup(e.target.value));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });
  // ricattura quando la scheda torna in primo piano
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { pollStatus(); fetchHistory(); pollWeather(); } });
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
    restartPolling();       // avvia comunque il timer meteo se attivo
  } else {
    hideEmpty();
    await pollStatus();     // cattura immediata all'apertura della pagina
    await fetchHistory();
    restartPolling();
  }

  await pollWeather();      // il meteo è indipendente dai sensori
}

document.addEventListener('DOMContentLoaded', init);
