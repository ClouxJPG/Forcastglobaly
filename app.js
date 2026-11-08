'use strict';

const statusEl = document.getElementById('status');
function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

// Строки диагностики под статусом: показывают, какой шаг сработал, а какой нет
const diagData = {};
function setDiag(key, text) {
  diagData[key] = text;
  const el = document.getElementById('diag');
  if (el) el.textContent = Object.values(diagData).join('\n');
}

/* Любую неожиданную ошибку показываем прямо на странице */
window.addEventListener('error', (e) => setStatus('Ошибка: ' + (e.message || 'см. консоль (F12)'), true));
window.addEventListener('unhandledrejection', (e) => console.error(e.reason));

if (typeof maplibregl === 'undefined') {
  setStatus('Не загрузилась библиотека MapLibre (unpkg.com). Проверьте интернет и обновите страницу.', true);
  throw new Error('MapLibre is not loaded');
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

// Куда повернуть глобус при выборе спутника: [долгота, широта]
const VIEW = {
  'GOES-East_ABI_Band13_Clean_Infrared': [-75, 10],
  'GOES-West_ABI_Band13_Clean_Infrared': [-135, 10],
  'Himawari_AHI_Band13_Clean_Infrared':  [130, 15],
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
  const fails = [];
  const urls = [];
  for (const name of [layer, FALLBACK_LAYER]) for (const v of ['v1.3', 'v1.0']) urls.push(`${GIBS}/colormaps/${v}/${name}.xml`);
  for (const url of urls) {
    const short = url.split('/colormaps/')[1];
    try {
      const resp = await fetch(url);
      if (resp.ok) { xml = await resp.text(); setDiag('palette', 'Палитра: ' + short + ' — ок'); break; }
      fails.push(resp.status + ' ' + short);
    } catch (e) {
      fails.push('нет доступа (CORS/сеть) ' + short);
    }
  }
  if (!xml) {
    setDiag('palette', 'Палитра НЕ скачалась: ' + fails.join('; '));
    throw new Error('Не удалось скачать палитру NASA');
  }

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
   4. ТАЙЛЫ NASA: поиск свежего снимка, загрузка, перекраска
   ===================================================================== */

const state = { layer: null, time: null, lookup: null };

const isoTime = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function tileUrl(layer, time, z, x, y) {
  const shard = 'abc'[(x + y) % 3]; // gibs-a / gibs-b / gibs-c — тайлы грузятся быстрее
  return `https://gibs-${shard}.earthdata.nasa.gov/wmts/epsg3857/best/${layer}` +
         `/default/${time}/GoogleMapsCompatible_Level6/${z}/${y}/${x}.png`;
}

function loadImage(url, withCors) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (withCors) img.crossOrigin = 'anonymous'; // разрешение читать пиксели картинки
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
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

// Свой «адрес» тайлов для MapLibre: ir://слой/время/z/x/y
// MapLibre просит такой тайл, мы скачиваем снимок NASA, перекрашиваем и отдаём.
// Используем обычный <canvas> (не OffscreenCanvas): он работает во всех браузерах, включая iPhone.
maplibregl.addProtocol('ir', async (params) => {
  const [layer, time, z, x, y] = params.url.replace('ir://', '').split('/');
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;

  try {
    const lookup = await getLookup(layer).catch(() => null);
    const img = await loadImage(tileUrl(layer, time, +z, +x, +y), true);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, 256, 256);
    if (lookup) {
      const data = ctx.getImageData(0, 0, 256, 256);
      recolor(data.data, lookup);
      ctx.putImageData(data, 0, 0);
    }
  } catch (e) {
    /* тайла нет или он недоступен — отдаём прозрачный */
  }

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  return { data: await blob.arrayBuffer() };
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

  let img;
  try {
    img = await loadImage(tileUrl(state.layer, state.time, CLICK_ZOOM, x, y), true);
  } catch (e) {
    return { status: 'empty' };
  }
  if (!state.lookup) return { status: 'nopalette' };

  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
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
   5б. ПОИСК ОЧАГОВ КОНВЕКЦИИ
   Скачиваем весь регион спутника целиком (уровень 4, ≈10 км на пиксель),
   переводим цвета в температуры и ищем самые холодные «ядра» облаков.
   ===================================================================== */

const DZ = 4;                      // уровень тайлов для анализа
const NODATA = 32767;              // «нет данных» в массиве температур
const MAX_CELLS = 300;             // сколько очагов показывать максимум
const SUBSAT = {                   // долгота под спутником
  'GOES-East_ABI_Band13_Clean_Infrared': -75,
  'GOES-West_ABI_Band13_Clean_Infrared': -137,
  'Himawari_AHI_Band13_Clean_Infrared': 140.7,
};
let grid = null, cells = [], snapText = '';

const thresholdEl = document.getElementById('threshold');
const showIrEl = document.getElementById('show-ir');

// Собираем регион из тайлов в один большой холст и переводим пиксели в температуры
async function buildGrid(layer, time, lookup) {
  const n = 2 ** DZ, c = SUBSAT[layer] ?? 0;
  const xa = Math.floor(((c - 72 + 180) / 360) * n), xb = Math.floor(((c + 72 + 180) / 360) * n);
  const ya = 4, yb = 11;           // примерно от 60° с.ш. до 60° ю.ш.
  const w = (xb - xa + 1) * 256, h = (yb - ya + 1) * 256;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  let ok = 0;
  const jobs = [];
  for (let x = xa; x <= xb; x++) for (let y = ya; y <= yb; y++) {
    jobs.push(loadImage(tileUrl(layer, time, DZ, ((x % n) + n) % n, y), true)
      .then((img) => { ctx.drawImage(img, (x - xa) * 256, (y - ya) * 256); ok++; }, () => {}));
  }
  await Promise.all(jobs);
  if (!ok) { setDiag('match', 'Анализ: тайлы не скачались (CORS или сеть)'); return null; }

  const px = ctx.getImageData(0, 0, w, h).data;
  const T = new Int16Array(w * h);               // температура в десятых долях °C
  let matched = 0, unmatched = 0;
  for (let i = 0, k = 0; k < T.length; i += 4, k++) {
    if (px[i + 3] < 10) { T[k] = NODATA; continue; }
    const t = lookup(px[i], px[i + 1], px[i + 2]);
    if (t === null) { unmatched++; T[k] = NODATA; } else { matched++; T[k] = Math.round(t * 10); }
  }
  setDiag('match', `Анализ: тайлов ${ok}, цветов сопоставлено ${matched} из ${matched + unmatched}` +
    (matched + unmatched === 0 ? ' (на снимке нет данных)' : matched < unmatched ? ' — палитра не совпадает со снимком!' : ''));
  return { w, h, T, gx0: xa * 256, gy0: ya * 256 };
}

// Пиксель сетки → широта и долгота
function pixelGeo(g, i, j) {
  const W = 256 * 2 ** DZ;
  let lng = ((g.gx0 + i + 0.5) / W) * 360 - 180;
  lng = ((((lng + 180) % 360) + 360) % 360) - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (g.gy0 + j + 0.5)) / W))) * 180) / Math.PI;
  return [lng, lat];
}

