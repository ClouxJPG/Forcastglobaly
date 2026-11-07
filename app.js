'use strict';

/* =====================================================================
   1. НАСТРОЙКИ — здесь удобно что-то менять
   ===================================================================== */

const GIBS = 'https://gibs.earthdata.nasa.gov';
const FALLBACK_LAYER = 'GOES-East_ABI_Band13_Clean_Infrared'; // если палитры нужного слоя нет
const CLICK_ZOOM = 6;      // самый детальный уровень тайлов (≈2,4 км на пиксель)
const LAG_MINUTES = 40;    // берём снимок «чуть из прошлого», чтобы он точно уже был на сервере

// Цветовая шкала: [температура °C, [R, G, B]]. Идёт от слабого к очень сильному.
const SCALE = [
  [-30, [43, 131, 186]],   // синий
  [-40, [79, 191, 138]],   // зелёный
  [-50, [255, 224, 102]],  // жёлтый
  [-60, [253, 141, 60]],   // оранжевый
  [-70, [227, 26, 28]],    // красный
  [-80, [255, 77, 240]],   // пурпурный
  [-90, [255, 255, 255]],  // белый — самые холодные вершины
];

// Категории. Условные пороги: «t» — верхняя граница (температура ≤ t).
// Ставьте сюда свои значения — легенда и всплывающее окно подстроятся сами.
const CATEGORIES = [
  { t: -80,      name: 'Очень сильный', range: '−80 °C и ниже', color: '#ff4df0' },
  { t: -60,      name: 'Сильный',       range: 'от −60 до −80 °C', color: '#fd8d3c' },
  { t: -45,      name: 'Умеренный',     range: 'от −45 до −60 °C', color: '#ffe066' },
  { t: -30,      name: 'Слабый',        range: 'от −30 до −45 °C', color: '#2b83ba' },
  { t: Infinity, name: 'Признаков нет', range: 'теплее −30 °C',    color: '#5b6475' },
];

/* =====================================================================
   2. ПАЛИТРА NASA: цвет пикселя → температура
   Тайлы NASA уже раскрашены. Чтобы понять температуру, мы берём
   «словарик» (XML-файл палитры) и по цвету пикселя находим градусы.
   ===================================================================== */

const lookups = {}; // кэш: название слоя → функция поиска

function getLookup(layer) {
  if (!lookups[layer]) lookups[layer] = buildLookup(layer);
  return lookups[layer];
}

