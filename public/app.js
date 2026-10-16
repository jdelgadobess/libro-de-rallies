import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm";

const CFG = window.APP_CONFIG;
const sb = createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);

// database rows <-> the shape the page works with
const rallyIn = (r) => ({ id: r.id, year: r.year, name: r.name, created: r.created_at });
const wpIn = (r) => ({ id: r.id, rallyId: r.rally_id, stage: r.stage, name: r.name, lat: r.lat, lon: r.lon, page: r.page, desc: r.descr, seq: r.seq, created: r.created_at });
const trackIn = (r) => ({ id: r.id, rallyId: r.rally_id, stage: r.stage, name: r.name, segs: r.points, created: r.created_at });
const wpOut = (w) => {
  const o = { rally_id: w.rallyId, stage: w.stage, name: w.name, lat: w.lat, lon: w.lon, page: w.page, descr: w.desc };
  if (w.seq !== undefined) o.seq = w.seq;
  if (w.source) o.source = w.source;
  if (w.by) o.created_by = w.by;
  return o;
};
const must = ({ data, error }) => { if (error) throw error; return data; };

const $ = (id) => document.getElementById(id);
const PALETTE = ["#c1272d", "#2f4fb5", "#006233", "#e3a21a", "#b5532c", "#1b8a8a", "#7a3b8f", "#d9662b", "#4f7f2a", "#8c1d40"];
const state = { user: null, role: null, rallies: [], wps: [], tracks: [], rallyId: null, stageFilter: "all", hi: null, fmt: "dm", photos: [], pending: null, reading: false };
let channel = null, bootedFor;
const canEdit = () => state.role === "admin" || state.role === "editor";

try { state.fmt = localStorage.getItem("rally.fmt") || "dm"; $("padNums").checked = localStorage.getItem("rally.pad") === "1"; } catch (e) {}
$("fmt").value = state.fmt;

/* ---------- coordinates ---------- */
function parseCoord(raw, isLat) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number") return (isLat ? Math.abs(raw) <= 90 : Math.abs(raw) <= 180) ? Math.round(raw * 1e6) / 1e6 : null;
  const s = String(raw).trim().toUpperCase();
  const neg = /^-/.test(s) || /[SWO]/.test(s);
  const nums = (s.match(/\d+(?:[.,]\d+)?/g) || []).map((n) => parseFloat(n.replace(",", ".")));
  if (!nums.length || nums.length > 3) return null;
  if (nums.length >= 2 && (nums[1] >= 60 || (nums[2] || 0) >= 60)) return null;
  let v = nums[0] + (nums[1] || 0) / 60 + (nums[2] || 0) / 3600;
  if (neg) v = -v;
  if (isLat ? Math.abs(v) > 90 : Math.abs(v) > 180) return null;
  return Math.round(v * 1e6) / 1e6;
}
function fmtCoord(v, isLat, mode) {
  if (mode === "dd") return v.toFixed(6);
  const h = isLat ? (v < 0 ? "S" : "N") : (v < 0 ? "W" : "E");
  const a = Math.abs(v); let d = Math.floor(a); const m = (a - d) * 60;
  if (mode === "dms") {
    let mi = Math.floor(m), sec = Math.round((m - mi) * 600) / 10;
    if (sec >= 60) { sec = 0; mi++; } if (mi >= 60) { mi = 0; d++; }
    return `${d}°${String(mi).padStart(2, "0")}'${sec.toFixed(1).padStart(4, "0")}"${h}`;
  }
  let mm = Math.round(m * 1000) / 1000; if (mm >= 60) { mm = 0; d++; }
  return `${d}°${mm.toFixed(3).padStart(6, "0")}'${h}`;
}

/* ---------- derived data ---------- */
const rallyById = (id) => state.rallies.find((r) => r.id === id);
const rally = () => rallyById(state.rallyId);
const natural = (a, b) => String(a).localeCompare(String(b), "es", { numeric: true });
const ralliesSorted = () => state.rallies.slice().sort((a, b) => b.year - a.year || natural(a.name, b.name));
const stageKey = (w) => (w.stage === undefined || w.stage === null || w.stage === "") ? "" : String(w.stage);
const stageLabel = (k) => k === "" ? "Sin etapa" : "Etapa " + k;
const rallyWps = () => state.wps.filter((w) => w.rallyId === state.rallyId && Number.isFinite(w.lat) && Number.isFinite(w.lon));
const stagesOf = (list) => [...new Set(list.map(stageKey))].sort((a, b) => (a === "") - (b === "") || natural(a, b));
const rallyTracks = () => state.tracks.filter((t) => t.rallyId === state.rallyId);
const allStages = () => stagesOf([...rallyWps(), ...rallyTracks()]);
const visibleTracks = () => filt.tracks ? rallyTracks().filter((t) => state.stageFilter === "all" || stageKey(t) === state.stageFilter) : [];
const stageColor = (s) => PALETTE[(allStages().indexOf(s) + PALETTE.length) % PALETTE.length];
// roadbook order: DSS first, then by the number in the name (WP2 before WP10), ASS last; ties by reading order
function orderKey(w) {
  const n = String(w.name || "").toUpperCase().trim();
  if (/^(DSS|START|SALIDA|DEPART)/.test(n)) return -1;
  if (/^(ASS|FIN|LLEGADA|ARRIV)/.test(n)) return 1e9;
  const m = n.match(/\d+/); return m ? parseInt(m[0], 10) : 5e8;
}
const seqOf = (w) => typeof w.seq === "number" ? w.seq : Date.parse(w.created || 0) || 0;
const wpOrder = (a, b) => ((stageKey(a) === "") - (stageKey(b) === "")) || natural(stageKey(a), stageKey(b)) || (orderKey(a) - orderKey(b)) || (seqOf(a) - seqOf(b)) || natural(a.name, b.name);
// table filters: stage, text, WP number range; the per-row tick decides what goes to the map
const filt = { text: "", from: null, to: null, tracks: true, off: new Set() };
const textOf = (w) => [w.name, w.page && "pág " + w.page, w.desc].filter(Boolean).join(" ").toLowerCase();
const visibleWps = () => rallyWps().filter((w) => {
  if (state.stageFilter !== "all" && stageKey(w) !== state.stageFilter) return false;
  const n = orderKey(w);
  if (filt.from !== null && n < filt.from) return false;
  if (filt.to !== null && n > filt.to) return false;
  return !filt.text || filt.text.split(",").map((t) => t.trim()).filter(Boolean).some((t) => textOf(w).includes(t));
}).sort(wpOrder);
const mapWps = () => visibleWps().filter((w) => !filt.off.has(w.id));
const scopeLabel = () => { const r = rally(); return r ? r.year + " · " + (state.stageFilter === "all" ? "todas las etapas" : stageLabel(state.stageFilter)) : ""; };
const currentStage = () => { const v = $("stageNo").value.trim(); return v === "" ? "" : String(parseInt(v, 10)); };