// Ищем очаги: берём самые холодные пиксели по порядку, вокруг каждого «гасим» соседей (≈60 км),
// чтобы один большой холодный щит не превращался в сотни точек.
function detectCells(g, thr) {
  const { w, h, T } = g, lim = Math.round(thr * 10), LOW = -1000;

  // Сортировка пикселей от самых холодных (быстрая «сортировка подсчётом»)
  const cnt = new Uint32Array(lim - LOW + 2);
  for (let k = 0; k < T.length; k++) { const t = T[k]; if (t !== NODATA && t <= lim && t >= LOW) cnt[t - LOW + 1]++; }
  for (let b = 1; b < cnt.length; b++) cnt[b] += cnt[b - 1];
  const order = new Uint32Array(cnt[cnt.length - 1]);
  for (let k = 0; k < T.length; k++) { const t = T[k]; if (t !== NODATA && t <= lim && t >= LOW) order[cnt[t - LOW]++] = k; }

  const sup = new Uint8Array(w * h), out = [];
  for (const k of order) {
    if (sup[k]) continue;
    const x = k % w, y = (k / w) | 0, t = T[k] / 10;

    // Холодная площадь вокруг ядра (радиус 14 пикселей) и «гашение» соседей (радиус 6)
    let cold = 0;
    for (let dy = -14; dy <= 14; dy++) for (let dx = -14; dx <= 14; dx++) {
      const xx = x + dx, yy = y + dy, d2 = dx * dx + dy * dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h || d2 > 196) continue;
      const v = T[yy * w + xx];
      if (d2 <= 36) sup[yy * w + xx] = 1;
      if (v !== NODATA && v <= lim) cold++;
    }

    // Перепад: насколько ядро холоднее кольца вокруг (8 точек на расстоянии 8 пикселей)
    let ring = 0, rn = 0;
    for (let a = 0; a < 8; a++) {
      const xx = x + Math.round(8 * Math.cos((a * Math.PI) / 4)), yy = y + Math.round(8 * Math.sin((a * Math.PI) / 4));
      if (xx >= 0 && yy >= 0 && xx < w && yy < h && T[yy * w + xx] !== NODATA) { ring += T[yy * w + xx] / 10; rn++; }
    }

    const [lng, lat] = pixelGeo(g, x, y);
    const km = 9.784 * Math.cos((lat * Math.PI) / 180);       // километров в пикселе на этой широте
    const cat = categoryFor(t);
    out.push({ lng, lat, T: t, dT: rn >= 4 ? ring / rn - t : null,
               area: Math.round(cold * km * km), cat: cat.name, color: cat.color });
    if (out.length >= MAX_CELLS) break;
  }
  return out;
}

