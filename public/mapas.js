// Map layers: OpenStreetMap roads and tracks underneath, satellite on top (it can be made transparent or switched off),
// and offline map files (MBTiles, or the .sqlitedb that OsmAnd saves) kept on this device so they work without internet.
const SQLJS = "https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/";
const PMTILES_JS = "https://cdn.jsdelivr.net/npm/pmtiles@4.4.1/dist/pmtiles.js";
const PROTOMAPS_JS = "https://cdn.jsdelivr.net/npm/protomaps-leaflet@5.1.0/dist/protomaps-leaflet.js";
export const OFFROAD_URL = "https://github.com/jdelgadobess/libro-de-rallies/releases/download/mapa-marruecos/marruecos.pmtiles";
export const OFFROAD_ES_URL = "https://github.com/jdelgadobess/libro-de-rallies/releases/download/mapa-espana/espana.pmtiles";
const $ = (id) => document.getElementById(id);
const S2_URL = "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg";
const S2_ATTR = 'Satélite <a href="https://cloudless.eox.at">EOxCloudless</a> by EOX IT Services GmbH (contiene datos Copernicus Sentinel 2025 modificados)';
const ZONES = "libro-zonas"; // the service worker keeps this cache and never trims it
// Spain: the PNOA orthophoto of the IGN (CC BY 4.0), sharp to a few tens of cm, may be kept offline too
const PNOA_URL = "https://www.ign.es/wmts/pnoa-ma?request=GetTile&service=WMTS&VERSION=1.0.0&Layer=OI.OrthoimageCoverage&Style=default&Format=image/jpeg&TileMatrixSet=GoogleMapsCompatible&TileMatrix={z}&TileRow={y}&TileCol={x}";
const PNOA_ATTR = 'Ortofoto <a href="https://pnoa.ign.es">PNOA</a> cedida por © Instituto Geográfico Nacional';
const SPAIN = [[[35.95, -9.6], [43.95, 4.6]], [[27.4, -18.4], [29.5, -13.3]]]; // mainland with Baleares, and Canarias
const inSpain = ([[s, w], [n, e]]) => { const la = (s + n) / 2, lo = (w + e) / 2; return SPAIN.some(([[a, b], [c, d]]) => la >= a && la <= c && lo >= b && lo <= d); };
// the tiles that cover a rectangle
function tilesOf([[s, w], [n, e]], z0 = 8, z1 = 14, url = S2_URL) {
  const out = [], lx = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
  const ly = (lat, z) => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z); };
  for (let z = z0; z <= z1; z++) for (let x = lx(w, z); x <= lx(e, z); x++) for (let y = ly(n, z); y <= ly(s, z); y++) out.push(url.replace("{z}", z).replace("{x}", x).replace("{y}", y));
  return out;
}
const MAX_ZONE = 6000;
// a zone in Spain gets the PNOA as close as it fits, elsewhere Sentinel-2 (it has nothing past zoom 14)
function zonePlan(b) {
  if (inSpain(b)) for (let z = 18; z >= 15; z--) { const urls = tilesOf(b, 8, z, PNOA_URL); if (urls.length <= MAX_ZONE) return { src: "pnoa", z1: z, urls }; }
  return { src: "s2", z1: 14, urls: tilesOf(b) };
}
const zoneUrls = (z) => tilesOf(z.b, 8, z.z1 || 14, z.src === "pnoa" ? PNOA_URL : S2_URL);
// the maps in 45 MB pieces on the «mapas» branch: GitHub's release files can't be read by a web page, these can
const PIECES = "https://raw.githubusercontent.com/jdelgadobess/libro-de-rallies/mapas/";

/* ---------- IndexedDB: offline maps and the last copy of the data ---------- */
let dbp = null;
function idbOpen() {
  if (!dbp) dbp = new Promise((ok, ko) => {
    const rq = indexedDB.open("libro-de-rallies", 2);
    rq.onupgradeneeded = () => {
      const d = rq.result, has = (n) => d.objectStoreNames.contains(n);
      if (!has("maps")) d.createObjectStore("maps", { keyPath: "id" });
      if (!has("kv")) d.createObjectStore("kv");
      if (!has("videos")) d.createObjectStore("videos", { keyPath: "id" }); // own video files kept on this device
    };
    rq.onsuccess = () => ok(rq.result); rq.onerror = () => ko(rq.error);
  });
  return dbp;
}
const req = (r) => new Promise((ok, ko) => { r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error); });
export const idb = {
  async get(store, key) { const d = await idbOpen(); return req(d.transaction(store).objectStore(store).get(key)); },
  async all(store) { const d = await idbOpen(); return req(d.transaction(store).objectStore(store).getAll()); },
  async put(store, val, key) { const d = await idbOpen(); return req(d.transaction(store, "readwrite").objectStore(store).put(val, key)); },
  async del(store, key) { const d = await idbOpen(); return req(d.transaction(store, "readwrite").objectStore(store).delete(key)); },
};

const mbTxt = (b) => { const mb = b / 1048576; return mb >= 1000 ? (mb / 1024).toLocaleString("es", { maximumFractionDigits: 1 }) + " GB" : Math.round(mb) + " MB"; };
// a map downloaded from the program is kept in pieces; put together they read as one file
const partKey = (m, i) => `mp|${m.id}|${i}`;
async function blobOf(m) {
  if (m.blob) return m.blob;
  const parts = [];
  for (let i = 0; i < m.parts; i++) { const b = await idb.get("kv", partKey(m, i)); if (!b) throw new Error("el mapa está a medio descargar"); parts.push(b); }
  return new Blob(parts);
}
async function dropMap(m) {
  for (let i = 0; i < (m.parts || 0); i++) await idb.del("kv", partKey(m, i)).catch(() => {});
  await idb.del("maps", m.id);
}