function showNotice(t) { $("notice").textContent = t || ""; $("notice").hidden = !t; }
function writeErr(e) {
  return e && e.code === "42501" ? "No tienes permiso para guardar." : "No se pudo guardar (" + (e && (e.code || e.message) || "error") + "). Inténtalo de nuevo.";
}

/* ---------- sign-in and access ---------- */
$("login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { error } = await sb.auth.signInWithPassword({ email: $("lEmail").value.trim().toLowerCase(), password: $("lPass").value });
  if (error) $("gateText").textContent = /invalid/i.test(error.message) ? "Correo o contraseña incorrectos." : "No se pudo entrar (" + error.message + ").";
  else $("lPass").value = "";
});
$("passBtn").onclick = async () => {
  const p = prompt("Escribe tu nueva contraseña (mínimo 8 caracteres):");
  if (p == null) return;
  if (p.length < 8) { alert("Tiene que tener al menos 8 caracteres."); return; }
  const { error } = await sb.auth.updateUser({ password: p });
  alert(error ? "No se pudo cambiar (" + error.message + ")." : "Contraseña cambiada.");
};
$("logout").onclick = () => sb.auth.signOut();
$("claim").onclick = async () => {
  const { error } = await sb.from("site_owner").insert({ email: state.user.email });
  if (error) { $("gateText").textContent = "Otra persona ya es la administradora de esta web."; return; }
  bootedFor = undefined; boot(state.user);
};

function gate(title, text, { login = false, claim = false } = {}) {
  $("gate").hidden = false; $("app").hidden = true;
  $("gateTitle").textContent = title; $("gateText").textContent = text;
  $("login").hidden = !login; $("claim").hidden = !claim;
}

async function roleFor() {
  const { data: role } = await sb.rpc("my_role");
  if (role) return role;
  const { data: owner } = await sb.from("site_owner").select("id").limit(1);
  return owner && owner.length ? null : "unclaimed";
}

// boot once per signed-in person (token refreshes fire this too)
sb.auth.onAuthStateChange((_ev, session) => {
  const user = session ? session.user : null;
  if ((user && user.id) === bootedFor) return;
  bootedFor = user && user.id;
  setTimeout(() => boot(user), 0);
});

async function loadAll() {
  try {
    const [r, w, t] = await Promise.all([sb.from("rallies").select("*"), sb.from("waypoints").select("*").range(0, 9999), sb.from("tracks").select("*")]);
    state.rallies = must(r).map(rallyIn); state.wps = must(w).map(wpIn); state.tracks = must(t).map(trackIn); showNotice(""); render();
  } catch (e) { showNotice("No se pudo leer el registro (" + (e.code || e.message) + ")."); }
}
let reloadTimer;
const reloadSoon = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(loadAll, 300); };
async function loadMembers() {
  const { data, error } = await sb.from("members").select("*");
  if (!error) renderMembers(data.map((m) => ({ id: m.email, role: m.role })));
}
async function loadFeed() {
  const { data } = await sb.from("earth_feed").select("token").maybeSingle();
  renderFeed(data ? data.token : null);
}

async function boot(user) {
  if (channel) { sb.removeChannel(channel); channel = null; }
  state.user = user; state.role = null;
  $("userbar").hidden = !user;
  if (!user) { gate("Entrar", "Entra con tu correo y tu contraseña.", { login: true }); return; }
  $("uName").textContent = user.email; $("uPhoto").hidden = true;
  const role = await roleFor();
  if (role === "unclaimed") { gate("Web nueva", "Nadie administra todavía esta web. Si es tuya, pulsa el botón y serás el administrador.", { claim: true }); return; }
  if (!role) { gate("Sin acceso", `Tu cuenta (${user.email}) no tiene acceso. Pide al administrador que te dé permiso.`); return; }
  state.role = role;
  $("gate").hidden = true; $("app").hidden = false;
  document.body.classList.toggle("viewer-only-hide", !canEdit());
  $("adminPanel").hidden = role !== "admin";
  // changes made by anyone show up for everyone with the page open
  channel = sb.channel("libro")
    .on("postgres_changes", { event: "*", schema: "public", table: "rallies" }, reloadSoon)
    .on("postgres_changes", { event: "*", schema: "public", table: "waypoints" }, reloadSoon)
    .on("postgres_changes", { event: "*", schema: "public", table: "tracks" }, reloadSoon)
    .subscribe();
  await loadAll();
  if (role === "admin") { loadMembers(); loadFeed(); }
  else $("feedUrl").textContent = "El administrador puede crear y compartir este enlace.";
  loadMaps();
}

/* ---------- render ---------- */
function render() {
  if (state.rallyId && !rally()) state.rallyId = null;
  if (!state.rallyId && state.rallies.length) state.rallyId = ralliesSorted()[0].id;
  const r = rally();

  $("stYears").textContent = new Set(state.rallies.map((x) => x.year)).size;
  $("stStages").textContent = new Set([...state.wps, ...state.tracks].filter((w) => stageKey(w) !== "").map((w) => w.rallyId + "|" + stageKey(w))).size;
  $("stWps").textContent = state.wps.length;

  const yc = $("years"); yc.textContent = "";
  ralliesSorted().forEach((x) => {
    const b = document.createElement("button"); b.type = "button"; b.className = "chip";
    b.setAttribute("aria-pressed", String(x.id === state.rallyId));
    b.textContent = String(x.year) + (state.rallies.filter((o) => o.year === x.year).length > 1 ? " " + x.name : "");
    b.title = x.name;
    b.onclick = () => { state.rallyId = x.id; state.stageFilter = "all"; state.hi = null; resetDel(); render(); };
    yc.append(b);
  });
  if (canEdit()) {
    const add = document.createElement("button"); add.type = "button"; add.className = "chip add"; add.textContent = "+ Nuevo año";
    add.onclick = openYearForm; yc.append(add);
    if (!state.rallies.length && $("yearForm").hidden) openYearForm();
  }
  $("rallyName").textContent = r ? r.name : "";
  $("rallyDelBox").hidden = !r;

  const sc = $("stages"); sc.textContent = "";
  const stList = allStages();
  if (state.stageFilter !== "all" && !stList.includes(state.stageFilter)) state.stageFilter = "all";
  if (r) [["all", "Todas"], ...stList.map((k) => [k, k === "" ? "Sin etapa" : "E" + k])].forEach(([k, t]) => {
    const b = document.createElement("button"); b.type = "button"; b.className = "chip";
    b.setAttribute("aria-pressed", String(state.stageFilter === k));
    const n = k === "all" ? rallyWps().length : rallyWps().filter((w) => stageKey(w) === k).length;
    b.textContent = t + " · " + n;
    b.onclick = () => { state.stageFilter = k; if (k !== "all" && k !== "") $("stageNo").value = k; state.hi = null; render(); };
    sc.append(b);
  });

  $("readBtn").disabled = !r || !state.photos.length || state.reading;
  $("wSave").disabled = !r; $("gpxFile").disabled = !r;
  $("mapTitle").textContent = r ? scopeLabel() : "Mapa";
  renderTable(); renderTracks(); renderMap(); renderReview(); renderDownloads();
}