// Слои с очагами: цветные кружки (цвет и размер зависят от температуры ядра)
function addCellLayers() {
  map.addSource('cells', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  const color = ['interpolate', ['linear'], ['get', 'T'],
    ...SCALE.slice().reverse().flatMap(([t, c]) => [t, `rgb(${c.join(',')})`])];
  const size = (a, b) => ['interpolate', ['linear'], ['get', 'T'], -90, a, -30, b];
  map.addLayer({ id: 'cells-glow', type: 'circle', source: 'cells',
    paint: { 'circle-color': color, 'circle-radius': size(30, 12), 'circle-blur': 0.8, 'circle-opacity': 0.45 } });
  map.addLayer({ id: 'cells', type: 'circle', source: 'cells',
    paint: { 'circle-color': color, 'circle-radius': size(15, 5), 'circle-stroke-color': '#ffffff',
             'circle-stroke-width': 1.2, 'circle-opacity': 0.95 } });
  map.on('mouseenter', 'cells', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'cells', () => { map.getCanvas().style.cursor = ''; });
}

function openCellPopup(c) {
  const kind = c.dT === null ? '' : c.dT >= 10
    ? `Острая вершина (на ${c.dT.toFixed(0)} °C холоднее окружения): вероятно активный рост.`
    : `Широкий холодный щит (на ${c.dT.toFixed(0)} °C холоднее окружения): возможно наковальня.`;
  new maplibregl.Popup({ maxWidth: '280px' }).setLngLat([c.lng, c.lat]).setHTML(
    `<div class="popup-temp">≈ ${fmt(c.T)} °C</div>` +
    `<div>Восходящий поток: <b style="color:${c.color}">${c.cat}</b></div>` +
    `<div class="popup-note">Холодная область вокруг: ≈ ${c.area.toLocaleString('ru-RU')} км². ${kind}</div>` +
    `<div class="popup-note">Автоматическая оценка по ИК-снимку, не прямое измерение. ${c.lat.toFixed(2)}°, ${c.lng.toFixed(2)}°</div>`
  ).addTo(map);
}

function renderCells(list) {
  const src = map.getSource('cells');
  if (src) src.setData({ type: 'FeatureCollection', features: list.map((c, i) => ({
    type: 'Feature', properties: { ...c, i }, geometry: { type: 'Point', coordinates: [c.lng, c.lat] } })) });

  const ol = document.getElementById('cells-list');
  ol.replaceChildren();
  list.slice(0, 8).forEach((c) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    const dot = document.createElement('i');
    dot.style.background = c.color;
    btn.append(dot, `${fmt(c.T)} °C · ${c.cat} · ${c.lat.toFixed(1)}°, ${c.lng.toFixed(1)}°`);
    btn.addEventListener('click', () => { map.flyTo({ center: [c.lng, c.lat], zoom: 4.5 }); openCellPopup(c); });
    li.append(btn);
    ol.append(li);
  });
  document.getElementById('cells-count').textContent = list.length
    ? `Найдено очагов: ${list.length >= MAX_CELLS ? MAX_CELLS + '+' : list.length}. Сильнейшие:`
    : 'Очагов выше порога не найдено.';
}

