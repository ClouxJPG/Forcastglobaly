'use strict';

/* Если Leaflet не загрузился с CDN — говорим об этом прямо на странице */
if (typeof L === 'undefined') {
  document.getElementById('status').textContent =
    'Не загрузилась библиотека Leaflet (unpkg.com). Проверьте интернет и обновите страницу.';
  document.getElementById('status').classList.add('error');
  throw new Error('Leaflet is not loaded');
}

/* =====================================================================
   1. НАСТРОЙКИ — здесь удобно что-то менять
   ===================================================================== */

const GIBS = 'https://gibs.earthdata.nasa.gov';
const FALLBACK_LAYER = 'GOES-East_ABI_Band13_Clean_Infrared'; // запасная палитра
const LAG_MINUTES = 30;             // начинаем искать снимок с «получаса назад»
const CLICK_ZOOM = 6;               // самый детальный уровень тайлов (≈2,4 км на пиксель)
const REFRESH_MS = 10 * 60 * 1000;  // обновлять снимок раз в 10 минут

// Тайл для проверки «снимок на это время уже есть?»: [z, x, y] внутри зоны видимости спутника
const PROBE = {
  'GOES-East_ABI_Band13_Clean_Infrared': [3, 2, 3],
  'GOES-West_ABI_Band13_Clean_Infrared': [3, 1, 3],
  'Himawari_AHI_Band13_Clean_Infrared':  [3, 7, 3],
};

// Цветовая шкала: [температура °C, [R, G, B]]
const SCALE = [
  [-30, [43, 131, 186]],   // синий
  [-40, [79, 191, 138]],   // зелёный
  [-50, [255, 224, 102]],  // жёлтый
  [-60, [253, 141, 60]],   // оранжевый
  [-70, [227, 26, 28]],    // красный
  [-80, [255, 77, 240]],   // пурпурный
  [-90, [255, 255, 255]],  // белый — самые холодные вершины
];

// Категории. «t» — верхняя граница: подходит категория, если температура ≤ t.
const CATEGORIES = [
  { t: -80,      name: 'Очень сильный', range: '−80 °C и ниже',    color: '#ff4df0' },
  { t: -60,      name: 'Сильный',       range: 'от −60 до −80 °C', color: '#fd8d3c' },
  { t: -45,      name: 'Умеренный',     range: 'от −45 до −60 °C', color: '#ffe066' },
  { t: -30,      name: 'Слабый',        range: 'от −30 до −45 °C', color: '#2b83ba' },
  { t: Infinity, name: 'Признаков нет', range: 'теплее −30 °C',    color: '#5b6475' },
];