function renderTable() {
  const tb = $("wpBody"); tb.textContent = "";
  const list = visibleWps();
  if (!list.length) {
    const tr = document.createElement("tr"); const td = document.createElement("td"); td.colSpan = 7; td.className = "hint";
    td.textContent = rallyWps().length && rally() ? "Ningún waypoint coincide con el filtro." : rally() ? "Aún no hay waypoints aquí." + (canEdit() ? " Importa las fotos del roadbook en el paso 3." : "") : "Todavía no hay ninguna prueba.";
    tr.append(td); tb.append(tr);
  }
  let last = null;
  list.forEach((w) => {
    const k = stageKey(w);
    if (k !== last) {
      last = k;
      const h = document.createElement("tr"); h.className = "stagehead"; const td = document.createElement("td"); td.colSpan = 7;
      td.textContent = stageLabel(k) + " · " + list.filter((x) => stageKey(x) === k).length + " WP"; h.append(td); tb.append(h);
    }
    const tr = document.createElement("tr"); tr.id = "row-" + w.id; tr.className = (state.hi === w.id ? "hi" : "") + (filt.off.has(w.id) ? " off" : "");
    const tdc = document.createElement("td"); const cb = document.createElement("input"); cb.type = "checkbox"; cb.style.width = "auto";
    cb.checked = !filt.off.has(w.id); cb.setAttribute("aria-label", "Ver " + w.name + " en el mapa");
    cb.onchange = () => { if (cb.checked) filt.off.delete(w.id); else filt.off.add(w.id); tr.classList.toggle("off", !cb.checked); renderMap(); renderDownloads(); renderScope(); };
    tdc.append(cb); tr.append(tdc);
    [[w.name, "nm"], [fmtCoord(w.lat, true, state.fmt), "c"], [fmtCoord(w.lon, false, state.fmt), "c"], [w.page || "", "c"], [w.desc || "", ""]]
      .forEach(([t, cls]) => { const td = document.createElement("td"); td.textContent = t; if (cls) td.className = cls; tr.append(td); });
    const act = document.createElement("td"); act.className = "act";
    const link = (txt, href) => { const a = document.createElement("a"); a.className = "gm"; a.target = "_blank"; a.rel = "noopener"; a.href = href; a.textContent = txt; return a; };
    act.append(link("Maps", `https://www.google.com/maps/search/?api=1&query=${w.lat},${w.lon}`), " ", link("Earth", `https://earth.google.com/web/search/${w.lat},${w.lon}`));
    if (canEdit()) {
      const ed = document.createElement("button"); ed.type = "button"; ed.className = "ghost"; ed.textContent = "Editar"; ed.onclick = () => startEdit(w);
      const del = document.createElement("button"); del.type = "button"; del.className = "ghost"; del.textContent = "Borrar";
      del.onclick = async () => {
        if (del.dataset.armed) { try { must(await sb.from("waypoints").delete().eq("id", w.id)); reloadSoon(); } catch (er) { $("expMsg").textContent = writeErr(er); } return; }
        del.dataset.armed = "1"; del.textContent = "¿Seguro?"; del.className = "warn";
        setTimeout(() => { if (del.isConnected) { delete del.dataset.armed; del.textContent = "Borrar"; del.className = "ghost"; } }, 4000);
      };
      act.append(" ", ed, " ", del);
    }
    tr.append(act);
    tr.onclick = (ev) => { if (ev.target.closest("a,button,input")) return; state.hi = w.id; renderTable(); renderMap(); };
    tb.append(tr);
  });
  renderScope();
}
function renderScope() {
  const n = visibleWps().length, m = mapWps().length;
  $("exportScope").textContent = n + " waypoints · " + scopeLabel() + (m !== n ? ` · ${m} en el mapa` : "");
  const sel = $("fStage"), opts = [["all", "Todas"], ...allStages().map((k) => [k, stageLabel(k)])];
  if (sel.options.length !== opts.length || [...sel.options].some((o, i) => o.value !== opts[i][0])) {
    sel.textContent = ""; opts.forEach(([v, t]) => { const o = document.createElement("option"); o.value = v; o.textContent = t; sel.append(o); });
  }
  sel.value = state.stageFilter;
  $("fClear").hidden = !filt.text && filt.from === null && filt.to === null && !filt.off.size;
}
const numOrNull = (v) => v === "" ? null : parseInt(v, 10);
const refilter = () => { renderTable(); renderMap(); renderDownloads(); };
$("fStage").onchange = (e) => { state.stageFilter = e.target.value; if (state.stageFilter !== "all" && state.stageFilter !== "") $("stageNo").value = state.stageFilter; state.hi = null; render(); };
$("fText").addEventListener("input", (e) => { filt.text = e.target.value.trim().toLowerCase(); refilter(); });
$("fFrom").addEventListener("input", (e) => { filt.from = numOrNull(e.target.value); refilter(); });
$("fTo").addEventListener("input", (e) => { filt.to = numOrNull(e.target.value); refilter(); });
$("fTracks").onchange = (e) => { filt.tracks = e.target.checked; renderMap(); renderDownloads(); };
$("fAll").onclick = () => { visibleWps().forEach((w) => filt.off.delete(w.id)); refilter(); };
$("fNone").onclick = () => { visibleWps().forEach((w) => filt.off.add(w.id)); refilter(); };
$("fClear").onclick = () => {
  Object.assign(filt, { text: "", from: null, to: null }); filt.off.clear();
  $("fText").value = ""; $("fFrom").value = ""; $("fTo").value = ""; refilter();
};