function redetect() {
  if (!grid) return;
  cells = detectCells(grid, +thresholdEl.value);
  renderCells(cells);
  setStatus(snapText);
}

async function runAnalysis(layer, time, lookup, mySeq) {
  grid = null; cells = [];
  renderCells([]);
  document.getElementById('cells-count').textContent = '';
  if (!lookup) return;
  setStatus('Анализирую снимок: ищу очаги конвекции…');
  const g = await buildGrid(layer, time, lookup);
  if (mySeq !== seq) return;
  if (!g) { setStatus('Не удалось скачать снимок для анализа очагов.', true); return; }
  grid = g;
  redetect();
}

thresholdEl.addEventListener('input', () => {
  document.getElementById('thr-label').textContent = fmt(+thresholdEl.value) + ' °C';
});
thresholdEl.addEventListener('change', redetect);
showIrEl.addEventListener('change', () => {
  if (map.getLayer('ir')) map.setLayoutProperty('ir', 'visibility', showIrEl.checked ? 'visible' : 'none');
});

/* =====================================================================
   6. ГЛОБУС
   ===================================================================== */

const esri = (path) => `https://server.arcgisonline.com/ArcGIS/rest/services/${path}/MapServer/tile/{z}/{y}/{x}`;

let map;
try {
  map = new maplibregl.Map({
    container: 'map',
    center: VIEW['Himawari_AHI_Band13_Clean_Infrared'],
    zoom: 1.6,
    maxZoom: 9,
    attributionControl: { compact: true },
    style: {
      version: 8,
      projection: { type: 'globe' }, // вот что превращает карту в глобус
      sources: {
        sat:  { type: 'raster', tileSize: 256, maxzoom: 10, tiles: [esri('World_Imagery')],
                attribution: 'Esri, Maxar, Earthstar Geographics' },
        dark: { type: 'raster', tileSize: 256, maxzoom: 10, tiles: [esri('Canvas/World_Dark_Gray_Base')],
                attribution: 'Esri, HERE, Garmin' },
        refs: { type: 'raster', tileSize: 256, maxzoom: 10, tiles: [esri('Reference/World_Boundaries_and_Places')] },
      },
      layers: [
        { id: 'sat',  type: 'raster', source: 'sat' },
        { id: 'dark', type: 'raster', source: 'dark', layout: { visibility: 'none' } },
        // слой «ir» вставляется перед «refs», чтобы подписи были поверх снимка
        { id: 'refs', type: 'raster', source: 'refs', paint: { 'raster-opacity': 0.9 } },
      ],
    },
  });
} catch (err) {
  console.error(err);
  setStatus('Не удалось запустить глобус: браузеру нужен WebGL. Попробуйте другой браузер.', true);
  throw err;
}

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
map.on('error', (e) => console.warn('MapLibre:', e && e.error ? e.error.message : e));

/* =====================================================================
   7. ПАНЕЛЬ: спутник, подложка, подписи, прозрачность
   ===================================================================== */

const selectEl  = document.getElementById('satellite');
const baseEl    = document.getElementById('basemap');
const labelsEl  = document.getElementById('labels');
const opacityEl = document.getElementById('opacity');
let seq = 0; // номер запроса — чтобы старый ответ не затёр новый