/* =====================================================================
   2. КОСМИЧЕСКИЙ ФОН
   Рисуем один раз на холсте: туманности, полосу Млечного Пути и звёзды.
   Генератор случайных чисел с «семенем» — при изменении окна звёзды
   остаются на тех же местах.
   ===================================================================== */

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function drawSpace() {
  const canvas = document.getElementById('space');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth, h = window.innerHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const rnd = mulberry32(20261107);
  const big = Math.max(w, h);

  // Основной фон
  let g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#04050c');
  g.addColorStop(1, '#0a0b1a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // Туманности: [x, y, радиус, цвет RGB, прозрачность]
  const blobs = [
    [0.18, 0.28, 0.55, '110,70,190', 0.20],
    [0.86, 0.72, 0.60, '30,130,170', 0.16],
    [0.62, 0.08, 0.35, '190,70,140', 0.10],
  ];
  for (const [bx, by, br, rgb, a] of blobs) {
    g = ctx.createRadialGradient(bx * w, by * h, 0, bx * w, by * h, br * big);
    g.addColorStop(0, `rgba(${rgb},${a})`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  const tints = ['200,215,255', '255,255,255', '255,232,205'];
  function star(x, y) {
    const r = 0.25 + Math.pow(rnd(), 4) * 1.5;
    const a = 0.25 + rnd() * 0.75;
    const tint = tints[Math.floor(rnd() * tints.length)];
    ctx.fillStyle = `rgba(${tint},${a})`;
    if (r > 1.1) { ctx.shadowColor = `rgba(${tint},0.9)`; ctx.shadowBlur = 6; }
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  // Полоса Млечного Пути: наклонённая светлая лента и густые звёзды в ней
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(-0.55);
  const len = Math.hypot(w, h);
  const bw = big * 0.22;
  g = ctx.createLinearGradient(0, -bw, 0, bw);
  g.addColorStop(0, 'rgba(170,180,255,0)');
  g.addColorStop(0.5, 'rgba(170,180,255,0.09)');
  g.addColorStop(1, 'rgba(170,180,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(-len / 2, -bw, len, bw * 2);
  for (let i = 0; i < len * 0.6; i++) {
    const gauss = (rnd() + rnd() + rnd() - 1.5) / 1.5;
    star((rnd() - 0.5) * len, gauss * bw * 0.35);
  }
  ctx.restore();

  // Остальные звёзды
  const count = Math.round((w * h) / 2200);
  for (let i = 0; i < count; i++) star(rnd() * w, rnd() * h);
}

drawSpace();
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(drawSpace, 150);
});

/* =====================================================================
   3. ПАЛИТРА NASA: цвет пикселя → температура
   ===================================================================== */

const lookups = {};

function getLookup(layer) {
  if (!lookups[layer]) {
    lookups[layer] = buildLookup(layer).catch((err) => {
      delete lookups[layer]; // при ошибке в следующий раз попробуем снова
      throw err;
    });
  }
  return lookups[layer];
}

async function buildLookup(layer) {
  let xml = null;
  for (const name of [layer, FALLBACK_LAYER]) {
    try {
      const resp = await fetch(`${GIBS}/colormaps/v1.3/${name}.xml`);
      if (resp.ok) { xml = await resp.text(); break; }
    } catch (e) { /* пробуем следующий вариант */ }
  }
  if (!xml) throw new Error('Не удалось скачать палитру NASA');

  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const entries = [];

  for (const cm of doc.getElementsByTagName('ColorMap')) {
    const kelvin = /\bK\b/.test(cm.getAttribute('units') || '');
    for (const e of cm.getElementsByTagName('ColorMapEntry')) {
      const value = e.getAttribute('value');
      if (!value || e.getAttribute('transparent') === 'true') continue;

      const nums = (value.match(/-?\d+(?:\.\d+)?/g) || []).map(Number); // "[-63,-62)" → [-63, -62]
      if (!nums.length) continue;
      let temp = nums.length === 1 ? nums[0] : (nums[0] + nums[1]) / 2;
      if (kelvin) temp -= 273.15;

      const [r, g, b] = e.getAttribute('rgb').split(',').map(Number);
      entries.push({ r, g, b, temp });
    }
  }
  if (!entries.length) throw new Error('Палитра пустая');

  const cache = new Map();
  return (r, g, b) => {
    const key = (r << 16) | (g << 8) | b;
    if (cache.has(key)) return cache.get(key);
    let best = null, bestD = Infinity;
    for (const e of entries) {
      const d = (e.r - r) ** 2 + (e.g - g) ** 2 + (e.b - b) ** 2;
      if (d < bestD) { bestD = d; best = e; }
    }
    const temp = bestD <= 300 ? best.temp : null;
    cache.set(key, temp);
    return temp;
  };
}

/* =====================================================================
   4. ТАЙЛЫ NASA: загрузка, поиск свежего снимка, перекраска
   ===================================================================== */

const state = {
  layer: null, time: null, lookup: null,
  irLayer: null,
  cors: 'unknown', // 'ok' — можно читать пиксели, 'broken' — браузер не даёт (тогда без перекраски)
};

const isoTime = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function tileUrl(layer, time, z, x, y) {
  const shard = 'abc'[(x + y) % 3]; // gibs-a / gibs-b / gibs-c — тайлы грузятся быстрее
  return `https://gibs-${shard}.earthdata.nasa.gov/wmts/epsg3857/best/${layer}` +
         `/default/${time}/GoogleMapsCompatible_Level6/${z}/${y}/${x}.png`;
}

function loadImage(url, withCors) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (withCors) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

// Загружаем тайл. Сначала с разрешением читать пиксели (CORS).
// Если сервер не разрешил — показываем картинку как есть, без перекраски.
async function loadTileImage(url) {
  if (state.cors !== 'broken') {
    try {
      const img = await loadImage(url, true);
      state.cors = 'ok';
      return { img, cors: true };
    } catch (e) {
      if (state.cors === 'ok') return null; // CORS работает, значит тайла просто нет
    }
  }
  try {
    const img = await loadImage(url, false);
    if (state.cors === 'unknown') state.cors = 'broken';
    return { img, cors: false };
  } catch (e) {
    return null;
  }
}

// Ищем самый свежий снимок, который уже есть на сервере (идём назад с шагом 10 минут)
async function findTime(layer) {
  const [z, x, y] = PROBE[layer] || [3, 2, 3];
  const base = Math.floor((Date.now() - LAG_MINUTES * 60000) / 600000) * 600000;
  for (let i = 0; i < 8; i++) {
    const t = isoTime(base - i * 600000);
    try {
      await loadImage(tileUrl(layer, t, z, x, y), false);
      return t;
    } catch (e) { /* такого снимка ещё нет — пробуем на 10 минут раньше */ }
  }
  return null;
}

// Цвет по нашей шкале
function scaleColor(T) {
  if (T <= SCALE[SCALE.length - 1][0]) return SCALE[SCALE.length - 1][1];
  for (let i = 0; i < SCALE.length - 1; i++) {
    const [t1, c1] = SCALE[i], [t2, c2] = SCALE[i + 1];
    if (T <= t1 && T >= t2) {
      const k = (t1 - T) / (t1 - t2);
      return c1.map((v, j) => Math.round(v + (c2[j] - v) * k));
    }
  }
  return SCALE[0][1];
}

function recolor(data, lookup) {
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 10) { data[i + 3] = 0; continue; }
    const T = lookup(data[i], data[i + 1], data[i + 2]);
    if (T === null) { data[i + 3] = 0; continue; }

    if (T > SCALE[0][0]) {
      // Тёплые облака — тусклый серый фон
      const v = Math.min(1, Math.max(0, (20 - T) / 50));
      const gray = Math.round(50 + 110 * v);
      data[i] = data[i + 1] = data[i + 2] = gray;
      data[i + 3] = 140;
    } else {
      const [r, g, b] = scaleColor(T);
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 235;
    }
  }
}

// Свой слой Leaflet: каждый тайл — это холст, на который мы рисуем перекрашенный снимок
const IRLayer = L.GridLayer.extend({
  createTile(coords, done) {
    const o = this.options;
    const tile = document.createElement('canvas');
    tile.width = tile.height = 256;
    const ctx = tile.getContext('2d', { willReadFrequently: true });

    loadTileImage(tileUrl(o.satellite, o.time, coords.z, coords.x, coords.y))
      .then((res) => {
        if (res) {
          ctx.drawImage(res.img, 0, 0, 256, 256);
          if (res.cors && o.lookup) {
            const img = ctx.getImageData(0, 0, 256, 256);
            recolor(img.data, o.lookup);
            ctx.putImageData(img, 0, 0);
          }
        }
        done(null, tile);
      })
      .catch(() => done(null, tile)); // при любой ошибке — просто пустой тайл
    return tile;
  },
});

/* =====================================================================
   5. ТЕМПЕРАТУРА В ТОЧКЕ КЛИКА
   ===================================================================== */

async function temperatureAt(lng, lat) {
  lat = Math.max(-85.0511, Math.min(85.0511, lat));
  const n = 2 ** CLICK_ZOOM;
  const fx = ((lng + 180) / 360) * n;
  const rad = (lat * Math.PI) / 180;
  const fy = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
  const x = Math.floor(fx), y = Math.floor(fy);

  const res = await loadTileImage(tileUrl(state.layer, state.time, CLICK_ZOOM, x, y));
  if (!res) return { status: 'empty' };
  if (!res.cors || !state.lookup) return { status: 'nocors' };

  const canvas = document.createElement('canvas');
  canvas.width = res.img.width;
  canvas.height = res.img.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(res.img, 0, 0);
  const px = Math.floor((fx - x) * canvas.width);
  const py = Math.floor((fy - y) * canvas.height);
  const [r, g, b, a] = ctx.getImageData(px, py, 1, 1).data;
  if (a < 10) return { status: 'empty' };

  const T = state.lookup(r, g, b);
  return T === null ? { status: 'empty' } : { status: 'ok', T };
}

const categoryFor = (T) => CATEGORIES.find((c) => T <= c.t);
const fmt = (T) => String(Math.round(T)).replace('-', '−');

/* =====================================================================
   6. КАРТА
   ===================================================================== */

const WORLD = L.latLngBounds([-85.05, -180], [85.05, 180]);

const map = L.map('map', {
  zoomControl: false,
  zoomSnap: 0.25,
  maxZoom: 9,
  worldCopyJump: false,
  maxBounds: WORLD.pad(0.35),
  maxBoundsViscosity: 0.7,
});
L.control.zoom({ position: 'bottomright' }).addTo(map);

// Слои-«этажи»: подложка (200) → ИК (250) → подписи (300)
map.createPane('ir').style.zIndex = 250;
const labelsPane = map.createPane('labels');
labelsPane.style.zIndex = 300;
labelsPane.style.pointerEvents = 'none';

const carto = (name, options) =>
  L.tileLayer(`https://{s}.basemaps.cartocdn.com/${name}/{z}/{x}/{y}.png`,
    { subdomains: 'abcd', noWrap: true, maxZoom: 9, ...options });

const darkMap = carto('dark_nolabels', { attribution: '© OpenStreetMap contributors © CARTO' });

const satMap = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  { noWrap: true, maxZoom: 9, attribution: 'Esri, Maxar, Earthstar Geographics' }
);