/* ---------- map (satellite, no key needed) ---------- */
let lmap = null, layer = null, fitKey = "", measure = [];
const rad = Math.PI / 180;
function distKm(a, b) {
  const h = Math.sin((b.lat - a.lat) * rad / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((b.lon - a.lon) * rad / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(h));
}
function bearing(a, b) { // initial course from a to b, degrees from north
  const y = Math.sin((b.lon - a.lon) * rad) * Math.cos(b.lat * rad);
  const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lon - a.lon) * rad);
  return String(Math.round((Math.atan2(y, x) / rad + 360) % 360) % 360).padStart(3, "0");
}
const fmtKm = (d) => d < 1 ? Math.round(d * 1000) + " m" : d.toLocaleString("es", { maximumFractionDigits: 2 }) + " km";
function loadMaps() {
  if (lmap) return;
  if (!window.L) { $("gmap").innerHTML = '<p class="hint" style="padding:16px">No se pudo cargar el mapa.</p>'; return; }
  lmap = L.map($("gmap"), { center: [31.5, -5.5], zoom: 6 });
  const esri = "https://server.arcgisonline.com/ArcGIS/rest/services/";
  L.tileLayer(esri + "World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "Imágenes © Esri, Maxar, Earthstar Geographics" }).addTo(lmap);
  L.tileLayer(esri + "Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19 }).addTo(lmap);
  layer = L.layerGroup().addTo(lmap);
  lmap.on("click", () => { if (measure.length) { measure = []; renderMap(); } });
  renderMap();
}
function renderMap() {
  if (!lmap) return;
  layer.clearLayers();
  const list = mapWps(), trks = visibleTracks();
  $("scaleTxt").textContent = list.length || trks.length ? "Colores por etapa · línea continua = track · vista satélite" : "Sin waypoints en esta selección";
  if (!list.length && !trks.length) return;
  const pts = list.map((w) => [w.lat, w.lon]);
  trks.forEach((t) => t.segs.forEach((seg) => {
    L.polyline(seg, { color: "#000", weight: 6, opacity: .35, interactive: false }).addTo(layer);
    L.polyline(seg, { color: stageColor(stageKey(t)), weight: 3.5, opacity: .95 }).bindTooltip(t.name).addTo(layer);
    seg.forEach((p) => pts.push(p));
  }));
  // distance between the two waypoints tapped
  const [ma, mb] = measure.map((id) => list.find((w) => w.id === id));
  if (measure.length === 2 && ma && mb) {
    const d = distKm(ma, mb), cap = bearing(ma, mb);
    L.polyline([[ma.lat, ma.lon], [mb.lat, mb.lon]], { color: "#000", weight: 6, opacity: .45, interactive: false }).addTo(layer);
    L.polyline([[ma.lat, ma.lon], [mb.lat, mb.lon]], { color: "#fff", weight: 3, opacity: 1, interactive: false })
      .bindTooltip(`${fmtKm(d)} · rumbo ${cap}°`, { permanent: true, direction: "center", className: "wp-lbl dist" }).addTo(layer);
    $("scaleTxt").textContent = `${ma.name} → ${mb.name}: ${fmtKm(d)} en línea recta, rumbo ${cap}°`;
  } else if (measure.length === 1 && ma) {
    $("scaleTxt").textContent = `Desde ${ma.name}: toca otro waypoint para ver la distancia`;
  }
  list.forEach((w) => {
    const hi = state.hi === w.id || measure.includes(w.id);
    const m = L.circleMarker([w.lat, w.lon], { radius: hi ? 10 : 7, color: hi ? "#000" : "#fff", weight: 2, fillColor: stageColor(stageKey(w)), fillOpacity: 1 })
      .bindTooltip(w.name, { permanent: true, direction: "top", offset: [0, -8], className: "wp-lbl" })
      .on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        if (measure.length === 1 && measure[0] === w.id) measure = [];
        else measure = measure.length === 1 ? [measure[0], w.id] : [w.id];
        state.hi = w.id; renderTable(); renderMap(); const row = $("row-" + w.id); if (row) row.scrollIntoView({ block: "nearest" });
      })
      .addTo(layer);
    if (hi) m.bringToFront();
  });
  const key = state.rallyId + "|" + state.stageFilter + "|" + list.map((w) => w.id).join(",") + "|" + trks.length;
  if (key !== fitKey) {
    fitKey = key;
    if (pts.length === 1) lmap.setView(pts[0], 15);
    else lmap.fitBounds(pts, { padding: [40, 40] });
  }
}

/* ---------- step 1: years ---------- */
function openYearForm() {
  $("yearForm").hidden = false;
  const ys = state.rallies.map((r) => +r.year);
  $("nyYear").value = ys.length ? Math.max(new Date().getFullYear(), Math.max(...ys) + 1) : new Date().getFullYear();
  $("nyName").value = ralliesSorted()[0] ? ralliesSorted()[0].name : "Rally de Marruecos";
  $("nyCancel").hidden = !state.rallies.length;
}
$("nyCancel").onclick = () => { $("yearForm").hidden = true; };
// photos, tracks or waypoints arriving before any year exists: create it from the year form (this year by default)
async function ensureRally() {
  if (rally()) return rally();
  const d = { year: parseInt($("nyYear").value, 10) || new Date().getFullYear(), name: $("nyName").value.trim() || "Rally de Marruecos" };
  const ref = must(await sb.from("rallies").insert(d).select().single());
  state.rallies.push(rallyIn(ref)); state.rallyId = ref.id; state.stageFilter = "all"; $("yearForm").hidden = true; render();
  return rally();
}
$("yearForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const d = { year: parseInt($("nyYear").value, 10), name: $("nyName").value.trim() };
  if (!d.year || !d.name) return;
  try { const ref = must(await sb.from("rallies").insert(d).select().single()); state.rallies.push(rallyIn(ref)); $("yearForm").hidden = true; state.rallyId = ref.id; state.stageFilter = "all"; render(); }
  catch (err) { showNotice(writeErr(err)); }
});
function resetDel() { $("rallyDel").hidden = false; $("rallyDelYes").hidden = true; $("rallyDelNo").hidden = true; }
$("rallyDel").onclick = () => { $("rallyDel").hidden = true; $("rallyDelYes").hidden = false; $("rallyDelNo").hidden = false; };
$("rallyDelNo").onclick = resetDel;
$("rallyDelYes").onclick = async () => {
  const id = state.rallyId; if (!id) return;
  try {
    must(await sb.from("rallies").delete().eq("id", id)); // its waypoints go with it
    state.rallyId = null; resetDel(); await loadAll();
  } catch (err) { showNotice(writeErr(err)); }
};

/* ---------- step 2: stage ---------- */
$("stageNo").addEventListener("input", () => $("stageNo").classList.remove("need"));
$("stageNo").addEventListener("change", () => {
  const s = currentStage();
  // re-draw only when the selection changes, so a click on another button right after typing isn't lost
  if (s && allStages().includes(s) && state.stageFilter !== s) { state.stageFilter = s; render(); }
  else renderReview();
  if (s && state.photos.length && !state.pending && !state.reading) readPhotos();
});

/* ---------- step 3: photos ---------- */
function setPhotos(files) {
  const all = [...files];
  state.photos = all.filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name));
  const t = $("thumbs"); t.querySelectorAll("img").forEach((i) => URL.revokeObjectURL(i.src)); t.textContent = "";
  state.photos.forEach((f) => { const i = document.createElement("img"); i.src = URL.createObjectURL(f); i.alt = f.name; t.append(i); });
  $("clearPhotos").hidden = !state.photos.length; $("readBtn").hidden = true;
  $("photoMsg").textContent = state.photos.length ? state.photos.length + " foto(s) cargadas." + (currentStage() ? "" : " Pon el nº de etapa en el paso 2 y se leen solas.") : "";
  if (all.length && !state.photos.length) $("photoMsg").textContent = "Eso no parece una foto. Usa JPG, PNG o HEIC.";
  render();
  if (state.photos.length && currentStage()) readPhotos();
  else if (state.photos.length) { $("stageNo").classList.add("need"); $("stageNo").focus(); }
}
$("photos").addEventListener("change", (e) => setPhotos(e.target.files));
$("clearPhotos").onclick = () => { $("photos").value = ""; setPhotos([]); };
const drop = $("drop");
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); setPhotos(e.dataTransfer.files); });