/* ---------- reading MBTiles / OsmAnd .sqlitedb ---------- */
let sqlP = null;
function sqlLib() {
  if (!sqlP) sqlP = new Promise((ok, ko) => {
    const s = document.createElement("script"); s.src = SQLJS + "sql-wasm.js";
    s.onload = () => window.initSqlJs({ locateFile: (f) => SQLJS + f }).then(ok, ko);
    s.onerror = () => { sqlP = null; ko(new Error("No se pudo cargar el lector de mapas (hace falta internet la primera vez).")); };
    document.head.append(s);
  });
  return sqlP;
}
const scripts = new Map();
function script(src) {
  if (!scripts.has(src)) scripts.set(src, new Promise((ok, ko) => {
    const s = document.createElement("script"); s.src = src; s.onload = ok;
    s.onerror = () => { scripts.delete(src); ko(new Error("No se pudo cargar el lector de mapas (hace falta internet la primera vez).")); };
    document.head.append(s);
  }));
  return scripts.get(src);
}

/* ---------- off-road map: OpenStreetMap vector data (the same OsmAnd uses) in a .pmtiles file ---------- */
// read straight from the file kept on this device, a piece at a time, so a big map never has to fit in memory
async function openPmtiles(blob, key) {
  await script(PMTILES_JS);
  const src = { getKey: () => key, getBytes: async (offset, length) => ({ data: await blob.slice(offset, offset + length).arrayBuffer() }) };
  const p = new window.pmtiles.PMTiles(src);
  const h = await p.getHeader();
  if (h.tileType < 1 || h.tileType > 5) throw new Error("no es un mapa .pmtiles que se pueda abrir");
  return { p, raster: h.tileType !== 1, minZoom: h.minZoom, maxZoom: h.maxZoom, bounds: [[h.minLat, h.minLon], [h.maxLat, h.maxLon]] };
}
function offroadStyle() {
  const P = window.protomapsL;
  const zw = (base, k = 1.35) => (z) => base * Math.pow(k, Math.max(0, z - 12)); // line width grows with zoom
  const kind = (...ks) => (z, f) => ks.includes(f.props.kind);
  const detail = (...ks) => (z, f) => ks.includes(f.props.kind_detail);
  const line = (o) => new P.LineSymbolizer(o), fillS = (c, op = 1) => new P.PolygonSymbolizer({ fill: c, opacity: op });
  const areas = (rules) => rules.map((r) => r.symbolizer instanceof P.PolygonSymbolizer ? { ...r, filter: ((fl) => (z, f) => f.geomType === 3 && (!fl || fl(z, f)))(r.filter) } : r);
  const paintRules = [
    { dataLayer: "earth", symbolizer: fillS("#efe4cf") },
    { dataLayer: "landcover", symbolizer: fillS("#e8dcc0"), filter: kind("barren", "desert") },
    { dataLayer: "landcover", symbolizer: fillS("#d9e2bf"), filter: kind("grassland", "scrub", "farmland") },
    { dataLayer: "landcover", symbolizer: fillS("#c4d6a4"), filter: kind("forest") },
    { dataLayer: "landuse", symbolizer: fillS("#f4e3b5"), filter: kind("sand", "beach", "desert", "bare_rock", "scree", "barren") },
    { dataLayer: "landuse", symbolizer: fillS("#dbe6bd"), filter: kind("farmland", "orchard", "meadow", "grassland", "scrub", "grass") },
    { dataLayer: "landuse", symbolizer: fillS("#c5d9a3"), filter: kind("forest", "wood", "nature_reserve", "national_park", "park") },
    { dataLayer: "landuse", symbolizer: fillS("#e2d6c3"), filter: kind("residential", "industrial", "commercial", "military", "cemetery", "school", "hospital") },
    // the water layer mixes areas and lines (rivers, wadis): fill only the areas
    { dataLayer: "water", symbolizer: fillS("#a9cbe3"), filter: (z, f) => f.geomType === 3 },
    { dataLayer: "water", symbolizer: line({ color: "#5d9bcf", width: zw(1.1), dash: [5, 3] }), filter: (z, f) => f.geomType === 2 && f.props.intermittent },
    { dataLayer: "water", symbolizer: line({ color: "#5d9bcf", width: zw(1.1) }), filter: (z, f) => f.geomType === 2 && !f.props.intermittent },
    { dataLayer: "buildings", symbolizer: fillS("#c9b79c", 0.9) },
    { dataLayer: "boundaries", symbolizer: line({ color: "#8a6aa8", width: 1.2, dash: [6, 4] }) },
    // tracks and paths: what matters off-road
    { dataLayer: "roads", symbolizer: line({ color: "#fff8e8", width: zw(2.6) }), filter: detail("track"), minzoom: 11 },
    { dataLayer: "roads", symbolizer: line({ color: "#8b4513", width: zw(1.6), dash: [6, 3] }), filter: detail("track"), minzoom: 9 },
    { dataLayer: "roads", symbolizer: line({ color: "#a0522d", width: zw(1), dash: [2, 3] }), filter: (z, f) => f.props.kind === "path" && f.props.kind_detail !== "track", minzoom: 12 },
    { dataLayer: "roads", symbolizer: line({ color: "#9b8a6d", width: zw(2.4) }), filter: kind("minor_road", "other"), minzoom: 10 },
    { dataLayer: "roads", symbolizer: line({ color: "#ffffff", width: zw(1.6) }), filter: kind("minor_road", "other"), minzoom: 10 },
    { dataLayer: "roads", symbolizer: line({ color: "#a86b1f", width: zw(3.2) }), filter: kind("major_road") },
    { dataLayer: "roads", symbolizer: line({ color: "#f6c45a", width: zw(2.2) }), filter: kind("major_road") },
    { dataLayer: "roads", symbolizer: line({ color: "#8c2f1d", width: zw(3.8) }), filter: kind("highway") },
    { dataLayer: "roads", symbolizer: line({ color: "#e05a3a", width: zw(2.8) }), filter: kind("highway") },
  ];
  const names = ["name:es", "name:fr", "name"];
  const labelRules = [
    { dataLayer: "places", symbolizer: new P.CenteredTextSymbolizer({ labelProps: names, fill: "#2b1d0e", stroke: "#fff8e8", width: 2.5, font: "600 13px sans-serif" }), filter: kind("locality", "region", "country") },
    { dataLayer: "water", symbolizer: new P.CenteredTextSymbolizer({ labelProps: names, fill: "#2f6a99", stroke: "#fff", width: 2, font: "italic 11px sans-serif" }), minzoom: 11 },
  ];
  return { paintRules: areas(paintRules), labelRules }; // no background: outside its area the map underneath must still show
}
// contour lines (curvas-*.pmtiles): brown, thicker every 100 m with its height written on it
const isContours = (m) => /^curvas/i.test(m.file || "");
// slopes (pendientes-*.pmtiles): pictures of the ground coloured by how steep it is, drawn over the maps
const isSlope = (m) => /^pendientes/i.test(m.file || "");
const isOverlay = (m) => isContours(m) || isSlope(m);
const SLOPE_KEY = [["#2ea043", "llano"], ["#78be3c", "5°"], ["#f0dc28", "10°"], ["#faaa1e", "15°"], ["#eb641e", "22°"], ["#d21e1e", "30°"], ["#821478", "45°"]];
// coloured by height, like a topographic map: green in the lowlands, then yellow, orange, red and purple on the peaks
const ELE_KEY = [[0, "#1f8a3c"], [400, "#7cb342"], [800, "#c9b81e"], [1200, "#e8901c"], [1700, "#d4471f"], [2300, "#a3203a"], [3000, "#6a1b7a"]];
const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
function eleColor(e) {
  e = +e || 0;
  let i = 0; while (i < ELE_KEY.length - 1 && e >= ELE_KEY[i + 1][0]) i++;
  if (i === ELE_KEY.length - 1) return ELE_KEY[i][1];
  const [e0, c0] = ELE_KEY[i], [e1, c1] = ELE_KEY[i + 1], k = (e - e0) / (e1 - e0), a = hex(c0), b = hex(c1);
  return "rgb(" + a.map((v, j) => Math.round(v + (b[j] - v) * k)).join(",") + ")";
}
function contourStyle(colored) {
  const P = window.protomapsL;
  const col = (brown) => colored ? (z, f) => eleColor(f.props.ele) : brown;
  return {
    paintRules: [
      { dataLayer: "contours", symbolizer: new P.LineSymbolizer({ color: col("#9c5a2b"), width: colored ? 0.9 : 0.7, opacity: colored ? 0.8 : 0.65 }), filter: (z, f) => !f.props.idx },
      { dataLayer: "contours", symbolizer: new P.LineSymbolizer({ color: col("#8b4513"), width: colored ? 1.8 : 1.5, opacity: 0.9 }), filter: (z, f) => !!f.props.idx },
    ],
    labelRules: [
      { dataLayer: "contours", symbolizer: new P.LineLabelSymbolizer({ labelProps: ["lbl"], fill: col("#6b3410"), stroke: "#fff8e8", width: 2.5, font: "600 11px sans-serif" }), filter: (z, f) => !!f.props.idx, minzoom: 10 },
    ],
  };
}