const labels = carto('dark_only_labels', { pane: 'labels' });

darkMap.addTo(map);
labels.addTo(map);

// Переключатель подложек (справа вверху)
L.control.layers(
  { 'Тёмная карта': darkMap, 'Спутниковые снимки (Esri)': satMap },
  { 'Подписи': labels },
  { collapsed: window.innerWidth < 600, position: 'topright' }
).addTo(map);

// Тонкая рамка по краю мира — чтобы карта выглядела как «планшет» в космосе
L.rectangle(WORLD, { color: '#7fa6ff', weight: 1, opacity: 0.35, fill: false, interactive: false }).addTo(map);

// Не даём отдалиться дальше, чем «весь мир чуть-чуть с запасом»
function fitWorld(initial) {
  map.invalidateSize();
  const z = map.getBoundsZoom(WORLD, false) - 0.4;
  map.setMinZoom(Math.max(z, 0));
  if (initial) map.fitBounds(WORLD, { padding: [30, 30] });
  else if (map.getZoom() < z) map.setZoom(z);
}
fitWorld(true);
window.addEventListener('resize', () => fitWorld(false));

/* =====================================================================
   7. ПАНЕЛЬ: спутник, прозрачность, обновление
   ===================================================================== */

const statusEl = document.getElementById('status');
const selectEl = document.getElementById('satellite');
const opacityEl = document.getElementById('opacity');
let baseStatus = '';
let seq = 0; // номер запроса — чтобы старый ответ не затёр новый

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