// phone photos are large; send a 2000px JPEG, plenty to read the coordinates
async function toJpeg(file, max = 2000) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch (e) { throw new Error(`Este navegador no puede abrir «${file.name}». Si es HEIC del iPhone, ábrela en Safari o pásala a JPG.`); }
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  const url = c.toDataURL("image/jpeg", 0.85);
  return { mediaType: "image/jpeg", data: url.slice(url.indexOf(",") + 1) };
}
$("readBtn").onclick = () => readPhotos();
async function readPhotos() {
  const msg = $("photoMsg");
  if (!currentStage()) { msg.textContent = "Pon primero el nº de etapa en el paso 2."; $("stageNo").classList.add("need"); $("stageNo").focus(); return; }
  try { await ensureRally(); } catch (e) { msg.textContent = writeErr(e); return; }
  state.reading = true; render();
  const found = []; let failed = false;
  try {
    for (let i = 0; i < state.photos.length; i += 2) {
      const batch = state.photos.slice(i, i + 2);
      msg.textContent = `Leyendo foto${batch.length > 1 ? "s" : ""} ${i + 1}${batch.length > 1 ? "–" + (i + batch.length) : ""} de ${state.photos.length}…`;
      const images = await Promise.all(batch.map((f) => toJpeg(f)));
      const { data, error } = await sb.functions.invoke("leer-roadbook", { body: { images } });
      if (error) {
        let m = ""; try { m = (await error.context.json()).error; } catch (er) {}
        throw new Error(m || "No se pudieron leer las fotos.");
      }
      (data.waypoints || []).forEach((o) => found.push(o));
    }
  } catch (e) {
    failed = true;
    msg.textContent = (e && e.message) || "No se pudieron leer las fotos.";
  }
  state.reading = false;
  if (found.length) {
    const rows = found.map((o) => ({
      on: true,
      name: String(o.name || "").trim(), latRaw: String(o.lat ?? ""), lonRaw: String(o.lon ?? ""), page: String(o.page || ""),
      desc: [o.box ? "Casilla " + o.box : "", o.km ? "km " + o.km : "", o.note || "", o.dudoso ? "revisar con la foto" : ""].filter(Boolean).join(", "), doubt: !!o.dudoso,
    }));
    // good readings are saved straight away; only the ones that can't be used wait in the review table
    const isOk = (x) => x.name && parseCoord(x.latRaw, true) !== null && parseCoord(x.lonRaw, false) !== null;
    const good = rows.filter(isOk), bad = rows.filter((x) => !isOk(x));
    try {
      const res = await saveRows(good);
      state.pending = bad.length ? bad : null;
      $("photos").value = ""; setPhotos([]);
      const doubts = good.filter((x) => x.doubt).length;
      msg.textContent = `Guardados ${res.added} waypoints en la etapa ${currentStage()}` + (res.skipped ? ` (${res.skipped} ya estaban)` : "") + "." +
        (doubts ? (doubts > 1 ? ` ${doubts} tienen algún dígito dudoso y salen marcados` : " Uno tiene algún dígito dudoso y sale marcado") + " «revisar con la foto» en la tabla." : "") +
        (bad.length ? (bad.length > 1 ? ` ${bad.length} no se leyeron bien` : " Uno no se leyó bien") + ": corrígelo en la tabla de arriba y pulsa Guardar." : "");
    } catch (e) { state.pending = rows; msg.textContent = writeErr(e); }
  } else if (!failed) msg.textContent = "No encontré waypoints con coordenadas en las fotos.";
  $("readBtn").hidden = !state.photos.length;
  render();
  if (state.pending) $("review").scrollIntoView({ behavior: "smooth", block: "start" });
  else if (found.length) $("wpBody").scrollIntoView({ behavior: "smooth", block: "start" });
}
async function saveRows(rows) {
  const st = currentStage(), r = rally();
  const have = new Set(rallyWps().map((w) => stageKey(w) + "|" + w.name));
  const seqBase = Date.now() * 100;
  const batch = []; let skipped = 0;
  rows.forEach((x, i) => {
    if (have.has(st + "|" + x.name.trim())) { skipped++; return; }
    batch.push(wpOut({ rallyId: r.id, stage: st, name: x.name.trim(), lat: parseCoord(x.latRaw, true), lon: parseCoord(x.lonRaw, false), page: x.page.trim(), desc: x.desc.trim(), seq: seqBase + i, source: "foto", by: state.user.email }));
  });
  if (batch.length) must(await sb.from("waypoints").insert(batch));
  state.stageFilter = st; await loadAll();
  return { added: batch.length, skipped };
}

function renderReview() {
  const box = $("review"), p = state.pending;
  box.hidden = !p || !p.length; if (box.hidden) return;
  $("revInfo").textContent = (rally() ? rally().year + " · " : "") + (currentStage() ? "Etapa " + currentStage() : "sin etapa");
  const tb = $("revBody");
  if (tb.dataset.n === String(p.length) && tb.contains(document.activeElement)) return;
  tb.textContent = ""; tb.dataset.n = String(p.length);
  p.forEach((row, i) => {
    const tr = document.createElement("tr");
    const ok = () => parseCoord(row.latRaw, true) !== null && parseCoord(row.lonRaw, false) !== null;
    const mark = () => tr.querySelectorAll("input.coord").forEach((inp) => inp.classList.toggle("bad", !ok()));
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = row.on; cb.style.width = "auto"; cb.id = "rv-on-" + i;
    cb.onchange = () => { row.on = cb.checked; };
    const td0 = document.createElement("td"); td0.append(cb); tr.append(td0);
    [["name", "nm"], ["latRaw", "coord"], ["lonRaw", "coord"], ["page", "sm"], ["desc", ""]].forEach(([f, cls]) => {
      const td = document.createElement("td"); const inp = document.createElement("input"); inp.value = row[f]; inp.id = "rv-" + f + "-" + i;
      if (cls) inp.className = cls;
      inp.oninput = () => { row[f] = inp.value; if (cls === "coord") { mark(); if (ok()) { row.on = true; cb.checked = true; } } };
      td.append(inp); tr.append(td);
    });
    if (row.doubt) { tr.title = "Lectura dudosa: compárala con la foto"; tr.children[2].firstChild.style.borderColor = "var(--saffron)"; tr.children[3].firstChild.style.borderColor = "var(--saffron)"; }
    mark(); tb.append(tr);
  });
}
$("revCancel").onclick = () => { state.pending = null; render(); };
$("revSave").onclick = async () => {
  const st = currentStage(), r = rally();
  if (!r) return;
  const rows = state.pending.filter((x) => x.on);
  const bad = rows.filter((x) => parseCoord(x.latRaw, true) === null || parseCoord(x.lonRaw, false) === null || !x.name.trim());
  if (bad.length) { $("photoMsg").textContent = `Hay ${bad.length} fila(s) marcadas sin nombre o con coordenadas no válidas. Corrígelas o desmárcalas.`; return; }
  $("revSave").disabled = true;
  try {
    const res = await saveRows(rows);
    state.pending = null;
    $("photos").value = ""; setPhotos([]);
    $("photoMsg").textContent = `Guardados ${res.added} waypoints en la etapa ${st || "(sin número)"}` + (res.skipped ? `; ${res.skipped} ya existían y no se duplicaron.` : ".");
  } catch (e) { $("photoMsg").textContent = writeErr(e); }
  $("revSave").disabled = false; render();
};