async function buildLookup(layer) {
  let xml = null;
  for (const name of [layer, FALLBACK_LAYER]) {
    const resp = await fetch(`${GIBS}/colormaps/v1.3/${name}.xml`);
    if (resp.ok) { xml = await resp.text(); break; }
  }
  if (!xml) throw new Error('Не удалось скачать палитру NASA');

  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const entries = [];

  for (const cm of doc.getElementsByTagName('ColorMap')) {
    const kelvin = /\bK\b/.test(cm.getAttribute('units') || '');
    for (const e of cm.getElementsByTagName('ColorMapEntry')) {
      const value = e.getAttribute('value');
      if (!value || e.getAttribute('transparent') === 'true') continue;

      // value выглядит как "[-63,-62)": достаём числа
      const nums = (value.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
      if (!nums.length) continue;
      let temp = nums.length === 1 ? nums[0] : (nums[0] + nums[1]) / 2;
      if (kelvin) temp -= 273.15;

      const [r, g, b] = e.getAttribute('rgb').split(',').map(Number);
      entries.push({ r, g, b, temp });
    }
  }
  if (!entries.length) throw new Error('Палитра пустая');

  // Функция: (r, g, b) → температура или null. Результаты запоминаем.
  const cache = new Map();
  return (r, g, b) => {
    const key = (r << 16) | (g << 8) | b;
    if (cache.has(key)) return cache.get(key);
    let best = null, bestD = Infinity;
    for (const e of entries) {
      const d = (e.r - r) ** 2 + (e.g - g) ** 2 + (e.b - b) ** 2;
      if (d < bestD) { bestD = d; best = e; }
    }
    const temp = bestD <= 300 ? best.temp : null; // слишком непохожий цвет — считаем «нет данных»
    cache.set(key, temp);
    return temp;
  };
}

/* =====================================================================
   3. ЗАГРУЗКА ТАЙЛОВ И ПЕРЕКРАСКА
   ===================================================================== */

// Скачиваем один тайл NASA как картинку
async function loadBitmap(layer, time, z, x, y) {
  const shard = 'abc'[(x + y) % 3]; // gibs-a / gibs-b / gibs-c — так тайлы грузятся быстрее
  const url = `https://gibs-${shard}.earthdata.nasa.gov/wmts/epsg3857/best/${layer}` +
              `/default/${time}/GoogleMapsCompatible_Level6/${z}/${y}/${x}.png`;
  const resp = await fetch(url);
  if (!resp.ok) return null; // тайла нет (например, вне зоны спутника)
  return createImageBitmap(await resp.blob());
}

// Цвет по нашей шкале для температуры T (T уже ≤ −30)
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

// Перекрашиваем все пиксели тайла
function recolor(data, lookup) {
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 10) { data[i + 3] = 0; continue; }       // пусто
    const T = lookup(data[i], data[i + 1], data[i + 2]);
    if (T === null) { data[i + 3] = 0; continue; }              // цвет не опознан

    if (T > SCALE[0][0]) {
      // Тёплые облака — тусклый серый фон, чтобы видеть общую облачность
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

// Свой «протокол» для MapLibre: адреса вида ir://слой/время/z/x/y
// MapLibre сам просит такие тайлы, а мы скачиваем, перекрашиваем и отдаём.
maplibregl.addProtocol('ir', async (params) => {
  const [layer, time, z, x, y] = params.url.replace('ir://', '').split('/');
  const lookup = await getLookup(layer);
  const bmp = await loadBitmap(layer, time, +z, +x, +y);

  const size = 256;
  const canvas = new OffscreenCanvas(size, size);
  if (bmp) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, size, size);
    const img = ctx.getImageData(0, 0, size, size);
    recolor(img.data, lookup);
    ctx.putImageData(img, 0, 0);
  }
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return { data: await blob.arrayBuffer() };
});

/* =====================================================================
   4. ТЕМПЕРАТУРА В ТОЧКЕ КЛИКА
   ===================================================================== */

async function temperatureAt(layer, time, lng, lat) {
  lat = Math.max(-85.0511, Math.min(85.0511, lat));
  const n = 2 ** CLICK_ZOOM;

  // Переводим широту/долготу в номер тайла и пиксель внутри него
  const fx = ((lng + 180) / 360) * n;
  const rad = (lat * Math.PI) / 180;
  const fy = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
  const x = Math.floor(fx), y = Math.floor(fy);

  const bmp = await loadBitmap(layer, time, CLICK_ZOOM, x, y);
  if (!bmp) return null;

  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const px = Math.floor((fx - x) * bmp.width);
  const py = Math.floor((fy - y) * bmp.height);
  const [r, g, b, a] = ctx.getImageData(px, py, 1, 1).data;
  if (a < 10) return null;

  return (await getLookup(layer))(r, g, b);
}

function categoryFor(T) {
  return CATEGORIES.find((c) => T <= c.t);
}

const fmt = (T) => String(Math.round(T)).replace('-', '−');

/* =====================================================================
   5. КАРТА
   ===================================================================== */

const CARTO = 'basemaps.cartocdn.com';
const sub = (name) => ['a', 'b', 'c', 'd'].map((s) => `https://${s}.${CARTO}/${name}/{z}/{x}/{y}.png`);