const one = (db, q, p) => { const st = db.prepare(q); st.bind(p || []); const r = st.step() ? st.get() : null; st.free(); return r; };
function mimeOf(b) {
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x52 && b[1] === 0x49) return "image/webp";
  return null;
}
const tile2lon = (x, z) => x / 2 ** z * 360 - 180;
const tile2lat = (y, z) => { const n = Math.PI - 2 * Math.PI * y / 2 ** z; return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); };

// returns { get(z, x, y) -> bytes, minZoom, maxZoom, bounds, mime }
export function openTiles(SQL, bytes) {
  const db = new SQL.Database(bytes);
  const tables = new Set((db.exec("select name from sqlite_master where type in ('table','view')")[0]?.values || []).map((r) => r[0]));
  let get, zr, toZoom, sample;
  if (tables.has("tiles") && tables.has("metadata")) { // MBTiles: TMS rows (y counted from the south)
    const meta = Object.fromEntries((db.exec("select name, value from metadata")[0]?.values || []));
    if (/pbf|mvt/i.test(meta.format || "")) throw new Error("es un mapa vectorial; hace falta uno de imágenes (raster)");
    get = (z, x, y) => one(db, "select tile_data from tiles where zoom_level=? and tile_column=? and tile_row=?", [z, x, 2 ** z - 1 - y])?.[0];
    zr = one(db, "select min(zoom_level), max(zoom_level) from tiles"); toZoom = (z) => z;
    const zm = zr[1], b = one(db, "select min(tile_column), max(tile_column), min(tile_row), max(tile_row) from tiles where zoom_level=?", [zm]);
    sample = { zm, x0: b[0], x1: b[1], y0: 2 ** zm - 1 - b[3], y1: 2 ** zm - 1 - b[2] };
  } else if (tables.has("tiles")) { // OsmAnd / BigPlanet: columns x, y, z, image
    let info = {};
    if (tables.has("info")) { const t = db.exec("select * from info limit 1")[0]; if (t && t.values.length) info = Object.fromEntries(t.columns.map((c, i) => [c.toLowerCase(), t.values[0][i]])); }
    const r = one(db, "select x, z from tiles limit 1");
    if (!r) throw new Error("no tiene teselas");
    // OsmAnd stores 17 - zoom ("BigPlanet") unless the file says "simple"
    const big = info.tilenumbering ? /bigplanet/i.test(info.tilenumbering) : !one(db, "select 1 from tiles where z > 17 limit 1");
    const inv = String(info.inverted_y || "0") === "1";
    toZoom = (z) => big ? 17 - z : z;
    const fromZoom = (z) => big ? 17 - z : z;
    get = (z, x, y) => one(db, "select image from tiles where x=? and y=? and z=?", [x, inv ? 2 ** z - 1 - y : y, fromZoom(z)])?.[0];
    const zs = one(db, "select min(z), max(z) from tiles");
    zr = [Math.min(toZoom(zs[0]), toZoom(zs[1])), Math.max(toZoom(zs[0]), toZoom(zs[1]))];
    const zm = zr[1], b = one(db, "select min(x), max(x), min(y), max(y) from tiles where z=?", [fromZoom(zm)]);
    sample = { zm, x0: b[0], x1: b[1], y0: inv ? 2 ** zm - 1 - b[3] : b[2], y1: inv ? 2 ** zm - 1 - b[2] : b[3] };
  } else throw new Error("no es un mapa MBTiles ni de OsmAnd");
  const first = one(db, tables.has("metadata") ? "select tile_data from tiles limit 1" : "select image from tiles limit 1")?.[0];
  const mime = first && mimeOf(first);
  if (!mime) throw new Error("las teselas no son imágenes (PNG/JPEG/WebP)");
  const { zm, x0, x1, y0, y1 } = sample;
  const bounds = [[tile2lat(y1 + 1, zm), tile2lon(x0, zm)], [tile2lat(y0, zm), tile2lon(x1 + 1, zm)]];
  return { get, minZoom: zr[0], maxZoom: zr[1], bounds, mime, close: () => db.close() };
}