async function setSatellite(layer, recenter) {
  const mySeq = ++seq;
  setStatus('Ищу свежий снимок…');

  const [lookup, time] = await Promise.all([
    getLookup(layer).catch((err) => { console.warn(err); return null; }),
    findTime(layer),
  ]);
  if (mySeq !== seq) return; // пока ждали, выбрали другой спутник

  const usedTime = time || 'default';
  setDiag('probe', time ? 'Снимок найден: ' + time : 'Снимок на ближайшие 80 минут не найден, беру «default»');
  const [pz, pxx, pyy] = PROBE[layer] || [3, 2, 3];
  loadImage(tileUrl(layer, usedTime, pz, pxx, pyy), true).then(
    () => setDiag('cors', 'Чтение пикселей (CORS): ок'),
    () => setDiag('cors', 'Чтение пикселей (CORS): НЕТ — тайл не читается'));
  state.layer = layer;
  state.time = usedTime;
  state.lookup = lookup;

  if (map.getLayer('ir')) map.removeLayer('ir');
  if (map.getSource('ir')) map.removeSource('ir');

  map.addSource('ir', {
    type: 'raster',
    tiles: [`ir://${layer}/${usedTime}/{z}/{x}/{y}`],
    tileSize: 256,
    maxzoom: 6, // детальнее 6-го уровня у NASA нет — дальше картинка увеличивается
    attribution: 'Снимки: NASA GIBS (NOAA, JMA)',
  });
  map.addLayer({
    id: 'ir', type: 'raster', source: 'ir',
    layout: { visibility: showIrEl.checked ? 'visible' : 'none' },
    paint: { 'raster-opacity': +opacityEl.value, 'raster-fade-duration': 0 },
  }, 'refs');

  if (recenter) map.easeTo({ center: VIEW[layer] || [0, 0], duration: 1200 });

  const base = (usedTime === 'default' ? 'Последний доступный снимок.' : `Снимок на ${usedTime.slice(11, 16)} UTC (${usedTime.slice(0, 10)}).`) + ' Нажмите на глобус, чтобы узнать температуру.';
  if (!time) {
    setStatus('Свежих снимков для этого спутника не нашлось — возможно, сервер NASA временно недоступен. ' + base, true);
  } else if (!lookup) {
    setStatus('Палитра NASA недоступна: показаны исходные цвета без перекраски, клик не работает.', true);
  } else {
    setStatus(base);
  }
  snapText = base;
  runAnalysis(layer, usedTime, lookup, mySeq);
}

map.on('load', () => {
  addCellLayers();
  setSatellite(selectEl.value, false);
  setInterval(() => setSatellite(selectEl.value, false), REFRESH_MS);
});

selectEl.addEventListener('change', () => setSatellite(selectEl.value, true));

baseEl.addEventListener('change', () => {
  map.setLayoutProperty('sat',  'visibility', baseEl.value === 'sat'  ? 'visible' : 'none');
  map.setLayoutProperty('dark', 'visibility', baseEl.value === 'dark' ? 'visible' : 'none');
});

labelsEl.addEventListener('change', () => {
  map.setLayoutProperty('refs', 'visibility', labelsEl.checked ? 'visible' : 'none');
});

opacityEl.addEventListener('input', () => {
  if (map.getLayer('ir')) map.setPaintProperty('ir', 'raster-opacity', +opacityEl.value);
});

// Клик по глобусу
map.on('click', async (e) => {
  if (!state.layer) return;
  const hit = map.queryRenderedFeatures(e.point, { layers: ['cells'] })[0];
  if (hit) { openCellPopup(cells[hit.properties.i]); return; }
  const { lng, lat } = e.lngLat.wrap();

  const popup = new maplibregl.Popup({ maxWidth: '260px' })
    .setLngLat(e.lngLat)
    .setHTML('<div class="popup-note">Считываю…</div>')
    .addTo(map);

  try {
    const r = await temperatureAt(lng, lat);
    if (r.status === 'nopalette') {
      popup.setHTML('<div>Не удалось прочитать температуру</div><div class="popup-note">Палитра NASA не загрузилась.</div>');
    } else if (r.status === 'empty') {
      popup.setHTML('<div>Нет данных в этой точке</div><div class="popup-note">Точка вне зоны выбранного спутника или снимок ещё не загружен.</div>');
    } else {
      const cat = categoryFor(r.T);
      popup.setHTML(
        `<div class="popup-temp">≈ ${fmt(r.T)} °C</div>` +
        `<div>Восходящий поток: <b style="color:${cat.color}">${cat.name}</b></div>` +
        `<div class="popup-note">Условная оценка по температуре вершины, не прямое измерение. ` +
        `${lat.toFixed(2)}°, ${lng.toFixed(2)}°</div>`
      );
    }
  } catch (err) {
    console.error(err);
    popup.setHTML('<div>Не получилось считать температуру</div><div class="popup-note">Подробности в консоли браузера (F12).</div>');
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