async function setSatellite(layer) {
  const mySeq = ++seq;
  setStatus('Ищу свежий снимок…');

  const [lookup, time] = await Promise.all([
    getLookup(layer).catch((err) => { console.warn(err); return null; }),
    findTime(layer),
  ]);
  if (mySeq !== seq) return; // пока ждали, выбрали другой спутник

  const usedTime = time || isoTime(Math.floor((Date.now() - LAG_MINUTES * 60000) / 600000) * 600000);

  if (state.irLayer) map.removeLayer(state.irLayer);
  state.layer = layer;
  state.time = usedTime;
  state.lookup = lookup;

  state.irLayer = new IRLayer({
    satellite: layer,
    time: usedTime,
    lookup,
    pane: 'ir',
    maxNativeZoom: 6, // детальнее 6-го уровня у NASA нет — дальше картинка увеличивается
    noWrap: true,
    opacity: +opacityEl.value,
    attribution: 'Снимки: NASA GIBS (NOAA, JMA)',
  }).addTo(map);

  baseStatus = `Снимок на ${usedTime.slice(11, 16)} UTC (${usedTime.slice(0, 10)}). Нажмите на карту, чтобы узнать температуру.`;
  if (!time) {
    setStatus('Свежих снимков для этого спутника не нашлось — возможно, сервер NASA временно недоступен. ' + baseStatus, true);
  } else if (!lookup) {
    setStatus('Палитра NASA недоступна: показаны исходные цвета без перекраски, клик не работает.', true);
  } else {
    setStatus(baseStatus);
  }

  // Если браузер запретил читать пиксели — предупреждаем
  state.irLayer.on('load', () => {
    if (state.cors === 'broken') {
      setStatus('Браузер не разрешил читать пиксели (CORS): показаны исходные цвета NASA, клик не работает.', true);
    }
  });
}