const map = new maplibregl.Map({
  container: 'map',
  center: [-60, 10],
  zoom: 1.6,
  style: {
    version: 8,
    projection: { type: 'globe' }, // вот что превращает карту в глобус
    sources: {
      base:   { type: 'raster', tiles: sub('dark_nolabels'),    tileSize: 256, attribution: '© OpenStreetMap contributors © CARTO' },
      labels: { type: 'raster', tiles: sub('dark_only_labels'), tileSize: 256 },
    },
    layers: [
      { id: 'bg',     type: 'background', paint: { 'background-color': '#0a0d14' } },
      { id: 'base',   type: 'raster', source: 'base' },
      // подписи рисуем ПОВЕРХ спутникового слоя, поэтому слой «ir» вставим перед ними
      { id: 'labels', type: 'raster', source: 'labels', paint: { 'raster-opacity': 0.8 } },
    ],
  },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

const statusEl = document.getElementById('status');
function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

let current = { layer: null, time: null };

function snapshotTime() {
  const ms = Math.floor((Date.now() - LAG_MINUTES * 60000) / 600000) * 600000; // шаг 10 минут
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function setSatellite(layer) {
  setStatus('Загрузка палитры NASA…');
  try {
    await getLookup(layer);
  } catch (err) {
    console.error(err);
    setStatus('Не удалось загрузить палитру NASA. Проверьте интернет и консоль браузера (F12).', true);
    return;
  }

  const time = snapshotTime();
  current = { layer, time };

  if (map.getLayer('ir')) map.removeLayer('ir');
  if (map.getSource('ir')) map.removeSource('ir');

  map.addSource('ir', {
    type: 'raster',
    tiles: [`ir://${layer}/${time}/{z}/{x}/{y}`],
    tileSize: 256,
    maxzoom: 6, // детальнее 6-го уровня у NASA нет — дальше картинка просто увеличивается
    attribution: 'Снимки: NASA GIBS, NOAA/JMA',
  });
  map.addLayer({
    id: 'ir', type: 'raster', source: 'ir',
    paint: { 'raster-opacity': 0.92, 'raster-fade-duration': 0 },
  }, 'labels');

  setStatus(`Снимок на ${time.slice(11, 16)} UTC (${time.slice(0, 10)}). Нажмите на глобус, чтобы узнать температуру.`);
}

map.on('load', () => {
  const select = document.getElementById('satellite');
  setSatellite(select.value);
  select.addEventListener('change', () => setSatellite(select.value));
});

// Клик по карте
map.getCanvas().style.cursor = 'crosshair';
map.on('click', async (e) => {
  if (!current.layer) return;
  const { lng, lat } = e.lngLat.wrap();

  const popup = new maplibregl.Popup({ maxWidth: '260px' })
    .setLngLat(e.lngLat)
    .setHTML('<div class="popup-note">Считываю…</div>')
    .addTo(map);

  try {
    const T = await temperatureAt(current.layer, current.time, lng, lat);
    if (T === null) {
      popup.setHTML('<div>Нет данных в этой точке</div><div class="popup-note">Точка вне зоны выбранного спутника или снимок ещё не загружен.</div>');
      return;
    }
    const cat = categoryFor(T);
    popup.setHTML(
      `<div class="popup-temp">≈ ${fmt(T)} °C</div>` +
      `<div>Восходящий поток: <b style="color:${cat.color}">${cat.name}</b></div>` +
      `<div class="popup-note">Условная оценка по температуре вершины, не прямое измерение. ` +
      `${lat.toFixed(2)}°, ${lng.toFixed(2)}°</div>`
    );
  } catch (err) {
    console.error(err);
    popup.setHTML('<div>Не получилось считать температуру</div><div class="popup-note">Подробности в консоли браузера (F12).</div>');
  }
});

/* =====================================================================
   6. ЛЕГЕНДА (строится из тех же SCALE и CATEGORIES, поэтому всегда совпадает)
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
