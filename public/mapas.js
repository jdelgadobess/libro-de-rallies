// Map layers: OpenStreetMap roads and tracks underneath, satellite on top (it can be made transparent or switched off),
// and offline map files (MBTiles, or the .sqlitedb that OsmAnd saves) kept on this device so they work without internet.
const SQLJS = "https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/";
const PMTILES_JS = "https://cdn.jsdelivr.net/npm/pmtiles@4.4.1/dist/pmtiles.js";
const PROTOMAPS_JS = "https://cdn.jsdelivr.net/npm/protomaps-leaflet@5.1.0/dist/protomaps-leaflet.js";
export const OFFROAD_URL = "https://github.com/jdelgadobess/libro-de-rallies/releases/download/mapa-marruecos/marruecos.pmtiles";
export const OFFROAD_ES_URL = "https://github.com/jdelgadobess/libro-de-rallies/releases/download/mapa-espana/espana.pmtiles";
const $ = (id) => document.getElementById(id);

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
  if (h.tileType !== 1) throw new Error("no es un mapa vectorial de Protomaps");
  return { p, minZoom: h.minZoom, maxZoom: h.maxZoom, bounds: [[h.minLat, h.minLon], [h.maxLat, h.maxLon]] };
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
  const maps = (await idb.all("maps")).filter((m) => /\.pmtiles$/i.test(m.file || ""));
  if (!maps.length) return null;
  const open = async (m) => { if (!orCache.has(m.id)) orCache.set(m.id, { id: m.id, name: m.name, ...(await openPmtiles(m.blob, m.id)) }); return orCache.get(m.id); };
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
export function setupLayers(lmap) {
  const esri = "https://server.arcgisonline.com/ArcGIS/rest/services/";
  const co = { crossOrigin: "anonymous" };
  const bases = {
    osm: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { ...co, maxZoom: 19, attribution: "© colaboradores de OpenStreetMap" }),
    topo: L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", { ...co, maxZoom: 17, attribution: "© OpenStreetMap · estilo © OpenTopoMap (CC-BY-SA)" }),
  };
  const sat = L.layerGroup([
    L.tileLayer(esri + "World_Imagery/MapServer/tile/{z}/{y}/{x}", { ...co, maxZoom: 19, attribution: "Imágenes © Esri, Maxar, Earthstar Geographics" }),
    L.tileLayer(esri + "Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", { ...co, maxZoom: 19 }),
  ]);
  lmap.createPane("base").style.zIndex = 200;
  lmap.createPane("offline").style.zIndex = 250;
  lmap.createPane("sat").style.zIndex = 300;
  Object.values(bases).forEach((l) => { l.options.pane = "base"; });
  sat.eachLayer((l) => { l.options.pane = "sat"; });

  const pref = (() => { try { return JSON.parse(localStorage.getItem("rally.layers")) || {}; } catch (e) { return {}; } })();
  const save = () => { try { localStorage.setItem("rally.layers", JSON.stringify(pref)); } catch (e) {} };
  pref.base = pref.base || "osm"; if (pref.sat === undefined) pref.sat = true; if (pref.op === undefined) pref.op = 100; pref.on = pref.on || [];

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
      const img = document.createElement("img"); img.alt = "";
      let b = null; try { b = this.options.src.get(c.z, c.x, c.y); } catch (e) {}
      if (!b) { setTimeout(() => done(null, img), 0); return img; }
      const url = URL.createObjectURL(new Blob([b], { type: this.options.src.mime }));
      img.onload = img.onerror = () => { URL.revokeObjectURL(url); done(null, img); };
      img.src = url; return img;
    },
  });
  // the satellite sits on top: with a tracks map just turned on, it goes off so the map is seen
  const satOff = () => { if (pref.sat) { pref.sat = false; save(); apply(); } };
  async function turnOn(m, fit) {
    if (open.has(m.id)) return open.get(m.id);
    msg(`Abriendo ${m.name}…`);
    let src, layer;
    if (/\.pmtiles$/i.test(m.file || "")) {
      src = await openPmtiles(m.blob, m.id); await script(PROTOMAPS_JS);
      layer = window.protomapsL.leafletLayer({ url: src.p, maxDataZoom: src.maxZoom, pane: "offline", bounds: src.bounds, attribution: "© colaboradores de OpenStreetMap · Protomaps", ...offroadStyle() });
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
    try { maps = await idb.all("maps"); } catch (e) { msg("Este navegador no deja guardar mapas sin conexión."); return; }
    if (!maps.some((m) => /\.pmtiles$/i.test(m.file || ""))) {
      const p = document.createElement("span"); p.className = "msg";
      p.textContent = "Este dispositivo aún no tiene el mapa de pistas (como OsmAnd). Descárgalo e impórtalo en el paso 3, en «Importar mapa off-road».";
      box.append(p);
    }
    maps.sort((a, b) => a.name.localeCompare(b.name)).forEach((m) => {
      const l = document.createElement("label"); l.className = "chk";
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = pref.on.includes(m.id);
      cb.onchange = async () => {
        pref.on = pref.on.filter((x) => x !== m.id); if (cb.checked) pref.on.push(m.id); save();
        if (cb.checked) { try { await turnOn(m, true); satOff(); } catch (e) { cb.checked = false; pref.on = pref.on.filter((x) => x !== m.id); save(); msg(`${m.name}: ${e.message}`); } }
        else { turnOff(m.id); msg(""); }
      };
      const rm = document.createElement("button"); rm.type = "button"; rm.className = "ghost x"; rm.textContent = "✕"; rm.title = "Quitar este mapa del dispositivo";
      rm.onclick = async (e) => {
        e.preventDefault();
        if (!confirm(`¿Quitar «${m.name}» de este dispositivo?`)) return;
        turnOff(m.id); pref.on = pref.on.filter((x) => x !== m.id); save(); await idb.del("maps", m.id); list(); msg("");
      };
      l.append(cb, ` ${m.name} (${(m.size / 1048576).toFixed(0)} MB)`, rm); box.append(l);
    });
    for (const m of maps) if (pref.on.includes(m.id)) { try { await turnOn(m, false); } catch (e) { msg(`${m.name}: ${e.message}`); } }
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
        await list(); turnOff(m.id); await turnOn(m, true); satOff();
        msg(`Guardado ${m.name} en este dispositivo: funciona sin internet. Lo encienden y apagan las casillas encima del mapa. He apagado el satélite para que se vea; vuelve a marcarlo si lo quieres encima.`);
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
  apply(); list();
}