selectEl.addEventListener('change', () => setSatellite(selectEl.value));
opacityEl.addEventListener('input', () => state.irLayer && state.irLayer.setOpacity(+opacityEl.value));
setSatellite(selectEl.value);
setInterval(() => setSatellite(selectEl.value), REFRESH_MS);

// Клик по карте
map.on('click', async (e) => {
  if (!state.layer) return;
  const { lat, lng } = e.latlng.wrap();

  const popup = L.popup({ maxWidth: 260 })
    .setLatLng(e.latlng)
    .setContent('<div class="popup-note">Считываю…</div>')
    .openOn(map);

  try {
    const r = await temperatureAt(lng, lat);
    if (r.status === 'nocors') {
      popup.setContent('<div>Не удалось прочитать температуру</div><div class="popup-note">Браузер не разрешил читать пиксели снимка или палитра не загрузилась.</div>');
    } else if (r.status === 'empty') {
      popup.setContent('<div>Нет данных в этой точке</div><div class="popup-note">Точка вне зоны выбранного спутника или снимок ещё не загружен.</div>');
    } else {
      const cat = categoryFor(r.T);
      popup.setContent(
        `<div class="popup-temp">≈ ${fmt(r.T)} °C</div>` +
        `<div>Восходящий поток: <b style="color:${cat.color}">${cat.name}</b></div>` +
        `<div class="popup-note">Условная оценка по температуре вершины, не прямое измерение. ` +
        `${lat.toFixed(2)}°, ${lng.toFixed(2)}°</div>`
      );
    }
  } catch (err) {
    console.error(err);
    popup.setContent('<div>Не получилось считать температуру</div><div class="popup-note">Подробности в консоли браузера (F12).</div>');
  }
});

/* =====================================================================
   8. ЛЕГЕНДА (строится из SCALE и CATEGORIES, поэтому всегда совпадает с картой)
   ===================================================================== */

(function buildLegend() {
  const top = SCALE[0][0], bottom = SCALE[SCALE.length - 1][0];
  const span = top - bottom;

  const stops = SCALE.map(([t, c]) => `rgb(${c.join(',')}) ${((top - t) / span) * 100}%`);
  document.getElementById('legend-bar').style.background = `linear-gradient(to right, ${stops.join(', ')})`;

  const ticks = document.getElementById('legend-ticks');
  for (const [t] of SCALE) {
    const s = document.createElement('span');
    s.style.left = `${((top - t) / span) * 100}%`;
    s.textContent = fmt(t);
    ticks.appendChild(s);
  }

  const list = document.getElementById('legend-cats');
  for (const c of CATEGORIES) {
    const li = document.createElement('li');
    const dot = document.createElement('i');
    dot.style.background = c.color;
    li.append(dot, `${c.name}: ${c.range}`);
    list.appendChild(li);
  }
})();