/* ---------- step 3b: track ---------- */
const MAX_TRACK_POINTS = 20000;
function parseTrack(text, fileName) {
  const xml = new DOMParser().parseFromString(text, "application/xml");
  if (xml.getElementsByTagName("parsererror").length) throw new Error("El archivo no se puede leer.");
  const num = (v) => Math.round(parseFloat(v) * 1e6) / 1e6;
  const ok = (p) => Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180;
  let segs = [];
  [...xml.getElementsByTagName("trkseg")].forEach((sg) => segs.push([...sg.getElementsByTagName("trkpt")].map((p) => [num(p.getAttribute("lat")), num(p.getAttribute("lon"))])));
  if (!segs.length) [...xml.getElementsByTagName("rte")].forEach((rt) => segs.push([...rt.getElementsByTagName("rtept")].map((p) => [num(p.getAttribute("lat")), num(p.getAttribute("lon"))])));
  if (!segs.length) [...xml.getElementsByTagName("LineString")].forEach((ls) => {
    const c = ls.getElementsByTagName("coordinates")[0];
    if (c) segs.push(c.textContent.trim().split(/\s+/).map((t) => { const [lo, la] = t.split(","); return [num(la), num(lo)]; }));
  });
  if (!segs.length) [...xml.getElementsByTagNameNS("*", "Track")].forEach((tr) => segs.push([...tr.getElementsByTagNameNS("*", "coord")].map((c) => { const [lo, la] = c.textContent.trim().split(/\s+/); return [num(la), num(lo)]; })));
  segs = segs.map((sg) => sg.filter(ok)).filter((sg) => sg.length > 1);
  if (!segs.length) throw new Error("El archivo no trae ningún track.");
  const total = segs.reduce((n, sg) => n + sg.length, 0);
  if (total > MAX_TRACK_POINTS) { // keep every k-th point, always the first and last of each segment
    const k = Math.ceil(total / MAX_TRACK_POINTS);
    segs = segs.map((sg) => sg.filter((p, i) => i % k === 0 || i === sg.length - 1));
  }
  const nameEl = xml.getElementsByTagName("name")[0];
  const name = (xml.querySelector("trk > name, Placemark > name, metadata > name, Document > name") || nameEl || {}).textContent;
  return { name: (name || "").trim() || fileName.replace(/\.[^.]+$/, ""), segs };
}
const kmOf = (segs) => {
  const R = 6371, rad = Math.PI / 180; let d = 0;
  segs.forEach((sg) => sg.forEach((p, i) => { if (!i) return; const q = sg[i - 1];
    const a = Math.sin((p[0] - q[0]) * rad / 2) ** 2 + Math.cos(q[0] * rad) * Math.cos(p[0] * rad) * Math.sin((p[1] - q[1]) * rad / 2) ** 2;
    d += 2 * R * Math.asin(Math.sqrt(a)); }));
  return d;
};
async function importTracks(files) {
  const msg = $("trkMsg");
  if (!files.length) return;
  const st = currentStage();
  if (!st) { msg.textContent = "Pon primero el nº de etapa en el paso 2."; $("stageNo").classList.add("need"); $("stageNo").focus(); return; }
  try { await ensureRally(); } catch (e) { msg.textContent = writeErr(e); return; }
  msg.textContent = "Importando…";
  const rows = [], bad = [];
  for (const f of files) {
    try { const t = parseTrack(await f.text(), f.name); rows.push({ rally_id: state.rallyId, stage: st, name: t.name, points: t.segs, created_by: state.user.email }); }
    catch (e) { bad.push(f.name + ": " + e.message); }
  }
  try {
    if (rows.length) must(await sb.from("tracks").insert(rows));
    state.stageFilter = st; await loadAll();
    msg.textContent = (rows.length ? `Track guardado en la etapa ${st}: ` + rows.map((r) => `${r.name} (${kmOf(r.points).toFixed(1)} km)`).join(", ") + "." : "") + (bad.length ? " No se pudo: " + bad.join("; ") : "");
  } catch (e) { msg.textContent = writeErr(e); }
}
$("trackFile").addEventListener("change", (e) => { const f = [...e.target.files]; e.target.value = ""; importTracks(f); });
const tdrop = $("trkDrop");
tdrop.addEventListener("dragover", (e) => { e.preventDefault(); tdrop.classList.add("over"); });
tdrop.addEventListener("dragleave", () => tdrop.classList.remove("over"));
tdrop.addEventListener("drop", (e) => { e.preventDefault(); tdrop.classList.remove("over"); importTracks([...e.dataTransfer.files]); });
function renderTracks() {
  const ul = $("trackList"); ul.textContent = "";
  visibleTracks().sort((a, b) => natural(stageKey(a), stageKey(b)) || natural(a.created, b.created)).forEach((t) => {
    const li = document.createElement("li");
    const sw = document.createElement("span"); sw.className = "sw"; sw.style.background = stageColor(stageKey(t));
    const nm = document.createElement("span"); nm.className = "em"; nm.textContent = `${stageLabel(stageKey(t))} · ${t.name} · ${kmOf(t.segs).toFixed(1)} km`;
    li.append(sw, nm);
    if (canEdit()) {
      const del = document.createElement("button"); del.type = "button"; del.className = "ghost"; del.textContent = "Borrar";
      del.onclick = async () => {
        if (!del.dataset.armed) { del.dataset.armed = "1"; del.textContent = "¿Seguro?"; del.className = "warn"; return; }
        try { must(await sb.from("tracks").delete().eq("id", t.id)); await loadAll(); } catch (e) { $("trkMsg").textContent = writeErr(e); }
      };
      li.append(del);
    }
    ul.append(li);
  });
}