// the off-road map kept on this device that covers a point (Morocco, Spain…), for the route planner; null if none
const orCache = new Map();
export async function offroadMap(at) {
  const maps = (await idb.all("maps")).filter((m) => /\.pmtiles$/i.test(m.file || "") && !isOverlay(m) && (m.blob || m.done));
  if (!maps.length) return null;
  const open = async (m) => { if (!orCache.has(m.id)) orCache.set(m.id, { id: m.id, name: m.name, ...(await openPmtiles(await blobOf(m), m.id)) }); return orCache.get(m.id); };
  let found = null;
  for (const m of maps) {
    const o = await open(m), [[s, w], [n, e]] = o.bounds;
    if (!at || (at[0] >= s && at[0] <= n && at[1] >= w && at[1] <= e)) { found = o; break; }
  }
  if (!found) return null;
  await script(PROTOMAPS_JS);
  return found;
}

/* ---------- the layers on the Leaflet map ---------- */
// zoomed in past what this device keeps (or what the server has): the tile of a lower zoom, stretched, instead of a blank square.
// Each tile is a canvas with its own piece of the lower tile (a stretched picture would be too big for the phone to draw)
const cropInto = (cv, img, coords, fb) => {
  const k = 2 ** fb, s = img.naturalWidth / k, sx = (coords.x - ((coords.x >> fb) << fb)) * s, sy = (coords.y - ((coords.y >> fb) << fb)) * s;
  const g = cv.getContext("2d"); g.imageSmoothingQuality = "high"; g.drawImage(img, sx, sy, s, s, 0, 0, cv.width, cv.height);
};
const tileCanvas = (T) => { const cv = document.createElement("canvas"), r = Math.min(2, window.devicePixelRatio || 1); cv.width = cv.height = Math.round(T * r); return cv; };
function overzoom(layer) {
  layer.createTile = function (coords, done) {
    // the tile is a box: the picture itself when the server or this device has it, a canvas with a stretched piece of a lower zoom when not
    const box = document.createElement("div"), T = this.getTileSize().x, zU = this._getZoomForUrl(), co = this.options.crossOrigin;
    const tryAt = (fb) => {
      const z = zU - fb; if (fb > 12 || z < 0) { done(new Error("sin imagen"), box); return; }
      const img = new Image(), x = coords.x >> fb, y = coords.y >> fb; img.alt = "";
      if (co || co === "") img.crossOrigin = co === true ? "" : co;
      img.onload = () => {
        if (fb) { const cv = tileCanvas(T); cropInto(cv, img, coords, fb); box.append(cv); } else box.append(img);
        done(null, box);
      };
      img.onerror = () => tryAt(fb + 1);
      img.src = L.Util.template(this._url, L.extend({ s: this._getSubdomain(coords), r: "", x, y, z }, this.options));
    };
    tryAt(0);
    return box;
  };
}
export function setupLayers(lmap) {
  const esri = "https://server.arcgisonline.com/ArcGIS/rest/services/";
  const co = { crossOrigin: "anonymous" };
  const bases = {
    osm: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { ...co, maxZoom: 19, attribution: "© colaboradores de OpenStreetMap" }),
    topo: L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", { ...co, maxZoom: 17, attribution: "© OpenStreetMap · estilo © OpenTopoMap (CC-BY-SA)" }),
    // Sentinel-2 cloudless: 10 m satellite that may be kept offline for non-commercial use (Esri's may not)
    s2: L.tileLayer(S2_URL, { ...co, maxNativeZoom: 14, maxZoom: 19, attribution: S2_ATTR }),
  };
  // «Satélite descargado»: Sentinel-2 everywhere, and over it the PNOA in Spain
  // (no crossOrigin: if the IGN doesn't allow reading its images, they are kept as they come and still drawn)
  const pnoa = SPAIN.map((bounds) => L.tileLayer(PNOA_URL, { maxNativeZoom: 18, maxZoom: 19, bounds, zIndex: 2, attribution: PNOA_ATTR }));
  const dlSat = [bases.s2, ...pnoa];
  bases.s2 = L.layerGroup(dlSat);
  const sat = L.layerGroup([
    // on sharp screens (phones, tablets, Mac) each tile is drawn at its real pixels from the next zoom level, like Google Maps,
    // instead of blown up and blurry; past zoom 19 Esri has no imagery in many places, so the last level is stretched
    L.tileLayer(esri + "World_Imagery/MapServer/tile/{z}/{y}/{x}", { ...co, detectRetina: true, maxZoom: 20, maxNativeZoom: 18, keepBuffer: 4, attribution: "Imágenes © Esri, Maxar, Earthstar Geographics" }),
    L.tileLayer(esri + "Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", { ...co, maxZoom: 19 }),
  ]);
  lmap.createPane("base", lmap._rotatePane).style.zIndex = 200;
  lmap.createPane("offline", lmap._rotatePane).style.zIndex = 250;
  lmap.createPane("sat", lmap._rotatePane).style.zIndex = 300;
  lmap.createPane("contours", lmap._rotatePane).style.zIndex = 320; // over the satellite too
  lmap.getPane("contours").style.pointerEvents = "none";
  lmap.createPane("slope", lmap._rotatePane).style.zIndex = 310; // over the satellite, under the contour lines
  lmap.getPane("slope").style.pointerEvents = "none"; lmap.getPane("slope").style.opacity = .7;
  Object.values(bases).forEach((l) => { l.options.pane = "base"; });
  lmap.createPane("s2", lmap._rotatePane).style.zIndex = 270; // the downloaded satellite goes over the off-road map, like Esri's
  dlSat.forEach((l) => { l.options.pane = "s2"; });
  sat.eachLayer((l) => { l.options.pane = "sat"; });

  const pref = (() => { try { return JSON.parse(localStorage.getItem("rally.layers")) || {}; } catch (e) { return {}; } })();
  const save = () => { try { localStorage.setItem("rally.layers", JSON.stringify(pref)); } catch (e) {} };
  if (!pref.base || pref.base === "none") pref.base = "osm"; if (pref.sat === undefined) pref.sat = true; if (pref.op === undefined) pref.op = 100; if (pref.cc === undefined) pref.cc = true; pref.on = pref.on || [];

  const msg = (t) => { $("lyMsg").textContent = t || ""; };
  const apply = () => {
    Object.entries(bases).forEach(([k, l]) => { if (k === pref.base) l.addTo(lmap); else l.remove(); });
    if (pref.sat) sat.addTo(lmap); else sat.remove();
    lmap.getPane("sat").style.opacity = pref.op / 100;
    $("lyBase").value = pref.base; $("lySat").checked = pref.sat; $("lyOp").value = pref.op; $("lyOp").disabled = !pref.sat;
    $("lyOpTxt").textContent = pref.op + " %";
  };
  $("lyBase").onchange = (e) => { pref.base = e.target.value; save(); apply(); };
  $("lySat").onchange = (e) => { pref.sat = e.target.checked; save(); apply(); };
  $("lyOp").oninput = (e) => { pref.op = +e.target.value; save(); apply(); };

  // offline maps
  const open = new Map(); // id -> { src, layer }
  const OfflineLayer = L.GridLayer.extend({
    createTile(c, done) {
      const cv = tileCanvas(this.getTileSize().x);
      let b = null, fb = 0;
      // a tile missing at this zoom: the nearest lower zoom kept, stretched
      for (; !b && fb <= 12 && c.z - fb >= 0; fb++) { try { b = this.options.src.get(c.z - fb, c.x >> fb, c.y >> fb); } catch (e) {} }
      fb--;
      if (!b) { setTimeout(() => done(null, cv), 0); return cv; }
      const url = URL.createObjectURL(new Blob([b], { type: this.options.src.mime })), img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); cropInto(cv, img, c, fb); done(null, cv); };
      img.onerror = () => { URL.revokeObjectURL(url); done(null, cv); };
      img.src = url; return cv;
    },
  });
  // a .pmtiles of pictures (the slopes), read a tile at a time from the file kept here
  const RasterPm = L.GridLayer.extend({
    createTile(c, done) {
      const img = document.createElement("img"); img.alt = "";
      this.options.src.p.getZxy(c.z, c.x, c.y).then((r) => {
        if (!r) { done(null, img); return; }
        const url = URL.createObjectURL(new Blob([r.data]));
        img.onload = img.onerror = () => { URL.revokeObjectURL(url); done(null, img); };
        img.src = url;
      }).catch(() => done(null, img));
      return img;
    },
  });
  // the satellite sits on top: with a tracks map just turned on, it goes off so the map is seen
  const satOff = () => { if (pref.sat) { pref.sat = false; save(); apply(); } };
  async function turnOn(m, fit) {
    if (open.has(m.id)) return open.get(m.id);
    msg(`Abriendo ${m.name}…`);
    let src, layer;
    if (/\.pmtiles$/i.test(m.file || "")) {
      src = await openPmtiles(await blobOf(m), m.id); await script(PROTOMAPS_JS);
      layer = isSlope(m)
        ? new RasterPm({ src, pane: "slope", minZoom: 0, maxZoom: 19, minNativeZoom: src.minZoom, maxNativeZoom: src.maxZoom, bounds: src.bounds, attribution: "Pendientes © Copernicus DEM" })
        : isContours(m)
        ? window.protomapsL.leafletLayer({ url: src.p, maxDataZoom: src.maxZoom, pane: "contours", bounds: src.bounds, attribution: "Curvas © Copernicus DEM", ...contourStyle(pref.cc) })
        : window.protomapsL.leafletLayer({ url: src.p, maxDataZoom: src.maxZoom, pane: "offline", bounds: src.bounds, attribution: "© colaboradores de OpenStreetMap · Protomaps", ...offroadStyle() });
      src.close = () => {};
    } else {
      const SQL = await sqlLib();
      src = openTiles(SQL, new Uint8Array(await m.blob.arrayBuffer()));
      layer = new OfflineLayer({ src, pane: "offline", minZoom: 0, maxZoom: 19, minNativeZoom: src.minZoom, maxNativeZoom: src.maxZoom, bounds: src.bounds });
    }
    layer.addTo(lmap); open.set(m.id, { src, layer });
    msg(`${m.name}: zoom ${src.minZoom}–${src.maxZoom}.` + (pref.sat && pref.op > 60 ? " Baja la transparencia del satélite o apágalo para verlo." : ""));
    if (fit) lmap.fitBounds(src.bounds);
    return open.get(m.id);
  }
  function turnOff(id) { const o = open.get(id); if (o) { o.layer.remove(); o.src.close(); open.delete(id); } }
  async function list() {
    const box = $("lyFiles"); box.textContent = "";
    let maps = [];
    try { maps = (await idb.all("maps")).filter((m) => m.blob || m.done); } catch (e) { msg("Este navegador no deja guardar mapas sin conexión."); return; }
    if (!maps.some((m) => /\.pmtiles$/i.test(m.file || "") && !isOverlay(m))) {
      const p = document.createElement("span"); p.className = "msg";
      p.textContent = "Este dispositivo aún no tiene el mapa de pistas (como OsmAnd): descárgalo aquí abajo junto con sus curvas de nivel y se verán juntos, sin internet.";
      box.append(p);
    }
    offerDownloads(maps);
    if (maps.length) { const t = document.createElement("span"); t.className = "lysub"; t.textContent = "Mapas guardados en este dispositivo"; box.append(t); }
    maps.sort((a, b) => a.name.localeCompare(b.name)).forEach((m) => {
      const l = document.createElement("label"); l.className = "mapcard";
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.className = "sw"; cb.checked = pref.on.includes(m.id);
      cb.onchange = async () => {
        pref.on = pref.on.filter((x) => x !== m.id); if (cb.checked) pref.on.push(m.id); save();
        if (cb.checked) { try { await turnOn(m, !isOverlay(m)); if (!isOverlay(m)) satOff(); } catch (e) { cb.checked = false; pref.on = pref.on.filter((x) => x !== m.id); save(); msg(`${m.name}: ${e.message}`); } }
        else { turnOff(m.id); msg(""); }
      };
      const rm = document.createElement("button"); rm.type = "button"; rm.className = "ghost x"; rm.textContent = "✕"; rm.title = "Quitar este mapa del dispositivo";
      rm.onclick = async (e) => {
        e.preventDefault();
        if (!confirm(`¿Quitar «${m.name}» de este dispositivo?`)) return;
        turnOff(m.id); pref.on = pref.on.filter((x) => x !== m.id); save(); await dropMap(m); list(); msg("");
      };
      const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = m.name;
      const sz = document.createElement("small"); sz.textContent = mbTxt(m.size); nm.append(sz);
      l.append(cb, nm, rm); box.append(l);
      if (isContours(m) && !box.querySelector(".cckey")) {
        const c = document.createElement("label"); c.className = "chk cc";
        const t = document.createElement("input"); t.type = "checkbox"; t.className = "sw"; t.id = "lyCc"; t.checked = pref.cc;
        t.onchange = async () => {
          pref.cc = t.checked; save(); k.hidden = !t.checked;
          // redraw the contour lines that are on with the new colours
          for (const x of maps) if (isContours(x) && open.has(x.id)) { turnOff(x.id); try { await turnOn(x, false); } catch (e) {} }
        };
        c.append(t, " Curvas de nivel por colores (según la altura)");
        const k = document.createElement("div"); k.className = "slopekey cckey"; k.hidden = !pref.cc;
        k.innerHTML = ELE_KEY.map(([e, col]) => `<span><i style="background:${col}"></i>${e ? e + " m" : "0"}</span>`).join("");
        box.append(c, k);
      }
      if (isSlope(m) && !box.querySelector(".slopekey:not(.cckey)")) {
        const k = document.createElement("div"); k.className = "slopekey";
        k.innerHTML = SLOPE_KEY.map(([c, t]) => `<span><i style="background:${c}"></i>${t}</span>`).join("");
        box.append(k);
      }
    });
    for (const m of maps) if (pref.on.includes(m.id)) { try { await turnOn(m, false); } catch (e) { msg(`${m.name}: ${e.message}`); } }
  }
  /* ---------- downloading the maps straight into this device ---------- */
  let catalog = null, downloading = null;
  async function offerDownloads(maps) {
    const box = $("lyDl"); if (!box) return;
    if (!catalog) { try { catalog = await (await fetch(PIECES + "mapas.json", { cache: "no-cache" })).json(); } catch (e) { box.textContent = ""; return; } }
    box.textContent = "";
    const missing = catalog.filter((c) => !maps.some((m) => m.file === c.file && (m.blob || m.done)));
    if (!missing.length) return;
    const t = document.createElement("span"); t.className = "lysub"; t.textContent = "Descargar en este dispositivo (con wifi)"; box.append(t);
    if (missing.length > 1) {
      const all = document.createElement("button"); all.type = "button"; all.className = "hl dl"; all.disabled = !!downloading;
      all.innerHTML = `<b>⬇</b><span class="nm">Todo<small>${mbTxt(missing.reduce((t, c) => t + c.size, 0))}</small></span>`;
      all.onclick = async () => { for (const c of missing) { if (!(await download(c))) return; } msg("Todos los mapas y curvas están en este dispositivo: funcionan sin internet."); };
      box.append(all);
    }
    missing.forEach((c) => {
      const b = document.createElement("button"); b.type = "button"; b.className = "ghost dl";
      b.innerHTML = `<b>⬇</b><span class="nm"></span>`; b.querySelector(".nm").textContent = c.name;
      const sz = document.createElement("small"); sz.textContent = mbTxt(c.size); b.querySelector(".nm").append(sz);
      b.disabled = !!downloading;
      b.onclick = () => download(c);
      box.append(b);
    });
  }
  async function download(c) {
    if (downloading) return;
    if (!navigator.onLine) { msg("Para descargar el mapa hace falta internet (mejor con wifi)."); return; }
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const e = await navigator.storage.estimate();
        if (e.quota && e.quota - e.usage < c.size * 1.1) { msg(`No hay sitio: «${c.name}» ocupa ${Math.round(c.size / 1048576)} MB y quedan ${Math.round((e.quota - e.usage) / 1048576)} MB libres para el navegador.`); return; }
      }
      if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
    } catch (e) {}
    const m = { id: "dl|" + c.id, name: c.name, file: c.file, size: c.size, parts: c.parts, added: Date.now(), done: false };
    downloading = m; list(); msg(`Descargando ${c.name}…`);
    try {
      await idb.put("maps", m);
      for (let i = 0; i < c.parts; i++) {
        // pieces already here (a download cut halfway) are not downloaded again
        if (!(await idb.get("kv", partKey(m, i)))) {
          const res = await fetch(PIECES + c.file + "." + String(i).padStart(3, "0"), { cache: "no-store" });
          if (!res.ok) throw new Error(`error ${res.status} al descargar`);
          await idb.put("kv", await res.blob(), partKey(m, i));
        }
        msg(`Descargando ${c.name}: ${Math.round((i + 1) / c.parts * 100)} % · no cierres la página`);
      }
      await openPmtiles(await blobOf(m), "check");
      m.done = true; await idb.put("maps", m);
      if (!pref.on.includes(m.id)) pref.on.push(m.id); save();
      downloading = null; await list();
      if (!isOverlay(m)) satOff();
      msg(`«${c.name}» ya está en este dispositivo: funciona sin internet. Lo enciendes y apagas con su casilla.`);
      return true;
    } catch (e) {
      downloading = null; list();
      msg(`No se pudo terminar «${c.name}»: ${e.message}. Vuelve a tocar el botón y seguirá donde se quedó.`);
    }
  }
  const say = (t) => { msg(t); const m = $("mapImpMsg"); if (m) m.textContent = t; };
  async function importMaps(files) {
    const msg = say;
    for (const f of files) {
      if (/\.rmap$/i.test(f.name)) { msg(`${f.name}: los .rmap de TwoNav no se pueden abrir en el navegador; pásalo a MBTiles.`); continue; }
      msg(`Comprobando ${f.name}…`);
      try {
        if (/\.pmtiles$/i.test(f.name)) await openPmtiles(f, "check");
        else { const SQL = await sqlLib(); openTiles(SQL, new Uint8Array(await f.arrayBuffer())).close(); }
        const m = { id: f.name + "|" + f.size, name: f.name.replace(/\.(mbtiles|sqlitedb|sqlite|db|pmtiles)$/i, ""), file: f.name, size: f.size, added: Date.now(), blob: f };
        await idb.put("maps", m);
        if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
        if (!pref.on.includes(m.id)) pref.on.push(m.id); save();
        await list(); turnOff(m.id); await turnOn(m, !isOverlay(m)); if (!isOverlay(m)) satOff();
        msg(`Guardado ${m.name} en este dispositivo: funciona sin internet. Lo encienden y apagan las casillas encima del mapa.` + (isOverlay(m) ? "" : " He apagado el satélite para que se vea; vuelve a marcarlo si lo quieres encima."));
      } catch (er) { msg(`${f.name}: ${/not a database|malformed/i.test(er.message) ? "no es un archivo de mapa válido" : er.message}`); }
    }
  }
  document.querySelectorAll("input.mapfile").forEach((inp) => inp.addEventListener("change", (e) => { const f = [...e.target.files]; e.target.value = ""; importMaps(f); }));
  ["orDrop"].forEach((id) => {
    const d = $(id); if (!d) return;
    d.addEventListener("dragover", (e) => { e.preventDefault(); d.classList.add("over"); });
    d.addEventListener("dragleave", () => d.classList.remove("over"));
    d.addEventListener("drop", (e) => { e.preventDefault(); d.classList.remove("over"); importMaps([...e.dataTransfer.files]); });
  });
  // without a connection the online maps only show what this device already keeps (no data spent, no waiting)
  const online = [...Object.values(bases).filter((l) => l.setUrl), ...dlSat, ...sat.getLayers()];
  online.forEach((l) => { l.options.home = l._url; overzoom(l); });
  function setOffline(on) {
    online.forEach((l) => { const u = on ? l.options.home + (l.options.home.includes("?") ? "&" : "?") + "lr_off=1" : l.options.home; if (l._url !== u) l.setUrl(u); });
  }
  // turns on the off-road map kept here that covers where I am
  async function coverHere(at) {
    let o = null; try { o = await offroadMap(at); } catch (e) {}
    if (!o) return "Sin conexión, pero no tienes guardado el mapa de esta zona: con internet, descárgalo en este menú, en «Mapas». Solo verás lo que ya hayas visto antes.";
    if (!pref.on.includes(o.id)) { pref.on.push(o.id); save(); await list(); }
    return `Sin conexión: uso el mapa «${o.name}» guardado en el dispositivo y el satélite que ya hayas visto antes.`;
  }
  /* ---------- satellite of a chosen zone, kept on this device ---------- */
  let zoning = false;
  const zones = async () => { try { return (await idb.get("kv", "zones")) || []; } catch (e) { return []; } };
  async function renderZones() {
    const box = $("lyZones"); if (!box) return;
    box.textContent = "";
    const t = document.createElement("span"); t.className = "lysub"; t.textContent = "Satélite sin conexión"; box.append(t);
    for (const z of await zones()) {
      const c = document.createElement("div"); c.className = "mapcard zone";
      const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = z.name;
      const sm = document.createElement("small"); sm.textContent = `${Math.round(z.km2).toLocaleString("es")} km² · ${z.src === "pnoa" ? "PNOA hasta zoom " + z.z1 : "Sentinel-2, 10 m"} · ${mbTxt(z.bytes)}`; nm.append(sm);
      nm.onclick = () => { lmap.fitBounds(z.b); pref.base = "s2"; save(); apply(); };
      const rm = document.createElement("button"); rm.type = "button"; rm.className = "ghost x"; rm.textContent = "✕"; rm.title = "Quitar esta zona del dispositivo";
      rm.onclick = async () => { if (!confirm(`¿Quitar «${z.name}» de este dispositivo?`)) return; await dropZone(z); };
      c.append(nm, rm); box.append(c);
    }
    const b = document.createElement("button"); b.type = "button"; b.className = "ghost dl"; b.disabled = zoning;
    b.innerHTML = '<b>🛰️</b><span class="nm">Descargar el satélite de lo que ves<small>con wifi · en España, nítido (PNOA); fuera, 10 m (Sentinel-2)</small></span>';
    b.onclick = downloadZone; box.append(b);
  }
  async function downloadZone() {
    if (zoning) return;
    if (!("caches" in window)) { msg("Este navegador no deja guardar el satélite."); return; }
    if (!navigator.onLine) { msg("Para descargar el satélite hace falta internet (mejor con wifi)."); return; }
    const bb = lmap.getBounds(), b = [[bb.getSouth(), bb.getWest()], [bb.getNorth(), bb.getEast()]];
    const plan = zonePlan(b), urls = plan.urls;
    const km2 = (b[1][0] - b[0][0]) * 111.32 * (b[1][1] - b[0][1]) * 111.32 * Math.cos((b[0][0] + b[1][0]) / 2 * Math.PI / 180);
    if (urls.length > MAX_ZONE) { msg(`La zona es muy grande (${Math.round(km2).toLocaleString("es")} km²). Acerca el mapa a la zona que quieras, como mucho unos 80 × 80 km, y vuelve a tocar el botón.`); return; }
    const what = plan.src === "pnoa" ? `la ortofoto PNOA (nítida hasta el zoom ${plan.z1})` : "el satélite Sentinel-2 (10 m por píxel: fuera de España no hay uno más nítido que se pueda guardar)";
    if (!confirm(`¿Descargar ${what} de ${Math.round(km2).toLocaleString("es")} km²? Son ${urls.length} imágenes, unos ${Math.max(1, Math.round(urls.length * (plan.src === "pnoa" ? 0.03 : 0.02)))} MB.`)) return;
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}
    zoning = true; renderZones();
    const cache = await caches.open(ZONES);
    let done = 0, bytes = 0, fails = 0, i = 0, opaque = false, corsFails = 0;
    const one = async (url) => {
      if (await cache.match(url)) return;
      for (let t = 0; t < 4; t++) {
        try {
          if (opaque) { const res = await fetch(url, { mode: "no-cors" }); await cache.put(url, res); bytes += 30000; return; }
          const res = await fetch(url, { mode: "cors" });
          if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 1500 * (t + 1))); continue; }
          if (!res.ok) { fails++; return; } // no image there (sea, outside the layer)
          const blob = await res.blob(); bytes += blob.size;
          await cache.put(url, new Response(blob, { headers: { "content-type": "image/jpeg" } }));
          return;
        } catch (e) {
          // the IGN may not let a page read its images: they are kept as they come, the map can still draw them
          if (plan.src === "pnoa" && !opaque && ++corsFails >= 3) { opaque = true; continue; }
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      fails++;
    };
    const worker = async () => { while (i < urls.length) { await one(urls[i++]); done++; if (done % 25 === 0 || done === urls.length) msg(`Descargando el satélite: ${Math.round(done / urls.length * 100)} % · no cierres la página`); } };
    await Promise.all([worker(), worker(), worker()]);
    zoning = false;
    if (fails > urls.length * 0.5) { msg("No se pudo descargar el satélite de esta zona. Inténtalo más tarde con wifi."); renderZones(); return; }
    const d = new Date(), list = await zones();
    list.push({ id: d.getTime(), name: `Zona ${list.length + 1} · ${d.toLocaleDateString("es", { day: "2-digit", month: "2-digit" })}`, b, km2, n: urls.length, bytes, src: plan.src, z1: plan.z1 });
    await idb.put("kv", list, "zones");
    // the Esri satellite stays on: with internet it is seen on top, without it the downloaded one shows underneath
    pref.base = "s2"; save(); apply(); renderZones();
    msg(`Guardado en este dispositivo (${mbTxt(bytes)}). Sin internet se ve nítido hasta el zoom ${plan.z1}. En «Caminos» queda «Satélite descargado», debajo del satélite de siempre.`);
  }
  async function dropZone(z) {
    const list = (await zones()).filter((x) => x.id !== z.id), keep = new Set(list.flatMap(zoneUrls));
    const cache = await caches.open(ZONES);
    for (const u of zoneUrls(z)) if (!keep.has(u)) await cache.delete(u);
    await idb.put("kv", list, "zones"); renderZones(); msg(`«${z.name}» quitada de este dispositivo.`);
  }
  apply(); list(); renderZones();
  return { setOffline, coverHere };
}
