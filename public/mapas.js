// Map layers: OpenStreetMap roads and tracks underneath, satellite on top (it can be made transparent or switched off),
// and offline map files (MBTiles, or the .sqlitedb that OsmAnd saves) kept on this device so they work without internet.
const SQLJS = "https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/";
const $ = (id) => document.getElementById(id);

/* ---------- IndexedDB: offline maps and the last copy of the data ---------- */
let dbp = null;
function idbOpen() {
  if (!dbp) dbp = new Promise((ok, ko) => {
    const rq = indexedDB.open("libro-de-rallies", 1);
    rq.onupgradeneeded = () => { rq.result.createObjectStore("maps", { keyPath: "id" }); rq.result.createObjectStore("kv"); };
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
  async function turnOn(m, fit) {
    if (open.has(m.id)) return open.get(m.id);
    msg(`Abriendo ${m.name}…`);
    const SQL = await sqlLib();
    const src = openTiles(SQL, new Uint8Array(await m.blob.arrayBuffer()));
    const layer = new OfflineLayer({ src, pane: "offline", minZoom: 0, maxZoom: 19, minNativeZoom: src.minZoom, maxNativeZoom: src.maxZoom, bounds: src.bounds });
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
    maps.sort((a, b) => a.name.localeCompare(b.name)).forEach((m) => {
      const l = document.createElement("label"); l.className = "chk";
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = pref.on.includes(m.id);
      cb.onchange = async () => {
        pref.on = pref.on.filter((x) => x !== m.id); if (cb.checked) pref.on.push(m.id); save();
        if (cb.checked) { try { await turnOn(m, true); } catch (e) { cb.checked = false; pref.on = pref.on.filter((x) => x !== m.id); save(); msg(`${m.name}: ${e.message}`); } }
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
  $("lyFile").addEventListener("change", async (e) => {
    const files = [...e.target.files]; e.target.value = "";
    for (const f of files) {
      msg(`Comprobando ${f.name}…`);
      try {
        const SQL = await sqlLib();
        const src = openTiles(SQL, new Uint8Array(await f.arrayBuffer())); src.close();
        const m = { id: f.name + "|" + f.size, name: f.name.replace(/\.(mbtiles|sqlitedb|sqlite|db)$/i, ""), size: f.size, added: Date.now(), blob: f };
        await idb.put("maps", m);
        if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
        if (!pref.on.includes(m.id)) pref.on.push(m.id); save();
        await list(); turnOff(m.id); await turnOn(m, true);
        msg(`Guardado ${m.name} en este dispositivo: funciona sin internet.` + (pref.sat ? " Apaga el satélite o hazlo transparente para verlo." : ""));
      } catch (er) { msg(`${f.name}: ${/not a database|malformed/i.test(er.message) ? "no es un archivo de mapa válido" : er.message}`); }
    }
  });
  apply(); list();
}