/* ---------- manual & GPX ---------- */
function updateParsed() {
  const la = parseCoord($("wLat").value, true), lo = parseCoord($("wLon").value, false), p = $("wParsed");
  if (!$("wLat").value && !$("wLon").value) { p.textContent = ""; p.className = "parsed"; return; }
  if (la === null || lo === null) { p.textContent = (la === null ? "Latitud" : "Longitud") + " no reconocida"; p.className = "parsed bad"; return; }
  p.className = "parsed"; p.textContent = "= " + la.toFixed(6) + ", " + lo.toFixed(6);
}
$("wLat").addEventListener("input", updateParsed); $("wLon").addEventListener("input", updateParsed);
function startEdit(w) {
  $("moreWays").open = true; $("stageNo").value = stageKey(w);
  $("wEditing").value = w.id; $("wName").value = w.name; $("wPage").value = w.page || ""; $("wDesc").value = w.desc || "";
  $("wLat").value = fmtCoord(w.lat, true, "dm"); $("wLon").value = fmtCoord(w.lon, false, "dm");
  $("wCancel").hidden = false; $("wSave").textContent = "Guardar cambios"; updateParsed();
  $("wpForm").scrollIntoView({ behavior: "smooth", block: "center" }); $("wName").focus({ preventScroll: true });
}
function clearWp() {
  ["wEditing", "wName", "wPage", "wDesc", "wLat", "wLon"].forEach((i) => $(i).value = "");
  $("wCancel").hidden = true; $("wSave").textContent = "Guardar waypoint"; updateParsed();
}
$("wCancel").onclick = clearWp;
$("wpForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const la = parseCoord($("wLat").value, true), lo = parseCoord($("wLon").value, false);
  if (!rally()) { $("wMsg").textContent = "Primero crea o elige el año."; return; }
  if (la === null || lo === null) { $("wMsg").textContent = "Revisa las coordenadas: no las reconozco."; return; }
  const d = { rallyId: state.rallyId, stage: currentStage(), name: $("wName").value.trim(), page: $("wPage").value.trim(), desc: $("wDesc").value.trim(), lat: la, lon: lo };
  try {
    const ed = $("wEditing").value;
    if (ed) must(await sb.from("waypoints").update(wpOut(d)).eq("id", ed));
    else must(await sb.from("waypoints").insert(wpOut({ ...d, seq: Date.now() * 100, source: "manual", by: state.user.email })));
    reloadSoon();
    $("wMsg").textContent = (ed ? "Actualizado " : "Guardado ") + d.name + " en " + stageLabel(d.stage).toLowerCase() + ".";
    const next = !ed && d.name.match(/^(.*?)(\d+)$/), page = d.page;
    clearWp(); if (next) $("wName").value = next[1] + (parseInt(next[2], 10) + 1); $("wPage").value = page;
  } catch (err) { $("wMsg").textContent = writeErr(err); }
});
$("gpxFile").addEventListener("change", async (e) => {
  const file = e.target.files[0]; e.target.value = ""; if (!file) return;
  const msg = $("impMsg");
  if (!rally()) { msg.textContent = "Primero crea o elige el año."; return; }
  const xml = new DOMParser().parseFromString(await file.text(), "application/xml");
  if (xml.getElementsByTagName("parsererror").length) { msg.textContent = "El archivo no es un GPX válido."; return; }
  let nodes = [...xml.getElementsByTagName("wpt")];
  if (!nodes.length) nodes = [...xml.getElementsByTagName("rtept")];
  if (!nodes.length) { msg.textContent = "El GPX no trae waypoints (solo track)."; return; }
  const st = currentStage(), seqBase = Date.now() * 100;
  const have = new Set(rallyWps().map((w) => stageKey(w) + "|" + w.name + "|" + w.lat + "|" + w.lon));
  const txtOf = (n, t) => { const el = n.getElementsByTagName(t)[0]; return el ? el.textContent.trim() : ""; };
  const rows = [];
  nodes.forEach((n, i) => {
    const lat = Math.round(parseFloat(n.getAttribute("lat")) * 1e6) / 1e6, lon = Math.round(parseFloat(n.getAttribute("lon")) * 1e6) / 1e6;
    const name = txtOf(n, "name") || "WP" + (i + 1);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || have.has(st + "|" + name + "|" + lat + "|" + lon)) return;
    rows.push(wpOut({ rallyId: state.rallyId, stage: st, name, lat, lon, page: "", desc: txtOf(n, "desc") || txtOf(n, "cmt"), seq: seqBase + i, source: "gpx", by: state.user.email }));
  });
  try {
    if (rows.length) must(await sb.from("waypoints").insert(rows));
    await loadAll();
    msg.textContent = `Añadidos ${rows.length} waypoints a ${stageLabel(st).toLowerCase()}` + (nodes.length > rows.length ? ` (${nodes.length - rows.length} repetidos u omitidos).` : ".");
  } catch (err) { msg.textContent = writeErr(err); }
});

/* ---------- export ---------- */
const xe = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
const descOf = (w) => [w.page ? "Pág " + w.page : "", w.desc].filter(Boolean).join(" · ");
function buildGpx(list, title, trks = []) {
  const pad = $("padNums").checked;
  const nm = (w) => pad ? String(w.name).replace(/\d+/, (d) => d.padStart(3, "0")) : String(w.name);
  let o = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Libro de Rallies" xmlns="http://www.topografix.com/GPX/1/1">\n  <metadata><name>${xe(title)}</name></metadata>\n`;
  list.slice().sort(wpOrder).forEach((w) => {
    o += `  <wpt lat="${w.lat.toFixed(6)}" lon="${w.lon.toFixed(6)}">\n    <name>${xe(nm(w))}</name>\n    <cmt>${xe(w.name)}</cmt>\n    <desc>${xe(descOf(w))}</desc>\n    <sym>Flag</sym>\n  </wpt>\n`;
  });
  trks.forEach((t) => {
    o += `  <trk>\n    <name>${xe(t.name)}</name>\n`;
    t.segs.forEach((seg) => { o += `    <trkseg>\n` + seg.map(([la, lo]) => `      <trkpt lat="${la.toFixed(6)}" lon="${lo.toFixed(6)}"/>\n`).join("") + `    </trkseg>\n`; });
    o += `  </trk>\n`;
  });
  return o + `</gpx>\n`;
}
function buildKml(list, trks = []) {
  const r = rally(), groups = {};
  [...list, ...trks].forEach((w) => (groups[stageKey(w)] = groups[stageKey(w)] || []).push(w));
  const abgr = (c) => "ff" + c.slice(5, 7) + c.slice(3, 5) + c.slice(1, 3);
  let styles = "", folders = "";
  Object.keys(groups).sort((a, b) => ((a === "") - (b === "")) || natural(a, b)).forEach((s) => {
    const sid = "e" + (s || "x");
    styles += `  <Style id="${sid}"><IconStyle><color>${abgr(stageColor(s))}</color><Icon><href>http://maps.google.com/mapfiles/kml/paddle/wht-blank.png</href></Icon></IconStyle></Style>\n`;
    folders += `  <Folder><name>${xe(stageLabel(s))}</name>\n`;
    styles += `  <Style id="${sid}t"><LineStyle><color>${abgr(stageColor(s))}</color><width>4</width></LineStyle></Style>\n`;
    groups[s].filter((x) => x.segs).forEach((t) => {
      folders += `    <Placemark><name>${xe(t.name)}</name><styleUrl>#${sid}t</styleUrl><MultiGeometry>` +
        t.segs.map((seg) => `<LineString><tessellate>1</tessellate><coordinates>${seg.map(([la, lo]) => lo.toFixed(6) + "," + la.toFixed(6)).join(" ")}</coordinates></LineString>`).join("") + `</MultiGeometry></Placemark>\n`;
    });
    groups[s].filter((x) => !x.segs).sort(wpOrder).forEach((w) => {
      folders += `    <Placemark><name>${xe(w.name)}</name><description>${xe(descOf(w))}</description><styleUrl>#${sid}</styleUrl><Point><coordinates>${w.lon.toFixed(6)},${w.lat.toFixed(6)},0</coordinates></Point></Placemark>\n`;
    });
    folders += `  </Folder>\n`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document>\n  <name>${xe(r.year + " " + r.name)}</name>\n${styles}${folders}</Document>\n</kml>\n`;
}
const slug = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "");
const baseName = () => slug(rally().year + "_" + rally().name);
const stageFile = (s) => baseName() + "_" + (s === "" ? "sin_etapa" : "Etapa" + String(s).padStart(2, "0"));
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a"); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
function renderDownloads() {
  const box = $("dlStages"); box.textContent = "";
  const all = rallyWps();
  allStages().forEach((s) => {
    const b = document.createElement("button"); b.type = "button";
    b.className = state.stageFilter === "all" || state.stageFilter === s ? "" : "ghost";
    b.textContent = "GPX " + (s === "" ? "sin etapa" : "etapa " + s);
    b.onclick = () => {
      const list = all.filter((w) => stageKey(w) === s), trks = rallyTracks().filter((t) => stageKey(t) === s);
      download(stageFile(s) + ".gpx", buildGpx(list, rally().year + " " + rally().name + " · " + stageLabel(s), trks), "application/gpx+xml");
      $("expMsg").textContent = `Descargado ${stageFile(s)}.gpx con ${list.length} waypoints en orden` + (trks.length ? ` y ${trks.length} track${trks.length > 1 ? "s" : ""}.` : ".");
    };
    box.append(b);
  });
  $("dlKml").disabled = !mapWps().length && !visibleTracks().length;
  $("dlSel").disabled = !mapWps().length;
}
$("dlKml").onclick = () => {
  const f = state.stageFilter === "all" ? baseName() : stageFile(state.stageFilter);
  download(f + ".kml", buildKml(mapWps(), visibleTracks()), "application/vnd.google-earth.kml+xml");
};
$("dlSel").onclick = () => {
  const list = mapWps(), trks = visibleTracks(), f = (state.stageFilter === "all" ? baseName() : stageFile(state.stageFilter)) + "_seleccion";
  download(f + ".gpx", buildGpx(list, rally().year + " " + rally().name + " · selección", trks), "application/gpx+xml");
  $("expMsg").textContent = `Descargado ${f}.gpx con ${list.length} waypoints en orden` + (trks.length ? ` y ${trks.length} track${trks.length > 1 ? "s" : ""}.` : ".");
};
$("padNums").onchange = (e) => { try { localStorage.setItem("rally.pad", e.target.checked ? "1" : "0"); } catch (er) {} };
$("fmt").onchange = (e) => { state.fmt = e.target.value; try { localStorage.setItem("rally.fmt", state.fmt); } catch (er) {} render(); };

/* ---------- admin: members and Earth feed ---------- */
const ROLES = { viewer: "Solo ver", editor: "Ver y añadir", admin: "Administrador" };
function renderMembers(list) {
  const ul = $("members"); ul.textContent = "";
  if (!list.length) { const li = document.createElement("li"); li.className = "hint"; li.textContent = "Solo tú tienes acceso por ahora."; ul.append(li); }
  list.sort((a, b) => a.id.localeCompare(b.id)).forEach((m) => {
    const li = document.createElement("li");
    const em = document.createElement("span"); em.className = "em"; em.textContent = m.id;
    const sel = document.createElement("select"); sel.style.width = "auto"; sel.setAttribute("aria-label", "Permiso de " + m.id);
    Object.entries(ROLES).forEach(([v, t]) => { const o = document.createElement("option"); o.value = v; o.textContent = t; sel.append(o); });
    sel.value = m.role;
    sel.onchange = async () => { const { error } = await sb.from("members").update({ role: sel.value }).eq("email", m.id); if (error) $("mMsg").textContent = writeErr(error); loadMembers(); };
    const rm = document.createElement("button"); rm.type = "button"; rm.className = "ghost"; rm.textContent = "Quitar";
    rm.onclick = async () => { const { error } = await sb.from("members").delete().eq("email", m.id); if (error) $("mMsg").textContent = writeErr(error); loadMembers(); };
    const right = document.createElement("span"); right.className = "btns"; right.append(sel, rm);
    li.append(em, right); ul.append(li);
  });
}
$("mGen").onclick = () => {
  const abc = "abcdefghjkmnpqrstuvwxyz23456789";
  $("mPass").value = [...crypto.getRandomValues(new Uint8Array(10))].map((b) => abc[b % abc.length]).join("");
};
$("memberForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("mEmail").value.trim().toLowerCase();
  const password = $("mPass").value;
  $("mMsg").textContent = "Guardando…";
  const { error } = await sb.functions.invoke("acceso", { body: { email, role: $("mRole").value, password } });
  if (error) { let m = ""; try { m = (await error.context.json()).error; } catch (er) {} $("mMsg").textContent = m || "No se pudo dar acceso."; return; }
  loadMembers(); $("mEmail").value = ""; $("mPass").value = "";
  $("mMsg").textContent = password
    ? `Listo. Pásale a ${email} esta dirección, su correo y la contraseña «${password}». Puede cambiarla al entrar.`
    : `Listo. ${email} ya puede entrar con su contraseña de siempre.`;
});
function renderFeed(token) {
  $("feedMake").hidden = !!token; $("feedCopy").disabled = !token;
  $("feedUrl").textContent = token ? `${CFG.supabaseUrl}/functions/v1/kml?t=${token}` : "Aún no hay enlace. Créalo con el botón.";
}
$("feedMake").onclick = async () => {
  const token = [...crypto.getRandomValues(new Uint8Array(18))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const { error } = await sb.from("earth_feed").upsert({ id: true, token });
  if (error) $("gMsg").textContent = writeErr(error); else loadFeed();
};
$("feedCopy").onclick = async () => {
  try { await navigator.clipboard.writeText($("feedUrl").textContent); $("gMsg").textContent = "Enlace copiado. En Google Earth Pro: Añadir › Enlace de red y pégalo."; }
  catch (e) { $("gMsg").textContent = "Selecciona el enlace y cópialo."; }
};
