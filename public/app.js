import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm";
import { setupLayers, idb, offroadMap } from "./mapas.js";
import { setupMecanica } from "./mecanica.js";
import { setupCoches } from "./coches.js";
import { setupGps } from "./gps.js";
import { buildGraph, matrix, proposals, geometry, nearRoute, addTo, satImage, meters } from "./rutas.js";

const CFG = window.APP_CONFIG;
const sb = createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);

// database rows <-> the shape the page works with
const rallyIn = (r) => ({ id: r.id, year: r.year, name: r.name, created: r.created_at });
const wpIn = (r) => ({ id: r.id, rallyId: r.rally_id, stage: r.stage, name: r.name, lat: r.lat, lon: r.lon, page: r.page, desc: r.descr, pts: r.points ?? ptsIn(r.descr || "") ?? null, seq: r.seq, created: r.created_at });
const trackIn = (r) => ({ id: r.id, rallyId: r.rally_id, stage: r.stage, name: r.name, segs: r.points, wps: r.wps || [], created: r.created_at, kind: r.kind || "", meta: r.meta || {} });
const wpOut = (w) => {
  const o = { rally_id: w.rallyId, stage: w.stage, name: w.name, lat: w.lat, lon: w.lon, page: w.page, descr: w.desc };
  if (w.pts !== undefined) o.points = w.pts || null;
  if (w.seq !== undefined) o.seq = w.seq;
  if (w.source) o.source = w.source;
  if (w.by) o.created_by = w.by;
  return o;
};
const must = ({ data, error }) => { if (error) throw error; return data; };

const $ = (id) => document.getElementById(id);
const PALETTE = ["#c1272d", "#2f4fb5", "#006233", "#e3a21a", "#b5532c", "#1b8a8a", "#7a3b8f", "#d9662b", "#4f7f2a", "#8c1d40"];
const state = { tab: "libro", user: null, role: null, rallies: [], wps: [], tracks: [], rallyId: null, stageFilter: "all", hi: null, fmt: "dm", photos: [], pending: null, reading: false };
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
const allStages = () => stagesOf([...rallyWps(), ...rallyTracks(), ...(state.stages || []).filter((x) => x.rallyId === state.rallyId), ...(currentStage() ? [{ stage: currentStage() }] : [])]);
// «Caza» or «Seguimiento», as set when the stage was created
const stageKind = (k) => ((state.stages || []).find((x) => x.rallyId === state.rallyId && x.stage === k) || {}).kind || "";
const KINDS = { seg_track: "Seguimiento track", seg_wp: "Seguimiento waypoint", caza: "Caza waypoint", seguimiento: "Seguimiento waypoint" };
const kindLabel = (k) => KINDS[stageKind(k)] || "";
const isCaza = (k) => { const v = stageKind(k); return !v || v === "caza"; }; // points are a must only when hunting
const stageTracks = () => rallyTracks().filter((t) => state.stageFilter === "all" || stageKey(t) === state.stageFilter);
// a route picked in «Seguir ruta» shows alone on the map (a planner's proposal: no track, the proposal stands out)
const visibleTracks = () => filt.tracks ? rallyTracks().filter((t) => filt.rec === t.id || (filt.follow != null ? String(t.id) === filt.follow : filt.only ? t.id === filt.only : filt.trk ? t.id === filt.trk : state.stageFilter === "all" || stageKey(t) === state.stageFilter)) : [];
// waypoints a track joins, in the order they were joined, and the sum of their points
const trackWps = (t) => (t.wps || []).map((id) => state.wps.find((w) => w.id === id)).filter(Boolean);
const sumPts = (list) => list.reduce((s, w) => s + (w.pts || 0), 0);
// on the map every route is yellow and every waypoint green, so the two never get mixed up
const TRACK = "#ffd600", WPC = "#1e9e3e";
// each route proposal gets its own colour so they can be told apart on the map
const ALT_COLS = ["#e53935", "#1e88e5", "#8e24aa", "#fb8c00", "#00897b", "#d81b60", "#6d4c41", "#3949ab"];
const altCol = (i) => ALT_COLS[i % ALT_COLS.length];
const stageColor = (s) => PALETTE[(allStages().indexOf(s) + PALETTE.length) % PALETTE.length];
// roadbook order: DSS first, then by the number in the name (WP2 before WP10), ASS last; ties by reading order
// start and finish of the stage, by name ("DSS", "SALIDA") or by description ("ST6 SALIDA", "ST LLEGADA")
const isStart = (w) => /^(DSS|START|SALIDA|DEPART)/i.test(String(w.name || "").trim()) || /\b(DSS|SALIDA|START|D[EÉ]PART)\b/i.test(w.desc || "");
const isFinish = (w) => /^(ASS|FIN|LLEGADA|ARRIV)/i.test(String(w.name || "").trim()) || /\b(ASS|LLEGADA|FINISH|ARRIV[EÉ]E?)\b/i.test(w.desc || "");
function orderKey(w) {
  const n = String(w.name || "").toUpperCase().trim();
  if (isStart(w)) return -1;
  if (isFinish(w)) return 1e9;
  const m = n.match(/\d+/); return m ? parseInt(m[0], 10) : 5e8;
}
// score written next to a waypoint: "25 pts", "50pts", "100 puntos", "10 points"
const ptsIn = (...texts) => { const m = texts.join(" ").match(/(\d{1,4})\s*(?:pts?|ptos?|puntos?|points?)\b/i); return m ? parseInt(m[1], 10) : null; };
const seqOf = (w) => typeof w.seq === "number" ? w.seq : Date.parse(w.created || 0) || 0;
const wpOrder = (a, b) => ((stageKey(a) === "") - (stageKey(b) === "")) || natural(stageKey(a), stageKey(b)) || (orderKey(a) - orderKey(b)) || (seqOf(a) - seqOf(b)) || natural(a.name, b.name);
// table filters: stage, text, WP number range; the per-row tick decides what goes to the map
const filt = { text: "", from: null, to: null, tracks: true, trk: "", rec: null, only: null, follow: null, off: new Set(), ptsOff: new Set() };
const ptsKey = (w) => w.pts ? String(w.pts) : "sin";
const textOf = (w) => [w.name, w.page && "pág " + w.page, w.desc].filter(Boolean).join(" ").toLowerCase();
const visibleWps = () => rallyWps().filter((w) => {
  if (filt.only) { const t = state.tracks.find((x) => x.id === filt.only); return !!t && t.wps.includes(w.id); }
  if (state.stageFilter !== "all" && stageKey(w) !== state.stageFilter) return false;
  const n = orderKey(w);
  if (filt.from !== null && n < filt.from) return false;
  if (filt.to !== null && n > filt.to) return false;
  if (filt.ptsOff.has(ptsKey(w))) return false;
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
  $("login").hidden = !login; $("claim").hidden = !claim; $("features").hidden = !login;
}

async function roleFor() {
  const { data: role, error } = await sb.rpc("my_role");
  if (error && /fetch|network|load failed/i.test(error.message || "")) throw error;
  if (role) return role;
  const { data: owner } = await sb.from("site_owner").select("id").limit(1);
  return owner && owner.length ? null : "unclaimed";
}

// without internet: show the last copy saved on this device, read only
let offline = false;
async function offlineBoot() {
  offline = true;
  let snap = null; try { snap = await idb.get("kv", "snap"); } catch (e) {}
  if (!snap) { gate("Sin conexión", "No hay internet y este dispositivo aún no tiene copia. Abre la web una vez con conexión y quedará guardada."); return; }
  Object.assign(state, { user: { email: snap.email }, role: "offline", rallies: snap.rallies, wps: snap.wps, tracks: snap.tracks });
  $("userbar").hidden = false; $("uName").textContent = snap.email; $("uPhoto").hidden = true;
  $("gate").hidden = true; $("features").hidden = true; $("app").hidden = false;
  document.body.classList.add("viewer-only-hide"); $("accBtn").hidden = true;
  render(); loadMaps();
  showNotice(`Sin conexión: ves la copia guardada el ${new Date(snap.at).toLocaleString("es")}. Los mapas sin conexión funcionan; para guardar cambios hace falta internet.`);
}
window.addEventListener("online", () => { if (offline) location.reload(); });
if ("serviceWorker" in navigator) {
  // a new version takes over by itself: the page reloads once so the phone or tablet doesn't keep the old program
  const had = !!navigator.serviceWorker.controller; let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (had && !reloaded) { reloaded = true; location.reload(); } });
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then((r) => r.update()).catch(() => {});
}
if (!navigator.onLine) offlineBoot();

// boot once per signed-in person (token refreshes fire this too)
sb.auth.onAuthStateChange((_ev, session) => {
  if (offline) return;
  const user = session ? session.user : null;
  if ((user && user.id) === bootedFor) return;
  bootedFor = user && user.id;
  setTimeout(() => boot(user), 0);
});

async function loadAll() {
  try {
    const [r, w, t] = await Promise.all([sb.from("rallies").select("*"), sb.from("waypoints").select("*").range(0, 9999), sb.from("tracks").select("*")]);
    state.rallies = must(r).map(rallyIn); state.wps = must(w).map(wpIn); state.tracks = must(t).map(trackIn);
    // the stages created in the planner, with their type (missing table: nothing breaks)
    try { const sg = await sb.from("stages").select("*"); if (!sg.error) state.stages = sg.data.map((x) => ({ rallyId: x.rally_id, stage: String(x.stage), kind: x.kind })); } catch (e) {}
    showNotice(""); render();
    // last copy kept on this device, to open the page without internet
    idb.put("kv", { at: Date.now(), email: state.user.email, rallies: state.rallies, wps: state.wps, tracks: state.tracks }, "snap").catch(() => {});
  } catch (e) { showNotice("No se pudo leer el registro (" + (e.code || e.message) + ")."); }
}
let reloadTimer;
const reloadSoon = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(loadAll, 300); };
async function loadMembers() {
  const { data, error } = await sb.from("members").select("*");
  if (!error) renderMembers(data.map((m) => ({ id: m.email, role: m.role })));
}


async function boot(user) {
  if (channel) { sb.removeChannel(channel); channel = null; }
  state.user = user; state.role = null;
  $("userbar").hidden = !user;
  if (!user) { gate("Entrar", "Entra con tu correo y tu contraseña.", { login: true }); return; }
  $("uName").textContent = user.email; $("uPhoto").hidden = true;
  let role;
  try { role = await roleFor(); } catch (e) { return offlineBoot(); }
  if (role === "unclaimed") { gate("Web nueva", "Nadie administra todavía esta web. Si es tuya, pulsa el botón y serás el administrador.", { claim: true }); return; }
  if (!role) { gate("Sin acceso", `Tu cuenta (${user.email}) no tiene acceso. Pide al administrador que te dé permiso.`); return; }
  state.role = role;
  $("gate").hidden = true; $("features").hidden = true; $("app").hidden = false;
  document.body.classList.toggle("viewer-only-hide", !canEdit());
  $("accBtn").hidden = role !== "admin";
  // changes made by anyone show up for everyone with the page open
  channel = sb.channel("libro")
    .on("postgres_changes", { event: "*", schema: "public", table: "rallies" }, reloadSoon)
    .on("postgres_changes", { event: "*", schema: "public", table: "waypoints" }, reloadSoon)
    .on("postgres_changes", { event: "*", schema: "public", table: "tracks" }, reloadSoon)
    .subscribe();
  await loadAll();
  if (role === "admin") loadMembers();
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
  // the year above the table, in Libro de ruta
  const fy = $("fYear"); fy.textContent = "";
  ralliesSorted().forEach((x) => fy.append(new Option(String(x.year) + (state.rallies.filter((o) => o.year === x.year).length > 1 ? " " + x.name : ""), x.id)));
  if (canEdit()) fy.append(new Option("+ Nuevo año…", "new"));
  fy.value = state.rallyId || "";
  // the same year next to the stage number (Importar and Planificador)
  const sy = $("sYear"); sy.textContent = ""; [...fy.options].forEach((o) => sy.append(new Option(o.text, o.value))); sy.value = fy.value;
  $("rallyName").textContent = r ? r.name : "";
  $("rallyDelBox").hidden = !r;

  const stList = allStages();
  if (state.stageFilter !== "all" && !stList.includes(state.stageFilter)) state.stageFilter = "all";
  $("allStages").setAttribute("aria-pressed", String(state.stageFilter === "all"));
  $("allStages").textContent = "Todas las etapas";
  // one chip per stage with its own waypoints
  const chips = $("stageChips"); chips.textContent = "";
  stList.forEach((k) => {
    const n = rallyWps().filter((w) => stageKey(w) === k).length; if (k === "" && !n) return;
    const c = document.createElement("button"); c.type = "button"; c.className = "chip";
    c.setAttribute("aria-pressed", String(state.stageFilter === k));
    c.textContent = `${stageLabel(k)} · ${n} WP`; c.onclick = () => pickStage(k);
    chips.append(c);
  });
  $("stageHint").textContent = state.stageFilter === "all"
    ? "Viendo todas las etapas. Escribe un número para ver solo esa etapa" + (canEdit() ? " y guardar en ella los waypoints nuevos." : ".")
    : `Viendo la etapa ${state.stageFilter}: ${rallyWps().filter((w) => stageKey(w) === state.stageFilter).length} WP.` + (canEdit() ? " Los waypoints nuevos se guardan aquí." : "");

  const sd = $("stageDel"), st = state.stageFilter;
  sd.hidden = !r || !canEdit() || st === "all" || st === "";
  if (sd.dataset.stage !== st) { sd.dataset.stage = st; delete sd.dataset.armed; sd.className = "ghost"; sd.textContent = `Eliminar etapa ${st}`; }

  $("readBtn").disabled = !r || !state.photos.length || state.reading;
  $("wSave").disabled = !r;
  $("mapTitle").textContent = r ? scopeLabel() : "Mapa";
  renderTable(); renderTracks(); renderMap(); renderReview(); renderDownloads(); renderPlan(); renderRecTab();
}

function renderTable() {
  const tb = $("wpBody"); tb.textContent = "";
  const list = visibleWps();
  if (!list.length) {
    const tr = document.createElement("tr"); const td = document.createElement("td"); td.colSpan = 8; td.className = "hint";
    const inStage = rallyWps().filter((w) => state.stageFilter === "all" || stageKey(w) === state.stageFilter).length;
    td.textContent = inStage && rally() ? "Ningún waypoint coincide con el filtro." : rally() ? "Aún no hay waypoints " + (state.stageFilter === "all" ? "aquí." : "en la " + stageLabel(state.stageFilter).toLowerCase() + ".") + (canEdit() ? " Importa las fotos del roadbook en el paso 3." : "") : "Todavía no hay ninguna prueba.";
    tr.append(td); tb.append(tr);
  }
  let last = null;
  list.forEach((w) => {
    const k = stageKey(w);
    if (k !== last) {
      last = k;
      const h = document.createElement("tr"); h.className = "stagehead"; const td = document.createElement("td"); td.colSpan = 8;
      const inSt = list.filter((x) => stageKey(x) === k), pt = sumPts(inSt);
      td.textContent = stageLabel(k) + " · " + inSt.length + " WP" + (pt ? " · " + pt + " pts" : ""); h.append(td); tb.append(h);
    }
    const tr = document.createElement("tr"); tr.id = "row-" + w.id; tr.className = (state.hi === w.id ? "hi" : "") + (filt.off.has(w.id) ? " off" : "");
    const tdc = document.createElement("td"); const cb = document.createElement("input"); cb.type = "checkbox"; cb.style.width = "auto";
    cb.checked = !filt.off.has(w.id); cb.setAttribute("aria-label", "Ver " + w.name + " en el mapa");
    cb.onchange = () => { if (cb.checked) filt.off.delete(w.id); else filt.off.add(w.id); tr.classList.toggle("off", !cb.checked); renderMap(); renderDownloads(); renderScope(); renderPlan(); };
    tdc.append(cb); tr.append(tdc);
    [[w.name, "nm"], [fmtCoord(w.lat, true, state.fmt), "c"], [fmtCoord(w.lon, false, state.fmt), "c"], [w.page || "", "c"]]
      .forEach(([t, cls]) => { const td = document.createElement("td"); td.textContent = t; if (cls) td.className = cls; tr.append(td); });
    const tdp = document.createElement("td"); tdp.className = "c pts"; tdp.textContent = w.pts ? w.pts + " pts" : "";
    tr.append(tdp);
    { const td = document.createElement("td"); td.textContent = w.desc || ""; tr.append(td); }
    const act = document.createElement("td"); act.className = "act";
    const earthBtn = (w) => { // one waypoint, opened in Google Earth Pro
      const b = document.createElement("button"); b.type = "button"; b.className = "gm"; b.textContent = "Earth";
      b.title = "Abrir " + w.name + " en Google Earth Pro";
      b.onclick = () => download(slug(w.name) + ".kml", buildKml([w]), "application/vnd.google-earth.kml+xml");
      return b;
    };
    const link = (txt, href) => { const a = document.createElement("a"); a.className = "gm"; a.target = "_blank"; a.rel = "noopener"; a.href = href; a.textContent = txt; return a; };
    act.append(link("Maps", `https://www.google.com/maps/search/?api=1&query=${w.lat},${w.lon}`), " ", earthBtn(w));
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
    tr.onclick = (ev) => { if (ev.target.closest("a,button,input,select")) return; state.hi = w.id; renderTable(); renderMap(); };
    tb.append(tr);
  });
  renderScope();
}
function renderScope() {
  const n = visibleWps().length, m = mapWps().length;
  const pv = sumPts(visibleWps()), pm = sumPts(mapWps());
  $("exportScope").textContent = n + " waypoints" + (pv ? ` (${pv} pts)` : "") + " · " + scopeLabel() + (m !== n ? ` · ${m} en el mapa` + (pm ? ` (${pm} pts)` : "") : "");
  const sel = $("fStage"), opts = [["all", "Todas"], ...allStages().map((k) => [k, stageLabel(k) + (kindLabel(k) ? " · " + kindLabel(k) : "")])];
  if (sel.options.length !== opts.length || [...sel.options].some((o, i) => o.value !== opts[i][0] || o.textContent !== opts[i][1])) {
    sel.textContent = ""; opts.forEach(([v, t]) => { const o = document.createElement("option"); o.value = v; o.textContent = t; sel.append(o); });
  }
  sel.value = state.stageFilter;
  // the same year and stage above the map, so the stage is picked right where the GPS and the routes are
  // above the map: years 2026 to 2030 and stages 1 to 6 always offered (plus any other already used)
  const ms = $("mStage"); ms.textContent = "";
  const stN = [...new Set(["1", "2", "3", "4", "5", "6", ...allStages().filter((k) => k !== "")])].sort(natural);
  if (state.stageFilter === "all" || state.stageFilter === "") { const o = new Option("Elige", ""); o.disabled = true; ms.append(o); }
  stN.forEach((k) => ms.append(new Option(String(k) + (kindLabel(k) ? " · " + kindLabel(k) : ""), k)));
  ms.value = stN.includes(state.stageFilter) ? state.stageFilter : "";
  const mk = $("mKind"), kOk = state.stageFilter !== "all" && state.stageFilter !== "";
  mk.disabled = !kOk || !canEdit(); mk.value = kOk ? (stageKind(state.stageFilter) === "seguimiento" ? "seg_wp" : stageKind(state.stageFilter)) : "";
  const my = $("mYear"); my.textContent = "";
  const yrs = [...new Set([2026, 2027, 2028, 2029, 2030, ...state.rallies.map((x) => x.year)])].sort((a, b) => a - b);
  yrs.forEach((y) => {
    const rs = ralliesSorted().filter((x) => x.year === y);
    if (rs.length) rs.forEach((x) => my.append(new Option(String(y) + (rs.length > 1 ? " " + x.name : ""), x.id)));
    else if (canEdit()) my.append(new Option(String(y), "y:" + y));
  });
  my.value = state.rallyId || "";
  $("fClear").hidden = !filt.text && filt.from === null && filt.to === null && !filt.off.size && !filt.ptsOff.size && !filt.only;
  renderPtsFilter();
}
// one tick per score the waypoints of this stage really have (15, 25…), plus "Sin pts"; untick to hide them
function renderPtsFilter() {
  const box = $("fPts"), count = new Map();
  rallyWps().filter((w) => state.stageFilter === "all" || stageKey(w) === state.stageFilter)
    .forEach((w) => count.set(ptsKey(w), (count.get(ptsKey(w)) || 0) + 1));
  const keys = [...count.keys()].sort((a, b) => (a === "sin") - (b === "sin") || a - b);
  const sig = keys.map((k) => k + ":" + count.get(k) + ":" + filt.ptsOff.has(k)).join(",");
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.querySelectorAll("label").forEach((l) => l.remove());
  box.hidden = !keys.length || (keys.length === 1 && keys[0] === "sin");
  keys.forEach((k) => {
    const l = document.createElement("label"), cb = document.createElement("input");
    cb.type = "checkbox"; cb.value = k; cb.checked = !filt.ptsOff.has(k);
    cb.onchange = () => { if (cb.checked) filt.ptsOff.delete(k); else filt.ptsOff.add(k); refilter(); };
    l.append(cb, ` ${k === "sin" ? "Sin pts" : k + " pts"} (${count.get(k)})`); box.append(l);
  });
}
const numOrNull = (v) => v === "" ? null : parseInt(v, 10);
const refilter = () => { renderTable(); renderMap(); renderDownloads(); renderPlan(); };
$("fStage").onchange = (e) => pickStage(e.target.value);
// deletes the route picked in «Seguir ruta» (a track, a recording or a planner's proposal), after asking
$("mDel").onclick = async () => {
  // the route chosen in «Seguir ruta», or else the only route on the map (it may come from another stage or have none)
  let k = $("followSel").value, r = followRoutes().find((x) => x.key === k);
  if (!r) {
    const shown = visibleTracks().map((t) => ({ key: "t" + t.id, name: (t.kind === "grabada" ? "⏺ " : "") + t.name }));
    if (plan.stage === state.stageFilter && plan.sel !== null && plan.alts[plan.sel]) shown.push({ key: "p" + plan.sel, name: `Propuesta ${plan.sel + 1}: ${plan.alts[plan.sel].name}` });
    if (shown.length === 1) { r = shown[0]; k = r.key; }
  }
  if (!r) { showNotice(state.stageFilter === "all" ? "Elige primero la etapa." : "Esta etapa no tiene ninguna ruta que eliminar."); return; }
  if (!confirm(`¿Seguro que quieres eliminar «${r.name}»? No se puede deshacer.`)) return;
  try {
    if (k[0] === "p") {
      plan.alts.splice(+k.slice(1), 1); plan.sel = null;
      if (plan.alts.length) await savePlan($("pMsg").textContent);
      else { must(await sb.from("plans").delete().eq("rally_id", state.rallyId).eq("stage", state.stageFilter)); idb.del("kv", planKey()).catch(() => {}); }
    } else {
      const id = k.slice(1), t = state.tracks.find((x) => String(x.id) === id);
      must(await sb.from("tracks").delete().eq("id", t ? t.id : id));
      if (filt.rec != null && String(filt.rec) === id) filt.rec = null;
    }
    filt.follow = null; showNotice(`«${r.name}» eliminada.`);
    await loadAll(); renderPlan(); renderFollow();
  } catch (e) { showNotice(writeErr(e)); }
};
// the stage's type: what the map shows for it (its track, or its waypoints)
$("mKind").onchange = async (e) => {
  const st = state.stageFilter, kind = e.target.value; if (!kind || st === "all" || st === "") return;
  try { must(await sb.from("stages").upsert({ rally_id: state.rallyId, stage: st, kind, created_by: state.user.email })); }
  catch (er) { showNotice(writeErr(er)); render(); return; }
  state.stages = (state.stages || []).filter((x) => !(x.rallyId === state.rallyId && x.stage === st)).concat({ rallyId: state.rallyId, stage: st, kind });
  render();
};
$("mStage").onchange = (e) => { if (e.target.value) pickStage(e.target.value); };
$("mYear").onchange = async (e) => {
  const v = e.target.value;
  if (v.startsWith("y:")) {
    // a year with nothing yet: it is created with the same rally name
    try {
      const ref = must(await sb.from("rallies").insert({ year: +v.slice(2), name: (rally() || {}).name || "Rally de Marruecos" }).select().single());
      state.rallies.push(rallyIn(ref)); state.rallyId = ref.id;
    } catch (er) { showNotice(writeErr(er)); render(); return; }
  } else state.rallyId = v;
  state.stageFilter = "all"; state.hi = null; resetDel(); render();
};
$("sYear").onchange = (e) => { $("fYear").value = e.target.value; $("fYear").onchange({ target: $("fYear") }); if (e.target.value === "new") e.target.value = state.rallyId || ""; };
$("fYear").onchange = (e) => {
  if (e.target.value === "new") { e.target.value = state.rallyId || ""; setTab("imp"); openYearForm(); $("yearForm").scrollIntoView({ behavior: "smooth", block: "center" }); return; }
  state.rallyId = e.target.value; state.stageFilter = "all"; state.hi = null; resetDel(); render();
};
$("allStages").onclick = () => pickStage("all");
// step 2's stage number, its chips and the table's stage filter always show the same stage
function pickStage(k) {
  // a route picked in another stage must not stay on this stage's map
  state.stageFilter = k; state.hi = null; filt.follow = null; filt.trk = ""; filt.only = null; filt.rec = null;
  $("stageNo").value = k === "all" ? "" : k;
  render();
}
$("fText").addEventListener("input", (e) => { filt.text = e.target.value.trim().toLowerCase(); refilter(); });
$("fFrom").addEventListener("input", (e) => { filt.from = numOrNull(e.target.value); refilter(); });
$("fTo").addEventListener("input", (e) => { filt.to = numOrNull(e.target.value); refilter(); });
$("fTracks").onchange = (e) => { filt.tracks = e.target.checked; renderMap(); renderDownloads(); };
$("fAll").onclick = () => { visibleWps().forEach((w) => filt.off.delete(w.id)); refilter(); };
$("fNone").onclick = () => { visibleWps().forEach((w) => filt.off.add(w.id)); refilter(); };
$("fClear").onclick = () => {
  Object.assign(filt, { text: "", from: null, to: null, only: null }); filt.off.clear();
  filt.ptsOff.clear();
  $("fText").value = ""; $("fFrom").value = ""; $("fTo").value = ""; refilter();
};

/* ---------- map (satellite, no key needed) ---------- */
let lmap = null, layer = null, fitKey = "", measure = [];
let adding = null; // creating waypoints by tapping the map: { made: [ids created in this go] }
const TOUCH = window.matchMedia && matchMedia("(pointer: coarse)").matches;
// direction arrows along tracks and routes, spaced on screen so they stay readable at any zoom
let arrowLayer = null, arrowLines = [];
const arrow = (pts, color) => { if (pts.length > 1) arrowLines.push({ pts, color }); };
function drawArrows() {
  if (!arrowLayer) return;
  arrowLayer.clearLayers();
  const view = lmap.getBounds().pad(0.1), STEP = 80;
  arrowLines.forEach(({ pts, color }) => {
    let left = STEP / 2, prev = lmap.latLngToLayerPoint(pts[0]);
    for (let i = 1; i < pts.length; i++) {
      const cur = lmap.latLngToLayerPoint(pts[i]), len = prev.distanceTo(cur);
      if (len > 0) {
        const ang = Math.atan2(cur.y - prev.y, cur.x - prev.x) * 180 / Math.PI;
        for (let d = left; d <= len; d += STEP) {
          const at = lmap.layerPointToLatLng(L.point(prev.x + (cur.x - prev.x) * d / len, prev.y + (cur.y - prev.y) * d / len));
          if (!view.contains(at)) continue;
          L.marker(at, { pane: "arrows", rotateWithView: true, interactive: false, keyboard: false, icon: L.divIcon({ className: "dir-arrow", iconSize: [14, 14], iconAnchor: [7, 7],
            html: `<svg viewBox="0 0 14 14" style="transform:rotate(${ang.toFixed(0)}deg)"><path d="M4 2.5 L10 7 L4 11.5" fill="none" stroke="#000" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" opacity=".55"/><path d="M4 2.5 L10 7 L4 11.5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>` }) }).addTo(arrowLayer);
        }
        left = ((left - len) % STEP + STEP) % STEP;
        if (left === 0) left = STEP;
      }
      prev = cur;
    }
  });
}
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
// the next measuring point: with my position as the start it stays the start, so each tap measures from where I am
const addMeasure = (p) => measure[0] && measure[0].gps ? [measure[0], p] : measure.length === 1 ? [measure[0], p] : [p];
function gpsMeasure(lat, lon) {
  if (measure[0] && measure[0].gps) { measure = []; renderMap(); return false; }
  measure = [{ id: null, gps: true, lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6, name: "Tu posición" }];
  renderMap(); return true;
}
const fmtKm = (d) => d < 1 ? Math.round(d * 1000) + " m" : d.toLocaleString("es", { maximumFractionDigits: 2 }) + " km";
function loadMaps() {
  if (lmap) return;
  if (!window.L) { $("gmap").innerHTML = '<p class="hint" style="padding:16px">No se pudo cargar el mapa.</p>'; return; }
  // two fingers turn the map (leaflet-rotate); the compass button puts north back up or the map along the way I drive
  lmap = L.map($("gmap"), { center: [31.5, -5.5], zoom: 6, rotate: true, touchRotate: true, shiftKeyRotate: true, bearing: 0, rotateControl: false });
  const layersCtl = setupLayers(lmap);
  // undo / finish on the map itself, so they are at hand with the map full screen
  const fl = document.createElement("div"); fl.className = "mapfloat"; fl.id = "mapFloat"; fl.hidden = true;
  fl.innerHTML = '<button type="button" id="flUndo">↶ Deshacer</button><button type="button" class="ok" id="flEnd">✓ Terminar</button><button type="button" id="flCancel">✕ Cancelar</button>';
  L.DomEvent.disableClickPropagation(fl); lmap.getContainer().append(fl);
  fl.querySelector("#flUndo").onclick = () => (drawing ? drawUndo() : $("addUndo").click());
  fl.querySelector("#flEnd").onclick = () => (drawing ? $(drawing.alt ? "drawAlt" : "drawSave").click() : $("addEnd").click());
  fl.querySelector("#flCancel").onclick = () => $("drawCancel").click();
  setupGps({ map: lmap, layers: layersCtl, busy: () => !!adding, sb, canEdit, rallyId: () => state.rallyId, stage: () => $("recStage").value, user: () => state.user, writeErr, onSaved: () => loadAll(),
    onMeasure: gpsMeasure, routes: followRoutes, waypoints: () => rallyWps().filter((w) => stageKey(w) === ($("recStage").value || (state.stageFilter !== "all" ? state.stageFilter : ""))), onMove: (lat, lon) => {
      // measuring from where I am: the start follows the GPS, redrawn every few seconds
      const g = measure[0]; if (!g || !g.gps) return;
      g.lat = Math.round(lat * 1e6) / 1e6; g.lon = Math.round(lon * 1e6) / 1e6;
      if (Date.now() - (g.drawn || 0) > 3000) { g.drawn = Date.now(); renderMap(); }
    } });
  layer = L.layerGroup().addTo(lmap);
  // seen from far the waypoint numbers pile up: they show from zoom 11
  const far = () => $("gmap").classList.toggle("far", lmap.getZoom() < 11);
  lmap.on("zoomend", far); far();
  lmap.createPane("arrows", lmap._norotatePane).style.zIndex = 450;
  arrowLayer = L.layerGroup().addTo(lmap);
  lmap.on("zoomend moveend", drawArrows);
  // big buttons on the map while measuring: go back one point, or start from scratch
  const Clear = L.Control.extend({ options: { position: "topright" }, onAdd() {
    const d = L.DomUtil.create("div", "measure-ctl"); d.id = "measureCtl"; d.hidden = true;
    d.innerHTML = '<button type="button" id="measureBack">↶ Atrás</button><button type="button" id="measureClear">✕ Borrar medida</button>';
    L.DomEvent.disableClickPropagation(d);
    d.querySelector("#measureBack").onclick = () => { measure = measure.slice(0, -1); renderMap(); };
    d.querySelector("#measureClear").onclick = () => { measure = []; state.hi = null; renderTable(); renderMap(); };
    return d;
  } });
  new Clear().addTo(lmap);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && measure.length && !drawing) { measure = []; state.hi = null; renderTable(); renderMap(); } });
  lmap.on("click", (e) => {
    if (drawing) { drawStep(); drawing.pts.push([Math.round(e.latlng.lat * 1e6) / 1e6, Math.round(e.latlng.lng * 1e6) / 1e6]); drawing.wpAt.push(null); renderMap(); renderDraw(); return; }
    if (adding) { addWpAt(e.latlng); return; }
    // a tap on the map is a measuring point too
    const p = { id: null, lat: Math.round(e.latlng.lat * 1e6) / 1e6, lon: Math.round(e.latlng.lng * 1e6) / 1e6, name: "Punto" };
    measure = addMeasure(p);
    renderMap();
  });
  renderMap();
}
// the map box (with its bars) fills the screen; real full screen where the browser allows it, otherwise the whole window
const mapBox = () => $("gmap").closest(".mapbox");
// in full screen the bars live in a menu on the right; the button opens and closes it without moving the map
function setMenu(open) {
  const head = mapBox().querySelector(".boxhead");
  if (open && head) $("mapMenu").style.top = (head.offsetTop + head.offsetHeight + 6) + "px";
  $("mapMenu").classList.toggle("open", open);
  $("mapMenuBtn").setAttribute("aria-expanded", String(open));
  $("mapMenuBtn").textContent = open ? "✕ Cerrar menú" : "☰ Menú";
}
$("mapMenuBtn").onclick = () => setMenu(!$("mapMenu").classList.contains("open"));
// what is going on (recording, following a route) stays in sight with the menu closed
setInterval(() => { if (!document.body.classList.contains("mapfull")) return; $("fullStatus").textContent = [$("recInfo").textContent, $("followInfo").textContent].filter(Boolean).join(" · "); }, 1000);
function setMapFull(on) {
  mapBox().classList.toggle("full", on); document.body.classList.toggle("mapfull", on);
  setMenu(false); $("fullStatus").textContent = "";
  $("mapFull").textContent = on ? "✕ Salir de pantalla completa" : "⛶ Pantalla completa";
  if (lmap) setTimeout(() => lmap.invalidateSize(), 50);
}
$("mapFull").onclick = async () => {
  const on = !mapBox().classList.contains("full");
  if (on) { setMapFull(true); try { if (mapBox().requestFullscreen) await mapBox().requestFullscreen(); } catch (e) {} }
  else { if (document.fullscreenElement) await document.exitFullscreen().catch(() => {}); setMapFull(false); }
};
document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement && mapBox().classList.contains("full")) setMapFull(false); setTimeout(() => lmap && lmap.invalidateSize(), 50); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && mapBox().classList.contains("full") && !document.fullscreenElement) setMapFull(false); });
function renderMap() {
  if (!lmap) return;
  layer.clearLayers(); arrowLines = []; drawArrows();
  const joined = drawing ? new Set(drawing.wpAt.filter(Boolean)) : null;
  // a «Seguimiento track» stage shows its track; a waypoint stage, its waypoints (and the routes driven or followed)
  const kind = state.stageFilter !== "all" ? stageKind(state.stageFilter) : "";
  const chosen = kind === "caza" ? rallyTracks().filter((t) => stageKey(t) === state.stageFilter && isChosen(t)) : [];
  const byKind = (t) => kind === "seg_track" || t.kind === "grabada" || filt.follow != null || filt.rec === t.id || drawing || chosen.includes(t);
  const list = kind === "seg_track" && !drawing && !adding ? [] : mapWps().filter((w) => !joined || !$("drawOnly").checked || joined.has(w.id));
  const trks = visibleTracks().filter((t) => !kind || byKind(t));
  const imp = rallyTracks().filter((t) => stageKey(t) === state.stageFilter && t.kind !== "grabada");
  $("scaleTxt").textContent = kind === "seg_track" ? (imp.length ? `${kindLabel(state.stageFilter)}: ${imp.map((t) => `«${t.name}» ${kmOf(t.segs).toFixed(1)} km`).join(", ")}` : `${kindLabel(state.stageFilter)}: esta etapa aún no tiene traza. Impórtala en la pestaña Importar.`)
    : kind ? `${kindLabel(state.stageFilter)}: ${mapWps().length ? mapWps().length + " waypoints" + (sumPts(mapWps()) ? ` (${sumPts(mapWps())} pts)` : "") : "aún no tiene waypoints. Impórtalos en la pestaña Importar."}` +
      (kind !== "caza" ? "" : chosen.length ? ` · Ruta elegida: «${chosen[0].meta.alt || chosen[0].name}» ${kmOf(chosen[0].segs).toFixed(1)} km` : " · Sin ruta elegida: confírmala en el Planificador.")
    : list.length || trks.length ? "Rutas en amarillo · waypoints en verde" : "Sin waypoints en esta selección";
  if (!list.length && !trks.length) return;
  const pts = list.map((w) => [w.lat, w.lon]);
  trks.forEach((t) => t.segs.forEach((seg) => {
    L.polyline(seg, { color: "#000", weight: 6, opacity: .35, interactive: false }).addTo(layer);
    L.polyline(seg, { color: TRACK, weight: 4, opacity: 1 }).bindTooltip(t.name).addTo(layer);
    arrow(seg, TRACK);
    seg.forEach((p) => pts.push(p));
  }));
  // the stage's proposals show on every tab and every device: they are kept in the database
  // once one is confirmed, the Libro de ruta shows only that one (unless a proposal is picked in «Seguir ruta»)
  const showAlts = state.tab === "plan" || !chosen.length || filt.follow === "";
  if (showAlts && plan.stage === state.stageFilter && isCaza(state.stageFilter)) plan.alts.forEach((a, i) => {
    const on = plan.sel === i;
    if (on) L.polyline(a.pts, { color: "#000", weight: 8, opacity: .35, interactive: false }).addTo(layer);
    L.polyline(a.pts, { color: altCol(i), weight: on ? 5 : 3, opacity: on ? 1 : .75, dashArray: on ? null : "6 6" })
      .bindTooltip(`Propuesta ${i + 1}: ${a.name}`).on("click", () => pickAlt(i)).addTo(layer);
    if (on) arrow(a.pts, altCol(i));
    // stretches with no way on the map: drawn as a dotted line so they are not taken for a track
    if (on) (a.sat || []).forEach(({ line, note }) => {
      L.polyline(line, { color: "#fff", weight: 2, dashArray: "8 6", opacity: 1 }).bindTooltip("Pista vista en el satélite (no está en el mapa)" + (note ? ": " + note : "")).addTo(layer);
    });
    if (on) a.gaps.forEach(({ A: p, B: q }) => {
      L.polyline([p, q], { color: "#fff", weight: 7, opacity: .9, interactive: false }).addTo(layer);
      L.polyline([p, q], { color: "#111", weight: 4, dashArray: "1 9", lineCap: "round" }).bindTooltip("Sin camino en el mapa: tramo campo a través").addTo(layer);
    });
  });
  if (drawing) {
    L.polyline(drawing.pts, { color: "#000", weight: 7, opacity: .35, interactive: false }).addTo(layer);
    L.polyline(drawing.pts, { color: TRACK, weight: 4, opacity: 1, interactive: false }).addTo(layer);
    arrow(drawing.pts, TRACK);
    drawing.pts.forEach((p) => L.circleMarker(p, { radius: 4, color: TRACK, weight: 2, fillColor: "#fff", fillOpacity: 1, interactive: false }).addTo(layer));
  }
  // distance and course between the two points tapped (waypoints or any spot); with one tapped waypoint, to the next one
  const mm = measure.map((m) => m.id ? list.find((w) => w.id === m.id) || null : m).filter(Boolean);
  if ($("measureCtl")) $("measureCtl").hidden = !mm.length || !!drawing;
  const leg = (a, b, dashed) => {
    const d = distKm(a, b), cap = bearing(a, b);
    L.polyline([[a.lat, a.lon], [b.lat, b.lon]], { color: "#000", weight: 6, opacity: .45, interactive: false }).addTo(layer);
    L.polyline([[a.lat, a.lon], [b.lat, b.lon]], { color: "#fff", weight: 3, opacity: 1, dashArray: dashed ? "6 6" : null, interactive: false })
      .bindTooltip(`${fmtKm(d)} · rumbo ${cap}°`, { permanent: true, direction: "center", className: "wp-lbl dist" }).addTo(layer);
    return `${a.name} → ${b.name}: ${fmtKm(d)} en línea recta, rumbo ${cap}°`;
  };
  mm.filter((m) => !m.id && !m.gps).forEach((m) => L.circleMarker([m.lat, m.lon], { radius: 6, color: "#000", weight: 2, fillColor: "#fff", fillOpacity: 1, interactive: false }).addTo(layer));
  if (mm.length === 2) $("scaleTxt").textContent = leg(mm[0], mm[1], false) + (mm[0].gps ? " · toca otro punto para medir desde tu posición" : " · toca otro sitio para empezar de nuevo");
  else if (mm.length === 1) {
    const a = mm[0], i = a.id ? list.findIndex((w) => w.id === a.id) : -1, nx = i >= 0 ? list[i + 1] : null;
    $("scaleTxt").textContent = a.gps ? "Desde tu posición: toca un waypoint o cualquier punto del mapa para ver la distancia y el rumbo" : nx ? leg(a, nx, true) + " (al siguiente) · toca otro punto para medir hasta él"
      : `Desde ${a.name}: toca otro waypoint o cualquier punto del mapa`;
  }
  list.forEach((w) => {
    const tapWp = (e) => {
      L.DomEvent.stopPropagation(e);
      if (drawing) { drawStep(); drawing.pts.push([w.lat, w.lon]); drawing.wpAt.push(w.id); renderMap(); renderDraw(); return; }
      const me = { id: w.id };
      if (measure.length === 1 && measure[0].id === w.id) measure = [];
      else measure = addMeasure(me);
      // stay on the map: the page must not move to the table
      const y = window.scrollY; state.hi = w.id; renderTable(); renderMap(); window.scrollTo(0, y);
    };
    const hi = state.hi === w.id || measure.some((m) => m.id === w.id) || (joined && joined.has(w.id));
    const out = state.tab === "plan" && plan.sel !== null && plan.alts[plan.sel] && !plan.alts[plan.sel].ids.has(w.id);
    const m = L.circleMarker([w.lat, w.lon], { radius: hi ? 10 : 7, color: hi ? "#000" : "#fff", weight: 2, fillColor: out ? "#888" : WPC, fillOpacity: out ? .45 : 1, opacity: out ? .5 : 1 })
      .bindTooltip(w.pts ? `${w.name} · ${w.pts}` : w.name, { permanent: true, direction: "top", offset: [0, -8], className: "wp-lbl" })
      .on("click", tapWp)
      .addTo(layer);
    // on a phone or tablet a finger needs a bigger target than the dot
    if (TOUCH) L.circleMarker([w.lat, w.lon], { radius: 20, stroke: false, fillOpacity: 0 }).on("click", tapWp).addTo(layer);
    if (hi) m.bringToFront();
  });
  // a new stage takes the map to where it starts; all stages, or a route just picked, show everything.
  // Adding or hiding waypoints doesn't move the map.
  const key = state.rallyId + "|" + state.stageFilter;
  if (pts.length && key !== fitKey) {
    const forced = fitKey === ""; fitKey = key;
    const start = !forced && state.stageFilter !== "all" ? stageStart(list, trks) : null;
    if (start) lmap.setView(start, Math.max(13, Math.min(lmap.getZoom(), 15)));
    else if (pts.length === 1) lmap.setView(pts[0], 15);
    else lmap.fitBounds(pts, { padding: [40, 40] });
  }
  drawArrows();
}

// where a stage starts: its start waypoint (SALIDA, DSS, START, INICIO), else the first in order, else the start of its route
function stageStart(list, trks) {
  const isStart = (w) => /\b(salida|dss|start|inicio)\b/i.test(`${w.name} ${w.desc || ""}`) && !/llegada|ass\b|finish|meta\b/i.test(`${w.name} ${w.desc || ""}`);
  const w = list.find(isStart) || list[0];
  if (w) return [w.lat, w.lon];
  const t = trks.find((x) => x.kind !== "grabada") || trks[0];
  return t && t.segs[0] && t.segs[0][0] ? t.segs[0][0] : null;
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
$("stageNo").addEventListener("input", () => {
  $("stageNo").classList.remove("need");
  state.stageFilter = currentStage() || "all"; state.hi = null; render();
});
$("stageNo").addEventListener("change", () => {
  const s = currentStage();
  void s;
});

/* ---------- step 3: photos ---------- */
function setPhotos(files) {
  const all = [...files];
  state.photos = all.filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name));
  const t = $("thumbs"); t.querySelectorAll("img").forEach((i) => URL.revokeObjectURL(i.src)); t.textContent = "";
  state.photos.forEach((f) => { const i = document.createElement("img"); i.src = URL.createObjectURL(f); i.alt = f.name; t.append(i); });
  $("clearPhotos").hidden = !state.photos.length; $("readBtn").hidden = true;
  $("photoMsg").textContent = state.photos.length ? state.photos.length + " foto(s) cargadas." : "";
  if (all.length && !state.photos.length) $("photoMsg").textContent = "Eso no parece una foto. Usa JPG, PNG o HEIC.";
  render();
  if (state.photos.length) readPhotos();
}
// every import first asks for the year and the stage it goes to (filled in with the ones on screen)
function askWhere(what) {
  return new Promise((done) => {
    const sel = $("whereYear"); sel.textContent = "";
    ralliesSorted().forEach((x) => sel.append(new Option(String(x.year) + (state.rallies.filter((o) => o.year === x.year).length > 1 ? " " + x.name : ""), x.id)));
    if (!sel.options.length) { done(null); setTab("imp"); openYearForm(); showNotice("Crea primero el año y vuelve a importar."); return; }
    sel.value = state.rallyId || sel.options[0].value;
    $("whereStage").value = currentStage() || (state.stageFilter !== "all" ? state.stageFilter : "");
    $("whereWhat").textContent = what;
    $("whereWrap").hidden = false; setTimeout(() => $("whereStage").focus(), 50);
    const end = (ok) => {
      $("whereWrap").hidden = true; $("whereForm").onsubmit = $("whereNo").onclick = null;
      if (!ok) { done(null); return; }
      const st = String(parseInt($("whereStage").value, 10));
      state.rallyId = sel.value; $("stageNo").value = st; state.stageFilter = st; state.hi = null; render();
      done({ rallyId: sel.value, stage: st });
    };
    $("whereForm").onsubmit = (e) => { e.preventDefault(); end(true); };
    $("whereNo").onclick = () => end(false);
  });
}
const nFiles = (f) => f.length === 1 ? `«${f[0].name}»` : `${f.length} archivos`;
async function photosIn(files) { const f = [...files]; if (f.length) setPhotos(f); }
$("photos").addEventListener("change", (e) => photosIn(e.target.files));
$("clearPhotos").onclick = () => { $("photos").value = ""; setPhotos([]); };
const drop = $("drop");
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); photosIn(e.dataTransfer.files); });

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
  if (!rally()) { msg.textContent = "Crea primero el año."; return; }
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
      pts: parseInt(o.puntos, 10) || ptsIn(o.note || ""),
    }));
    // everything read waits in the table: tick the waypoints wanted, then save them to a stage and get their GPX
    const isOk = (x) => x.name && parseCoord(x.latRaw, true) !== null && parseCoord(x.lonRaw, false) !== null;
    rows.forEach((x) => { x.on = isOk(x); });
    state.pending = rows;
    $("photos").value = ""; setPhotos([]);
    const bad = rows.filter((x) => !isOk(x)).length;
    msg.textContent = `Leídos ${rows.length} waypoints. Marca en la tabla los que quieres y pulsa «Guardar los marcados y crear su GPX».` + (bad ? ` ${bad > 1 ? bad + " no se leyeron bien" : "Uno no se leyó bien"}: corrígelo o déjalo sin marcar.` : "");
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
    batch.push(wpOut({ rallyId: r.id, stage: st, name: x.name.trim(), lat: parseCoord(x.latRaw, true), lon: parseCoord(x.lonRaw, false), page: x.page.trim(), desc: x.desc.trim(), pts: x.pts || null, seq: seqBase + i, source: "foto", by: state.user.email }));
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
    [["name", "nm"], ["latRaw", "coord"], ["lonRaw", "coord"], ["page", "sm"], ["pts", "sm"], ["desc", ""]].forEach(([f, cls]) => {
      const td = document.createElement("td"); const inp = document.createElement("input"); inp.value = row[f] ?? ""; inp.id = "rv-" + f + "-" + i;
      if (cls) inp.className = cls;
      if (f === "pts") { inp.inputMode = "numeric"; inp.placeholder = "pts"; }
      inp.oninput = () => { row[f] = f === "pts" ? parseInt(inp.value, 10) || null : inp.value; if (cls === "coord") { mark(); if (ok()) { row.on = true; cb.checked = true; } } };
      td.append(inp); tr.append(td);
    });
    if (row.doubt) { tr.title = "Lectura dudosa: compárala con la foto"; tr.children[2].firstChild.style.borderColor = "var(--saffron)"; tr.children[3].firstChild.style.borderColor = "var(--saffron)"; }
    mark(); tb.append(tr);
  });
}
$("revCancel").onclick = () => { state.pending = null; render(); };
$("revSave").onclick = async () => {
  const rows = state.pending.filter((x) => x.on);
  if (!rows.length) { $("photoMsg").textContent = "Marca en la tabla los waypoints que quieres guardar."; return; }
  const bad = rows.filter((x) => parseCoord(x.latRaw, true) === null || parseCoord(x.lonRaw, false) === null || !x.name.trim());
  if (bad.length) { $("photoMsg").textContent = `Hay ${bad.length} fila(s) marcadas sin nombre o con coordenadas no válidas. Corrígelas o desmárcalas.`; return; }
  const where = await askWhere(`${rows.length} waypoint${rows.length > 1 ? "s" : ""} de las fotos.`); if (!where) return;
  const st = where.stage;
  $("revSave").disabled = true;
  try {
    const res = await saveRows(rows);
    state.pending = null;
    // the GPX of exactly those waypoints, in the order of the table
    const names = rows.map((x) => x.name.trim()), list = names.map((n) => rallyWps().find((w) => stageKey(w) === st && String(w.name) === n)).filter(Boolean);
    if (list.length) download(stageFile(st) + "_fotos.gpx", buildGpx(list, rally().year + " " + rally().name + " · " + stageLabel(st), []), "application/gpx+xml");
    $("photoMsg").textContent = `Guardados ${res.added} waypoints en la etapa ${st}` + (res.skipped ? `; ${res.skipped} ya existían y no se duplicaron` : "") + `. Descargado ${stageFile(st)}_fotos.gpx con ${list.length}.`;
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
$("trackFile").addEventListener("change", async (e) => { const f = [...e.target.files]; e.target.value = ""; if (f.length && await askWhere(`Track: ${nFiles(f)}.`)) importTracks(f); });
const tdrop = $("trkDrop");
tdrop.addEventListener("dragover", (e) => { e.preventDefault(); tdrop.classList.add("over"); });
tdrop.addEventListener("dragleave", () => tdrop.classList.remove("over"));
tdrop.addEventListener("drop", (e) => { e.preventDefault(); tdrop.classList.remove("over"); const f = [...e.dataTransfer.files]; if (f.length) askWhere(`Track: ${nFiles(f)}.`).then((ok) => ok && importTracks(f)); });
// the route picker by "Ver track": show only one route of the stage, or delete it
function renderTrkPick() {
  const list = stageTracks().sort((a, b) => natural(a.name, b.name));
  if (filt.trk && !list.some((t) => t.id === filt.trk)) filt.trk = "";
  const sel = $("fTrk"); sel.textContent = "";
  sel.append(new Option(list.length ? `Todas (${list.length})` : "No hay rutas", ""));
  list.forEach((t) => sel.append(new Option(`${t.kind === "grabada" ? "⏺ " : ""}${t.name} · ${kmOf(t.segs).toFixed(1)} km`, t.id)));
  sel.value = filt.trk; sel.disabled = !list.length;
  const del = $("fTrkDel"); del.disabled = !filt.trk; delete del.dataset.armed; del.textContent = "Eliminar ruta"; del.className = "ghost";
}
$("fTrk").onchange = (e) => { filt.trk = e.target.value; if (filt.trk) { filt.tracks = true; $("fTracks").checked = true; } fitKey = ""; renderTrkPick(); renderTracks(); renderMap(); renderDownloads(); };
$("fTrkDel").onclick = async () => {
  const del = $("fTrkDel"), t = rallyTracks().find((x) => x.id === filt.trk); if (!t) return;
  if (!del.dataset.armed) { del.dataset.armed = "1"; del.textContent = `¿Eliminar «${t.name}»?`; del.className = "warn"; return; }
  try {
    must(await sb.from("tracks").delete().eq("id", t.id));
    if (filt.only === t.id) filt.only = null;
    filt.trk = ""; await loadAll();
  } catch (e) { del.textContent = "Eliminar ruta"; delete del.dataset.armed; del.className = "ghost"; alert(writeErr(e)); }
};
// deletes the whole stage shown: its waypoints and its routes
$("stageDel").onclick = async () => {
  const sd = $("stageDel"), st = state.stageFilter; if (st === "all" || st === "") return;
  const nW = rallyWps().filter((w) => stageKey(w) === st).length, nT = rallyTracks().filter((t) => stageKey(t) === st).length;
  if (!sd.dataset.armed) { sd.dataset.armed = "1"; sd.className = "warn"; sd.textContent = `¿Seguro? Se borran ${nW} WP y ${nT} ruta${nT === 1 ? "" : "s"} de la etapa ${st}`; return; }
  sd.disabled = true;
  try {
    must(await sb.from("tracks").delete().eq("rally_id", state.rallyId).eq("stage", st));
    must(await sb.from("waypoints").delete().eq("rally_id", state.rallyId).eq("stage", st));
    state.stageFilter = "all"; $("stageNo").value = ""; filt.trk = ""; filt.only = null;
    await loadAll();
  } catch (e) { sd.textContent = writeErr(e); }
  sd.disabled = false; delete sd.dataset.armed; sd.dataset.stage = "";
};
// the routes driven with the phone's GPS, newest first
// recordings always go to a stage that already has waypoints: the one being viewed, or the one picked here
function renderRecStage() {
  const sel = $("recStage"); if (!sel || sel.disabled) return;
  // only the stage chosen in the Libro de ruta: everything about stages follows it
  const k = state.stageFilter !== "all" && state.stageFilter !== "" ? state.stageFilter : "";
  sel.textContent = "";
  sel.append(k ? new Option(`${stageLabel(k)} (${rallyWps().filter((w) => stageKey(w) === k).length} WP)`, k) : new Option("Elige la etapa", ""));
  sel.value = k;
}
// the routes the GPS can follow in the stage being recorded: its tracks, the options drawn and the planner's proposals
function followRoutes() {
  const st = state.stageFilter !== "all" ? state.stageFilter : null;
  if (st === null || st === "") return [];
  // the stage's own route first: it is the one «Iniciar ruta» follows
  const out = rallyTracks().filter((t) => stageKey(t) === st && t.kind !== "grabada").sort((a, b) => isChosen(b) - isChosen(a)).map((t) => ({ key: "t" + t.id, name: t.name, segs: t.segs }));
  if (plan.stage === st) plan.alts.forEach((a, i) => out.push({ key: "p" + i, name: `Propuesta ${i + 1}: ${a.name}`, segs: [a.pts] }));
  rallyTracks().filter((t) => stageKey(t) === st && t.kind === "grabada").forEach((t) => out.push({ key: "t" + t.id, name: "⏺ " + t.name, segs: t.segs }));
  return out;
}
$("followSel").addEventListener("change", (e) => {
  const k = e.target.value, r = followRoutes().find((x) => x.key === k);
  if (!r) { filt.follow = null; render(); return; }
  if (k[0] === "p") { plan.sel = +k.slice(1); filt.follow = ""; } else { filt.follow = k.slice(1); plan.sel = null; }
  filt.tracks = true; $("fTracks").checked = true;
  render(); renderPlan();
  if (lmap) lmap.fitBounds(r.segs.flat(), { padding: [30, 30] });
});
function renderFollow() {
  const sel = $("followSel"); if (!sel || sel.disabled) return;
  const list = followRoutes(), was = sel.value; sel.textContent = "";
  if (!list.length) sel.append(new Option(state.stageFilter === "all" ? "Elige la etapa" : "Esta etapa no tiene rutas", ""));
  list.forEach((r) => sel.append(new Option(r.name, r.key)));
  sel.value = list.length ? list[0].key : ""; void was;
  $("followBtn").disabled = !list.length && !sel.disabled;
}
function renderRecorded() {
  renderRecStage(); renderFollow();
  const list = rallyTracks().filter((t) => t.kind === "grabada" && state.stageFilter !== "all" && stageKey(t) === state.stageFilter).sort((a, b) => String(b.created).localeCompare(String(a.created)));
  $("recBox").hidden = !list.length;
  $("recSum").textContent = `Rutas grabadas (${list.length})`;
  const ul = $("recList"); ul.textContent = "";
  list.forEach((t) => {
    const li = document.createElement("li");
    const sw = document.createElement("span"); sw.className = "sw"; sw.style.background = TRACK;
    const m = t.meta || {}, secs = m.secs || 0;
    const nm = document.createElement("span"); nm.className = "em";
    nm.textContent = `${t.name} · ${kmOf(t.segs).toFixed(1)} km` + (secs ? ` · ${Math.floor(secs / 3600)} h ${String(Math.floor(secs / 60) % 60).padStart(2, "0")} min` : "");
    const see = document.createElement("button"); see.type = "button"; see.className = filt.rec === t.id ? "hl" : "ghost"; see.textContent = filt.rec === t.id ? "Ocultar" : "Ver en el mapa";
    see.onclick = () => {
      filt.rec = filt.rec === t.id ? null : t.id; filt.tracks = true; $("fTracks").checked = true;
      // a recorded route is seen with its stage's waypoints
      if (filt.rec && stageKey(t) !== "") { state.stageFilter = stageKey(t); $("stageNo").value = stageKey(t); filt.trk = ""; filt.only = null; state.hi = null; render(); }
      else { renderRecorded(); renderMap(); }
      if (filt.rec && lmap) lmap.fitBounds([...t.segs.flat(), ...mapWps().map((w) => [w.lat, w.lon])], { padding: [30, 30] });
    };
    const gx = document.createElement("button"); gx.type = "button"; gx.className = "ghost"; gx.textContent = "GPX";
    gx.onclick = () => routeGpx(t.name, t.segs, [], stageKey(t), t.rallyId);
    li.append(sw, nm, see, gx);
    if (canEdit()) {
      const del = document.createElement("button"); del.type = "button"; del.className = "ghost"; del.textContent = "Borrar";
      del.onclick = async () => {
        if (!del.dataset.armed) { del.dataset.armed = "1"; del.textContent = "¿Seguro?"; del.className = "warn"; return; }
        try { must(await sb.from("tracks").delete().eq("id", t.id)); if (filt.rec === t.id) filt.rec = null; await loadAll(); } catch (e) { $("gpsMsg").textContent = writeErr(e); }
      };
      li.append(del);
    }
    ul.append(li);
  });
}
function renderTracks() {
  renderTrkPick(); renderRecorded();
  // the routes of the stage chosen in step 2, each ready to download
  const ul = $("trackList"); ul.textContent = "";
  const st = state.stageFilter, list = st === "all" ? [] : rallyTracks().filter((t) => stageKey(t) === st)
    .sort((a, b) => (a.kind === "grabada") - (b.kind === "grabada") || natural(a.created, b.created));
  $("trkBox").hidden = !list.length;
  $("trkHead").textContent = `Rutas de la ${stageLabel(st).toLowerCase()} (${list.length})`;
  list.forEach((t) => {
    const li = document.createElement("li");
    const sw = document.createElement("span"); sw.className = "sw"; sw.style.background = TRACK;
    const tw = trackWps(t);
    const nm = document.createElement("span"); nm.className = "em";
    const b = document.createElement("b"); b.textContent = (t.kind === "grabada" ? "⏺ " : "") + t.name.replace(/\s*·\s*Etapa\s+\S+$/i, "");
    const sm = document.createElement("small"); sm.textContent = `${kmOf(t.segs).toFixed(1)} km` + (tw.length ? ` · ${tw.length} WP · ${sumPts(tw)} pts` : "");
    nm.append(b, sm);
    const acts = document.createElement("span"); acts.className = "acts";
    const gx = document.createElement("button"); gx.type = "button"; gx.className = "ghost"; gx.textContent = "⬇ Descargar";
    gx.title = "GPX de esta ruta con los waypoints de su etapa: primero los que une, luego los demás";
    gx.onclick = () => routeGpx(t.name, t.segs, tw, stageKey(t), t.rallyId);
    acts.append(gx);
    if (tw.length) {
      const only = document.createElement("button"); only.type = "button"; only.className = filt.only === t.id ? "hl" : "ghost";
      only.textContent = filt.only === t.id ? "Ver todos" : "Solo sus WP";
      only.title = "Apaga en el mapa y en la tabla los waypoints que no une esta ruta";
      only.onclick = () => { filt.only = filt.only === t.id ? null : t.id; refilter(); renderTracks(); };
      acts.append(only);
    }
    if (canEdit()) {
      const del = document.createElement("button"); del.type = "button"; del.className = "ghost"; del.textContent = "Borrar";
      del.onclick = async () => {
        if (!del.dataset.armed) { del.dataset.armed = "1"; del.textContent = "¿Seguro?"; del.className = "warn"; return; }
        try { must(await sb.from("tracks").delete().eq("id", t.id)); if (filt.only === t.id) filt.only = null; await loadAll(); } catch (e) { $("trkMsg").textContent = writeErr(e); }
      };
      acts.append(del);
    }
    li.append(sw, nm, acts);
    ul.append(li);
  });
}

async function saveTrack(name, segs, msgEl, wps = [], meta = null) {
  const st = currentStage();
  if (!st) { msgEl.textContent = "Pon primero el nº de etapa en el paso 2."; $("stageNo").classList.add("need"); $("stageNo").focus(); return false; }
  try {
    await ensureRally();
    const row = { rally_id: state.rallyId, stage: st, name, points: segs, created_by: state.user.email };
    if (wps.length) row.wps = wps.map((w) => w.id);
    if (meta) row.meta = meta;
    must(await sb.from("tracks").insert(row));
    await loadAll();
    msgEl.textContent = `Guardado «${name}» (${kmOf(segs).toFixed(1)} km` + (wps.length ? `, ${wps.length} WP, ${sumPts(wps)} pts` : "") + `) como track de la etapa ${st}. Sale en el mapa y en el GPX de la etapa.`;
    return true;
  } catch (e) { msgEl.textContent = writeErr(e); return false; }
}

/* ---------- route planner (its own tab) ---------- */
// the proposal confirmed in the planner for a «Caza waypoint» stage
const isChosen = (t) => !!(t.meta && t.meta.chosen);
const plan = { alts: [], sel: null, graph: null, graphKey: "", busy: false };
let mec = null, coches = null;
function setTab(t) {
  state.tab = t;
  document.body.classList.toggle("tab-plan", t === "plan");
  document.body.classList.toggle("tab-mec", t === "mec");
  document.body.classList.toggle("tab-car", t === "car");
  document.body.classList.toggle("tab-rec", t === "rec");
  document.body.classList.toggle("tab-imp", t === "imp");
  [["tabLibro", "libro"], ["tabPlan", "plan"], ["tabImp", "imp"], ["tabRec", "rec"], ["tabMec", "mec"], ["tabCar", "car"]].forEach(([id, k]) => $(id).setAttribute("aria-selected", String(t === k)));
  if (t === "mec") { mec = mec || setupMecanica({ sb, canEdit, user: () => state.user, writeErr }); mec.show(); }
  if (t === "rec") renderRecTab();
  if (t === "car") { coches = coches || setupCoches({ sb, canEdit, user: () => state.user, writeErr, toJpeg }); coches.show(); }
  if (drawing) { drawing = null; renderDraw(); }
  renderPlan(); renderMap();
  if (lmap) setTimeout(() => lmap.invalidateSize(), 0);
}
$("tabLibro").onclick = () => setTab("libro");
$("tabPlan").onclick = () => setTab("plan");
$("tabImp").onclick = () => setTab("imp");
$("tabMec").onclick = () => setTab("mec");
$("tabCar").onclick = () => setTab("car");
$("tabRec").onclick = () => setTab("rec");

// every recorded route of every year, grouped by year and stage
const fmtDur = (secs) => secs ? `${Math.floor(secs / 3600)} h ${String(Math.floor(secs / 60) % 60).padStart(2, "0")} min` : "";
function renderRecTab() {
  if (state.tab !== "rec") return;
  const box = $("recAll"); box.textContent = "";
  const recs = state.tracks.filter((t) => t.kind === "grabada");
  if (!recs.length) { const p = document.createElement("p"); p.className = "hint"; p.textContent = "Aún no hay rutas grabadas."; box.append(p); return; }
  ralliesSorted().forEach((r) => {
    const mine = recs.filter((t) => t.rallyId === r.id);
    if (!mine.length) return;
    const h = document.createElement("h3"); h.textContent = r.name || String(r.year); box.append(h);
    const stages = [...new Set(mine.map(stageKey))].sort((a, b) => a === "" ? 1 : b === "" ? -1 : natural(a, b));
    stages.forEach((st) => {
      const sec = document.createElement("div"); sec.className = "recstage";
      const nW = state.wps.filter((w) => w.rallyId === r.id && stageKey(w) === st).length;
      const nT = state.tracks.filter((t) => t.rallyId === r.id && stageKey(t) === st && t.kind !== "grabada").length;
      const h4 = document.createElement("h4");
      h4.textContent = stageLabel(st) + (st !== "" ? ` · ${nW} WP${nT ? " · " + nT + " traza" + (nT > 1 ? "s" : "") : ""}` : " (no están en ninguna etapa)");
      sec.append(h4);
      const ul = document.createElement("ul"); ul.className = "tracks";
      mine.filter((t) => stageKey(t) === st).sort((a, b) => String(b.created).localeCompare(String(a.created))).forEach((t) => {
        const li = document.createElement("li");
        const sw = document.createElement("span"); sw.className = "sw"; sw.style.background = TRACK;
        const nm = document.createElement("span"); nm.className = "em";
        nm.textContent = `${t.name} · ${kmOf(t.segs).toFixed(1)} km` + (fmtDur((t.meta || {}).secs) ? " · " + fmtDur(t.meta.secs) : "");
        const see = document.createElement("button"); see.type = "button"; see.className = "hl"; see.textContent = st !== "" ? "Ver con la etapa" : "Ver en el mapa";
        see.onclick = () => {
          state.rallyId = r.id; state.stageFilter = st !== "" ? st : "all"; $("stageNo").value = st;
          filt.rec = t.id; filt.trk = ""; filt.only = null; filt.tracks = true; $("fTracks").checked = true;
          setTab("libro"); render();
          setTimeout(() => { if (lmap) { lmap.fitBounds([...t.segs.flat(), ...mapWps().map((w) => [w.lat, w.lon])], { padding: [30, 30] }); $("gmap").scrollIntoView({ behavior: "smooth", block: "center" }); } }, 100);
        };
        const gx = document.createElement("button"); gx.type = "button"; gx.className = "ghost"; gx.textContent = "GPX";
        gx.onclick = () => routeGpx(t.name, t.segs, [], stageKey(t), t.rallyId);
        li.append(sw, nm, see, gx);
        if (canEdit()) {
          const del = document.createElement("button"); del.type = "button"; del.className = "ghost"; del.textContent = "Borrar";
          del.onclick = async () => {
            if (!del.dataset.armed) { del.dataset.armed = "1"; del.textContent = "¿Seguro?"; del.className = "warn"; return; }
            try { must(await sb.from("tracks").delete().eq("id", t.id)); if (filt.rec === t.id) filt.rec = null; await loadAll(); renderRecTab(); } catch (e) { $("recTabMsg").textContent = writeErr(e); }
          };
          li.append(del);
        }
        ul.append(li);
      });
      sec.append(ul); box.append(sec);
    });
  });
}
// the proposals are kept per stage, so the phone or tablet sees the ones calculated on the computer
const planKey = () => "plan:" + state.rallyId + ":" + state.stageFilter;
async function savePlan(note) {
  if (!canEdit() || !plan.alts.length) return;
  const alts = plan.alts.map(({ ids, wps, ...a }) => ({ ...a, wpIds: wps.map((w) => w.id) }));
  const row = { rally_id: state.rallyId, stage: state.stageFilter, alts, note, created_by: state.user.email, created_at: new Date().toISOString() };
  idb.put("kv", row, planKey()).catch(() => {});
  const { error } = await sb.from("plans").upsert(row);
  if (error) console.warn("plans", error.message);
}
async function loadPlan() {
  if (state.stageFilter === "all" || !state.rallyId) return;
  const key = planKey(), stage = state.stageFilter;
  let row = null;
  const { data, error } = await sb.from("plans").select("*").eq("rally_id", state.rallyId).eq("stage", stage).maybeSingle();
  if (!error && data) { row = data; idb.put("kv", data, key).catch(() => {}); }
  else if (error) { try { row = await idb.get("kv", key); } catch (e) {} }
  if (!row || !row.alts || !row.alts.length || plan.busy || plan.alts.length || planKey() !== key) return;
  const byId = new Map(rallyWps().map((w) => [w.id, w]));
  plan.alts = row.alts.map((a) => { const wps = a.wpIds.map((id) => byId.get(id)).filter(Boolean); return { ...a, wps, ids: new Set(wps.map((w) => w.id)) }; });
  plan.sel = 0;
  $("pMsg").textContent = `Propuestas calculadas el ${new Date(row.created_at).toLocaleString("es", { dateStyle: "short", timeStyle: "short" })}. Pulsa «Proponer ruta» para rehacerlas.` + (row.note ? " " + row.note.replace(/^\d+ propuestas[^.]*\.\s*/, "") : "");
  renderPlan(); renderMap(); renderFollow();
  if (lmap && state.tab === "plan") lmap.fitBounds(plan.alts[0].pts, { padding: [30, 30] });
}
function renderOwn() {
  const list = state.stageFilter === "all" ? [] : optTracks(), ul = $("pOwn"); ul.textContent = "";
  $("pOwnBox").hidden = !list.length;
  list.forEach((t) => {
    const tw = trackWps(t), li = document.createElement("li"); li.className = filt.trk === t.id ? "on" : "";
    const h = document.createElement("div"); h.className = "t";
    const sw = document.createElement("span"); sw.className = "sw"; sw.style.background = TRACK;
    h.append(sw, t.name);
    const d = document.createElement("div"); d.className = "d";
    d.textContent = `${kmOf(t.segs).toFixed(1)} km · ${tw.length} WP · ${sumPts(tw)} pts` + (tw.length ? " · " + tw.map((w) => w.name).join(" → ") : "");
    const b = document.createElement("div"); b.className = "btns";
    const gx = document.createElement("button"); gx.type = "button"; gx.className = "ghost"; gx.textContent = "GPX";
    gx.onclick = (e) => { e.stopPropagation(); routeGpx(t.name + " · Etapa " + stageKey(t), t.segs, tw, stageKey(t), t.rallyId); };
    b.append(gx);
    if (canEdit()) {
      const del = document.createElement("button"); del.type = "button"; del.className = "ghost"; del.textContent = "Borrar";
      del.onclick = async (e) => {
        e.stopPropagation();
        if (!del.dataset.armed) { del.dataset.armed = "1"; del.textContent = "¿Seguro?"; del.className = "warn"; return; }
        try { must(await sb.from("tracks").delete().eq("id", t.id)); if (filt.trk === t.id) filt.trk = ""; await loadAll(); } catch (er) { $("pMsg").textContent = writeErr(er); }
      };
      b.append(del);
    }
    // tapping an option shows only it on the map (tap again for all)
    li.onclick = () => { filt.trk = filt.trk === t.id ? "" : t.id; filt.tracks = true; $("fTracks").checked = true; renderTrkPick(); renderOwn(); renderMap(); if (filt.trk && lmap) lmap.fitBounds(t.segs.flat(), { padding: [30, 30] }); };
    li.append(h, d, b); ul.append(li);
  });
}
function renderPlan() {
  if (plan.stage !== state.stageFilter) { plan.alts = []; plan.sel = null; plan.stage = state.stageFilter; $("pMsg").textContent = ""; altNote = ""; altArmed = null; loadPlan(); }
  if (state.tab !== "plan") return;
  renderOwn();
  const wps = mapWps();
  $("pScope").textContent = state.stageFilter === "all"
    ? "Elige una etapa en el paso 2."
    : `${stageLabel(state.stageFilter)}${kindLabel(state.stageFilter) ? " · " + kindLabel(state.stageFilter) : ""} · ${wps.length} waypoints marcados` + (sumPts(wps) ? ` (${sumPts(wps)} pts)` : "") + ". Desmarca en la tabla del Libro de ruta los que no quieras tener en cuenta.";
  $("pRun").disabled = plan.busy || state.stageFilter === "all" || wps.length < 3 || !isCaza(state.stageFilter);
  const ul = $("pAlts"); ul.textContent = "";
  plan.alts.forEach((a, i) => {
    const li = document.createElement("li"); li.className = plan.sel === i ? "on" : "";
    const t = document.createElement("div"); t.className = "t";
    const sw = document.createElement("span"); sw.className = "sw"; sw.style.background = altCol(i);
    t.append(sw, `Propuesta ${i + 1}: ${a.name}`);
    const d = document.createElement("div"); d.className = "d";
    d.textContent = `${a.km.toFixed(1)} km · ${a.wps.length} de ${a.of} WP` + (a.extra > 0 ? ` (${a.extra} más porque la ruta pasa al lado)` : "") + (a.sum ? ` · ${a.sum} pts` : "") + ` · ${a.offKm.toFixed(1)} km fuera de pista` +
      (a.satKm ? ` · ${a.satKm.toFixed(1)} km por pistas vistas en el satélite` : "") +
      (a.gapKm >= 0.3 ? ` (${a.gapKm.toFixed(1)} km sin ningún camino, en línea de puntos)` : "");
    const d2 = document.createElement("div"); d2.className = "d"; d2.textContent = a.wps.map((w) => w.name).join(" → ");
    const b = document.createElement("div"); b.className = "btns";
    const sv = document.createElement("button"); sv.type = "button"; sv.className = "ghost"; sv.textContent = "Guardar como track"; sv.dataset.edit = "";
    sv.onclick = (e) => { e.stopPropagation(); saveTrack(a.name + " · Etapa " + state.stageFilter, [a.pts], $("pMsg"), a.wps); };
    const gx = document.createElement("button"); gx.type = "button"; gx.className = "ghost"; gx.textContent = "GPX";
    gx.onclick = (e) => {
      e.stopPropagation(); const nm = a.name + " · Etapa " + state.stageFilter;
      routeGpx(nm, [a.pts], a.wps, state.stageFilter);
    };
    if (canEdit()) b.append(sv); b.append(gx);
    li.append(t, d, d2, b);
    li.onclick = () => pickAlt(i);
    ul.append(li);
  });
  renderAltBar();
}
// the proposals as coloured buttons above the map: tap one to see it, tap it again to confirm it
let altArmed = null, altNote = "";
function pickAlt(i) {
  plan.sel = i; altArmed = i; altNote = "";
  renderPlan(); renderMap();
  if (lmap && plan.alts[i]) lmap.fitBounds(plan.alts[i].pts, { padding: [30, 30] });
}
function renderAltBar() {
  const box = $("altBtns"); box.textContent = ""; $("altMsg").textContent = "";
  if (state.stageFilter !== "all" && !isCaza(state.stageFilter)) {
    const h = document.createElement("span"); h.className = "hint";
    h.textContent = `Las propuestas de ruta solo se usan en etapas de Caza waypoint. Esta es de ${kindLabel(state.stageFilter)}.`;
    box.append(h); return;
  }
  const cur = rallyTracks().find((t) => stageKey(t) === state.stageFilter && isChosen(t));
  $("altMsg").textContent = altNote || (cur ? `Ruta elegida: «${cur.meta.alt || cur.name}».` : "");
  if (!plan.alts.length) {
    const h = document.createElement("span"); h.className = "hint";
    h.textContent = state.stageFilter === "all" ? "Elige la etapa para ver sus propuestas de ruta." : "Aún no hay propuestas: pulsa «Proponer ruta» más abajo.";
    $("altMsg").textContent = altNote;
    box.append(h); return;
  }
  plan.alts.forEach((a, i) => {
    const b = document.createElement("button"); b.type = "button"; b.className = "altbtn" + (plan.sel === i ? " on" : "");
    b.style.setProperty("--c", altCol(i));
    const sw = document.createElement("span"); sw.className = "sw";
    b.append(sw, `${i + 1}. ${a.name} · ${a.km.toFixed(1)} km`);
    b.title = a.wps.map((w) => w.name).join(" → ");
    b.onclick = () => (plan.sel === i && altArmed === i ? confirmAlt(i) : pickAlt(i));
    box.append(b);
  });
  if (plan.sel !== null && altArmed === plan.sel && canEdit()) {
    const c = document.createElement("button"); c.type = "button"; c.className = "hl"; c.id = "altOk";
    c.textContent = plan.alts[plan.sel].own ? `✓ Confirmar la ${plan.alts[plan.sel].name.toLowerCase()}` : `✓ Confirmar la propuesta ${plan.sel + 1}`;
    c.onclick = () => confirmAlt(plan.sel);
    box.append(c);
  }
  if (canEdit()) {
    if (plan.sel !== null && plan.alts[plan.sel]) {
      const d = document.createElement("button"); d.type = "button"; d.className = "ghost"; d.id = "altDel";
      d.textContent = `🗑 Eliminar la ${plan.alts[plan.sel].own ? plan.alts[plan.sel].name.toLowerCase() : "propuesta " + (plan.sel + 1)}`;
      d.onclick = () => delAlts([plan.sel]);
      box.append(d);
    }
    if (plan.alts.length > 1 || (plan.alts.length && cur)) {
      const all = document.createElement("button"); all.type = "button"; all.className = "ghost"; all.id = "altDelAll";
      all.textContent = "🗑 Eliminar todas"; all.onclick = () => delAlts(plan.alts.map((a, i) => i), true);
      box.append(all);
    }
  }
}
// removes proposals of the stage; «Eliminar todas» also removes the route confirmed from them
async function delAlts(idx, all = false) {
  const chosen = all ? rallyTracks().filter((t) => stageKey(t) === state.stageFilter && isChosen(t)) : [];
  const what = all ? `todas las propuestas de la etapa ${state.stageFilter}, también las que dibujaste${chosen.length ? " y la ruta confirmada" : ""}` : `«${plan.alts[idx[0]].name}»`;
  if (!confirm(`¿Seguro que quieres eliminar ${what}? No se puede deshacer.`)) return;
  plan.alts = plan.alts.filter((a, i) => !idx.includes(i)); plan.sel = null; altArmed = null;
  try {
    if (plan.alts.length) await savePlan($("pMsg").textContent);
    else { must(await sb.from("plans").delete().eq("rally_id", state.rallyId).eq("stage", state.stageFilter)); idb.del("kv", planKey()).catch(() => {}); $("pMsg").textContent = ""; }
    for (const t of chosen) must(await sb.from("tracks").delete().eq("id", t.id));
    if (chosen.length) await loadAll();
    altNote = all ? (chosen.length ? "Propuestas y ruta confirmada eliminadas." : "Propuestas eliminadas.") : "Propuesta eliminada.";
  } catch (e) { altNote = writeErr(e); }
  renderPlan(); renderMap(); renderFollow();
}
async function confirmAlt(i) {
  const a = plan.alts[i]; if (!a || !canEdit()) return;
  if (!confirm(`¿Confirmas ${a.own ? "la " + a.name.toLowerCase() : `la propuesta ${i + 1}`} (${a.name}, ${a.km.toFixed(1)} km) como la ruta de la etapa ${state.stageFilter}?`)) return;
  altArmed = null;
  // one chosen route per stage: confirming another one replaces it
  const old = rallyTracks().filter((t) => stageKey(t) === state.stageFilter && isChosen(t));
  try { for (const t of old) must(await sb.from("tracks").delete().eq("id", t.id)); } catch (e) { altNote = writeErr(e); renderAltBar(); return; }
  const nm = a.own ? a.name : `Propuesta ${i + 1}: ${a.name}`;
  const ok = await saveTrack(nm, [a.pts], $("altMsg"), a.wps, { chosen: true, alt: nm });
  altNote = ok ? "" : $("altMsg").textContent;
  if (ok) altNote = `Confirmada «${nm}» como la ruta de la etapa ${state.stageFilter}. Sale en el mapa del Libro de ruta y es la que sigue «Iniciar ruta».`;
  renderAltBar();
}
$("pRun").onclick = async () => {
  const msg = $("pMsg"), share = Math.min(100, Math.max(10, parseInt($("pPct").value, 10) || 70)) / 100;
  // the route always starts at the stage's start and ends at its finish, even if they are unticked in the table
  const inStage = rallyWps().filter((w) => stageKey(w) === state.stageFilter);
  const st = inStage.filter(isStart).sort(wpOrder)[0], fin = inStage.filter(isFinish).sort(wpOrder).pop();
  const wps = [...new Set([st, ...mapWps().filter((w) => w !== st && w !== fin), fin].filter(Boolean))];
  if (state.stageFilter === "all" || wps.length < 3) return;
  // the alternatives drawn by hand are kept when the proposals are recalculated
  const own = plan.alts.filter((a) => a.own);
  plan.busy = true; plan.alts = []; plan.sel = null; renderPlan(); renderMap();
  try {
    msg.textContent = "Abriendo el mapa off-road…";
    plan.stage = state.stageFilter;
    const mid = [wps.reduce((t, w) => t + w.lat, 0) / wps.length, wps.reduce((t, w) => t + w.lon, 0) / wps.length];
    const or = await offroadMap(mid);
    if (!or) { msg.textContent = (mid[0] > 35.9 ? "Primero importa el mapa off-road de España" : "Primero importa el mapa off-road de Marruecos") + " en el paso 3 de la pestaña «Libro de ruta» (en este dispositivo)."; return; }
    const pad = 0.05, bbox = [Math.min(...wps.map((w) => w.lat)) - pad, Math.min(...wps.map((w) => w.lon)) - pad, Math.max(...wps.map((w) => w.lat)) + pad, Math.max(...wps.map((w) => w.lon)) + pad];
    const key = or.id + "|" + bbox.map((v) => v.toFixed(3)).join(",") + "|" + $("pPaths").checked;
    if (plan.graphKey !== key) {
      plan.graph = await buildGraph(or.p, bbox, { paths: $("pPaths").checked, progress: (f) => { msg.textContent = `Leyendo las pistas del mapa… ${Math.round(f * 100)} %`; } });
      plan.graphKey = key;
    }
    const g = plan.graph;
    if (!g.N) { msg.textContent = "El mapa off-road no tiene pistas en esta zona."; return; }
    const { D, sn } = await matrix(g, wps, (f) => { msg.textContent = `Midiendo distancias por las pistas… ${Math.round(f * 100)} %`; });
    msg.textContent = "Buscando las mejores rutas…"; await new Promise((r) => setTimeout(r, 0));
    const mk = (p, geo, name) => {
      const list = p.seq.map((i) => wps[i]);
      const keep = Math.max(2, Math.min(wps.length, Math.round(wps.length * share)));
      return { name, pts: geo.pts, km: geo.km, offKm: geo.offKm, gaps: geo.gaps, gapKm: geo.gapKm, wps: list, ids: new Set(list.map((w) => w.id)), sum: sumPts(list), of: wps.length, extra: list.length - keep };
    };
    const detour = Math.max(0, parseFloat(String($("pNear").value).replace(",", ".")) || 0) * 1000;
    const props = proposals(D, wps, share, detour), alts = [];
    props.forEach((p, k) => {
      // a waypoint the drawn route passes right by is always taken
      let geo = geometry(g, wps, sn, p.seq);
      for (let t = 0, near; t < 3 && (near = nearRoute(geo.pts, wps, p.seq, detour)).length; t++) { p.seq = addTo(D, p.seq, near, p.key === "roadbook"); geo = geometry(g, wps, sn, p.seq); }
      alts.push(mk(p, geo, p.name));
      // the same waypoints by other tracks, when there is a real alternative
      if (k === 0) {
        const v = geometry(g, wps, sn, p.seq, geo.used);
        let same = 0, n = 0; for (let e = 0; e < v.used.length; e++) if (v.used[e]) { n++; if (geo.used[e]) same++; }
        if (n && same / n < 0.85) alts.push(mk(p, v, p.name + " · por otras pistas"));
      }
    });
    plan.alts = alts.map((a) => ({ ...a, color: TRACK })).concat(own); plan.sel = 0;
    const far = sn.filter((s) => s.d > 1000).length;
    msg.textContent = `${plan.alts.length} propuestas con ${Math.round(share * 100)} % de los waypoints, de ${st ? st.name + (st.desc ? " (" + st.desc + ")" : "") : wps[0].name + " (no encuentro la SALIDA)"} a ${fin ? fin.name + (fin.desc ? " (" + fin.desc + ")" : "") : wps[wps.length - 1].name + " (no encuentro la LLEGADA)"}.` + (far ? ` ${far} waypoint${far > 1 ? "s están" : " está"} a más de 1 km de cualquier pista.` : "");
    renderPlan(); renderMap(); if (lmap) lmap.fitBounds(plan.alts[0].pts, { padding: [30, 30] });
    await satFill(wps, msg);
    await savePlan(msg.textContent);
  } catch (e) { msg.textContent = "No se pudo calcular: " + ((e && e.message) || e); if (!plan.alts.length) plan.alts = own; }
  finally { plan.busy = false; renderPlan(); }
};

// where the map has no way between two waypoints, look at the satellite image for a clear track and follow it
async function satFill(wps, msg) {
  const base = msg.textContent, same = (p, q) => p[0] === q[0] && p[1] === q[1];
  const todo = new Map();
  plan.alts.forEach((a) => a.gaps.forEach((g) => { if (meters(g.A, g.B) >= 300) todo.set(Math.min(g.a, g.b) + "-" + Math.max(g.a, g.b), g); }));
  if (!todo.size) return;
  const found = new Map(), keys = [...todo.keys()]; let done = 0, failed = "";
  const work = async () => {
    for (let k; (k = keys.shift()) !== undefined;) {
      msg.textContent = `${base} Buscando pistas en el satélite donde el mapa no tiene camino… ${done + 1} de ${todo.size}`;
      const g = todo.get(k);
      try {
        const im = await satImage(g.A, g.B);
        const { data, error } = await sb.functions.invoke("trazar-satelite", { body: { image: im.image, width: im.width, height: im.height, a: im.a, b: im.b, mpp: im.mpp } });
        if (error) { let m = ""; try { m = (await error.context.json()).error; } catch (er) {} throw new Error(m || "no responde"); }
        if (data.encontrado && data.claridad !== "baja" && data.puntos.length >= 2) {
          const line = data.puntos.map((p) => im.toLL(p.x, p.y));
          found.set(k, { from: g.a, line: [g.A, ...line, g.B], note: data.nota });
        }
      } catch (er) { failed = er.message || String(er); }
      done++;
    }
  };
  await Promise.all([work(), work()]);
  plan.alts.forEach((a) => {
    a.sat = []; a.satKm = 0;
    a.gaps = a.gaps.filter((g) => {
      const f = found.get(Math.min(g.a, g.b) + "-" + Math.max(g.a, g.b)); if (!f) return true;
      const line = f.from === g.a ? f.line : [...f.line].reverse();
      const i = a.pts.findIndex((p, j) => same(p, g.A) && a.pts[j + 1] && same(a.pts[j + 1], g.B)); if (i < 0) return true;
      a.pts.splice(i, 2, ...line);
      let len = 0; for (let j = 1; j < line.length; j++) len += meters(line[j - 1], line[j]);
      a.km += (len - meters(g.A, g.B)) / 1000; a.satKm += len / 1000; a.sat.push({ line, note: f.note });
      return false;
    });
    a.gapKm = a.gaps.reduce((t, g) => t + meters(g.A, g.B), 0) / 1000;
  });
  msg.textContent = base + (found.size ? ` En ${found.size} de ${todo.size} tramos sin camino en el mapa he seguido una pista que se ve en el satélite (línea blanca discontinua): compruébala.`
    : ` En los ${todo.size} tramos sin camino en el mapa no se ve ninguna pista clara en el satélite.`) + (failed ? ` Algún tramo no se pudo mirar (${failed}).` : "");
  renderPlan(); renderMap();
}

/* ---------- drawing a route by hand on the map ---------- */
let drawing = null;
function renderDraw() {
  const on = !!drawing;
  $("drawStart").hidden = on || !!adding; $("addStart").hidden = on || !!adding; $("drawTools").hidden = !on; $("pDraw").disabled = on || !!adding;
  $("gmap").classList.toggle("drawing", on);
  // quick taps while drawing must add points, not zoom in
  if (lmap) on ? lmap.doubleClickZoom.disable() : lmap.doubleClickZoom.enable();
  $("scaleHelp").textContent = on ? "Toca el mapa para añadir puntos; toca un waypoint para pasar justo por él" : "Toca dos waypoints para ver la distancia";
  const jw = on ? drawnWps() : [];
  $("drawInfo").textContent = on ? `${drawing.pts.length} puntos · ${kmOf([drawing.pts]).toFixed(2)} km · ${jw.length} WP unidos · total ${sumPts(jw)} pts` : "";
  // drawn as an alternative for the planner: «Terminar» adds it next to the proposals
  const alt = on && !!drawing.alt; $("drawAlt").hidden = !alt; $("drawSave").hidden = alt; $("drawAlt").disabled = !on || drawing.pts.length < 2;
  syncFloat();
  $("drawSave").disabled = $("drawGpx").disabled = !on || drawing.pts.length < 2; $("drawUndo").disabled = !on || !drawing.hist.length;
}
// waypoints joined by the drawn line, once each, in the order they were tapped
const drawnWps = () => [...new Set(drawing.wpAt.filter(Boolean))].map((id) => state.wps.find((w) => w.id === id)).filter(Boolean);
$("drawOnly").onchange = () => renderMap();
// every change to the line is kept so "Deshacer" (or Ctrl/Cmd+Z) steps back one at a time
const drawStep = () => drawing.hist.push([drawing.pts.slice(), drawing.wpAt.slice()]);
function syncFloat() {
  const f = $("mapFloat"); if (!f) return;
  f.hidden = !drawing && !adding;
  $("flUndo").disabled = drawing ? !drawing.hist.length : !adding || !adding.made.length;
  $("flEnd").disabled = !!drawing && drawing.pts.length < 2;
  $("flCancel").hidden = !drawing;
}
function drawUndo() { if (!drawing || !drawing.hist.length) return; [drawing.pts, drawing.wpAt] = drawing.hist.pop(); renderDraw(); renderMap(); }
document.addEventListener("keydown", (e) => {
  if (!drawing || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
  if ((e.key === "z" && (e.metaKey || e.ctrlKey) && !e.shiftKey) || e.key === "Backspace") { e.preventDefault(); drawUndo(); }
});
/* ---------- creating waypoints by tapping the map, into the stage being viewed ---------- */
const addStage = () => state.stageFilter !== "all" && state.stageFilter !== "" ? state.stageFilter : currentStage();
function renderAdd() {
  const on = !!adding;
  $("addStart").hidden = on || !!drawing; $("addTools").hidden = !on; $("drawStart").hidden = on || !!drawing;
  $("gmap").classList.toggle("drawing", on || !!drawing);
  if (lmap) (on || drawing) ? lmap.doubleClickZoom.disable() : lmap.doubleClickZoom.enable();
  $("addEdit").disabled = $("addUndo").disabled = !on || !adding.made.length;
  syncFloat();
  if (on) $("scaleHelp").textContent = `Toca el mapa para crear un waypoint en la ${stageLabel(addStage()).toLowerCase()}`;
}
$("addStart").onclick = () => {
  if (!rally()) { $("drawMsg").textContent = "Elige primero el año en el paso 1."; return; }
  if (!addStage()) { $("drawMsg").textContent = "Pon primero el nº de etapa en el paso 2: los waypoints se crean en esa etapa."; $("stageNo").classList.add("need"); $("stageNo").focus(); return; }
  if (state.stageFilter !== addStage()) pickStage(addStage());
  adding = { made: [], next: nextWpNo(addStage()), pend: null }; measure = []; $("drawMsg").textContent = `Toca el mapa donde quieras un waypoint y pon su puntuación. Se guardan en la ${stageLabel(addStage()).toLowerCase()}.`;
  renderAdd(); renderMap();
};
$("addEnd").onclick = () => { if (adding && adding.pend) adding.pend.close(); const n = adding ? adding.made.length : 0; adding = null; $("drawMsg").textContent = n ? (n > 1 ? `Creados ${n} waypoints. Puedes editarlos o borrarlos en la tabla del Libro de ruta.` : "Creado 1 waypoint. Puedes editarlo o borrarlo en la tabla del Libro de ruta.") : ""; $("scaleHelp").textContent = "Toca dos waypoints para ver la distancia"; renderAdd(); };
// the number after the highest one in the stage
const nextWpNo = (st) => rallyWps().filter((w) => stageKey(w) === st).reduce((m, w) => Math.max(m, parseInt(String(w.name).match(/\d+/)?.[0] || "0", 10)), 0) + 1;
// a tap opens a small form on that spot: the waypoint is saved with its number and points, and until then no other tap counts
function addWpAt(ll) {
  if (adding.pend) { adding.pend.focus(); $("drawMsg").textContent = "Pon primero la puntuación del waypoint que tienes abierto (o cancélalo)."; return; }
  const st = addStage(), at = [Math.round(ll.lat * 1e6) / 1e6, Math.round(ll.lng * 1e6) / 1e6];
  const f = document.createElement("form");
  f.innerHTML = '<label for="apNo">Nº</label><input id="apNo" type="number" inputmode="numeric" min="0" step="1" required>' +
    `<label for="apPts">Puntos</label><input id="apPts" type="number" inputmode="numeric" min="1" step="1"${isCaza(st) ? " required" : ' placeholder="opcional"'}>` +
    '<p class="e" id="apErr"></p><div class="b"><button type="submit" class="hl">Guardar</button><button type="button" class="ghost" id="apCancel">Cancelar</button></div>';
  const no = f.querySelector("#apNo"), pts = f.querySelector("#apPts"), err = f.querySelector("#apErr");
  no.value = adding.next;
  L.DomEvent.disableClickPropagation(f);
  const pin = L.circleMarker(at, { radius: 8, color: "#000", weight: 2, fillColor: "#c62828", fillOpacity: 1, interactive: false }).addTo(lmap);
  const pop = L.popup({ className: "addpop", closeButton: false, autoClose: false, closeOnClick: false, closeOnEscapeKey: false, offset: [0, -6] }).setLatLng(at).setContent(f).openOn(lmap);
  const close = () => { lmap.closePopup(pop); pin.remove(); if (adding) adding.pend = null; };
  adding.pend = { focus: () => (pts.value ? no : pts).focus(), close };
  f.querySelector("#apCancel").onclick = () => { close(); $("drawMsg").textContent = "Cancelado. Toca el mapa para crear otro waypoint."; };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const n = parseInt(no.value, 10), p = parseInt(pts.value, 10);
    if (!Number.isFinite(n) || n < 0) { err.textContent = "Pon el número."; no.focus(); return; }
    // in a «Seguimiento» stage the points may be left empty
    if ((!Number.isFinite(p) || p < 1) && !(!isCaza(st) && pts.value === "")) { err.textContent = "Pon la puntuación."; pts.focus(); return; }
    if (rallyWps().some((w) => stageKey(w) === st && String(w.name) === String(n))) { err.textContent = `Ya hay un ${n} en la ${stageLabel(st).toLowerCase()}.`; no.focus(); return; }
    const d = { rallyId: state.rallyId, stage: st, name: String(n), page: "", desc: "", lat: at[0], lon: at[1], pts: Number.isFinite(p) ? p : null };
    f.querySelector("button[type=submit]").disabled = true;
    try {
      const row = must(await sb.from("waypoints").insert(wpOut({ ...d, seq: n, source: "mapa", by: state.user.email })).select().single());
      close();
      state.wps.push(wpIn(row)); if (adding) { adding.made.push(row.id); adding.next = n + 1; }
      $("drawMsg").textContent = `Creado el waypoint ${n}${Number.isFinite(p) ? ` (${p} pts)` : ""} en la ${stageLabel(st).toLowerCase()}. Toca el mapa para el siguiente.`;
      renderAdd(); render();
    } catch (er) { err.textContent = writeErr(er); f.querySelector("button[type=submit]").disabled = false; }
  };
  setTimeout(() => pts.focus(), 50);
  $("drawMsg").textContent = "Pon la puntuación de este waypoint y pulsa Guardar.";
}
$("addUndo").onclick = async () => {
  const id = adding && adding.made.pop(); if (!id) return;
  const gone = state.wps.find((w) => w.id === id);
  try { must(await sb.from("waypoints").delete().eq("id", id)); state.wps = state.wps.filter((w) => w.id !== id); if (gone && adding) adding.next = parseInt(gone.name, 10) || adding.next; $("drawMsg").textContent = "Borrado el último waypoint creado."; renderAdd(); render(); }
  catch (e) { adding.made.push(id); $("drawMsg").textContent = writeErr(e); }
};
$("addEdit").onclick = () => { const w = adding && state.wps.find((x) => x.id === adding.made[adding.made.length - 1]); if (w) startEdit(w); };
// a new stage: its number and type, then straight to tapping its waypoints on the map
$("nsForm").onsubmit = async (e) => {
  e.preventDefault();
  const msg = $("nsMsg"), n = parseInt($("nsNo").value, 10), kind = $("nsKind").value;
  if (!rally()) { msg.textContent = "Elige primero el año."; return; }
  if (!Number.isFinite(n) || n < 0) { msg.textContent = "Pon el nº de etapa."; return; }
  const st = String(n);
  try {
    must(await sb.from("stages").upsert({ rally_id: state.rallyId, stage: st, kind, created_by: state.user.email }));
    state.stages = (state.stages || []).filter((x) => !(x.rallyId === state.rallyId && x.stage === st)).concat({ rallyId: state.rallyId, stage: st, kind });
  } catch (er) { msg.textContent = writeErr(er); return; }
  $("stageNo").value = st; pickStage(st);
  if (kind === "seg_track") { msg.textContent = `Etapa ${st} creada (${kindLabel(st)}). Importa su traza en la pestaña Importar.`; return; }
  msg.textContent = `Etapa ${st} creada (${kindLabel(st)}). Toca el mapa donde va cada waypoint y pon su número${kind === "caza" ? " y su puntuación" : ""}.`;
  if (adding) $("addEnd").click();
  $("addStart").click(); $("gmap").scrollIntoView({ behavior: "smooth", block: "center" });
};
$("pDraw").onclick = () => {
  if (state.stageFilter === "all") { $("pMsg").textContent = "Elige primero la etapa."; return; }
  if (!isCaza(state.stageFilter)) { $("pMsg").textContent = "Las rutas alternativas solo se usan en etapas de Caza waypoint."; return; }
  $("drawStart").click(); drawing.alt = true; renderDraw(); $("gmap").scrollIntoView({ behavior: "smooth", block: "center" }); };
$("drawStart").onclick = () => { drawing = { pts: [], wpAt: [], hist: [] }; $("drawMsg").textContent = ""; measure = []; renderDraw(); renderMap(); };
$("drawAlt").onclick = async () => {
  if (!drawing || drawing.pts.length < 2) return;
  const wps = drawnWps(), n = plan.alts.filter((a) => a.own).length + 1;
  const a = { name: "Ruta alternativa" + (n > 1 ? " " + n : ""), own: true, km: kmOf([drawing.pts]), of: mapWps().length, extra: 0, sum: sumPts(wps),
    offKm: 0, satKm: 0, gapKm: 0, gaps: [], sat: [], pts: drawing.pts.slice(), wps, ids: new Set(wps.map((w) => w.id)) };
  plan.stage = state.stageFilter; plan.alts.push(a);
  drawing = null; renderDraw();
  await savePlan($("pMsg").textContent);
  pickAlt(plan.alts.length - 1);
};
$("drawCancel").onclick = () => { drawing = null; renderDraw(); renderMap(); };
$("drawUndo").onclick = drawUndo;
$("drawAll").onclick = () => { drawStep(); const l = mapWps(); drawing.pts = l.map((w) => [w.lat, w.lon]); drawing.wpAt = l.map((w) => w.id); renderDraw(); renderMap(); };
// in the planner the drawn routes are numbered options of the stage
const optTracks = () => stageTracks().filter((t) => /^Opción \d+/.test(t.name)).sort((a, b) => natural(a.name, b.name));
const nextOpt = () => "Opción " + (Math.max(0, ...optTracks().map((t) => parseInt(t.name.slice(7), 10) || 0)) + 1);
$("drawSave").onclick = async () => {
  const st = currentStage();
  const name = prompt("Nombre de la ruta:", state.tab === "plan" ? nextOpt() : "Ruta dibujada" + (st ? " · Etapa " + st : ""));
  if (name === null) return;
  if (await saveTrack(name.trim() || "Ruta dibujada", [drawing.pts], $("drawMsg"), drawnWps())) { drawing = null; renderDraw(); renderMap(); }
};

// the drawn line straight to a GPX file, with every waypoint of the stage, without saving it
$("drawGpx").onclick = () => {
  const st = currentStage();
  const name = prompt("Nombre del track:", state.tab === "plan" ? nextOpt() : "Ruta dibujada" + (st ? " · Etapa " + st : ""));
  if (name === null) return;
  const t = { name: name.trim() || "Ruta dibujada", segs: [drawing.pts] }, wps = drawnWps();
  const extra = routeGpx(t.name, t.segs, wps);
  $("drawMsg").textContent = `Descargado ${slug(t.name)}.gpx: ${kmOf(t.segs).toFixed(1)} km` + (wps.length ? `, ${wps.length} waypoints en la ruta (${sumPts(wps)} pts)` : "") + (extra.length ? ` y los otros ${extra.length} de la etapa (${sumPts(extra)} pts) para cogerlos si da tiempo.` : ".");
};

/* ---------- manual & GPX ---------- */
function updateParsed() {
  const la = parseCoord($("wLat").value, true), lo = parseCoord($("wLon").value, false), p = $("wParsed");
  if (!$("wLat").value && !$("wLon").value) { p.textContent = ""; p.className = "parsed"; return; }
  if (la === null || lo === null) { p.textContent = (la === null ? "Latitud" : "Longitud") + " no reconocida"; p.className = "parsed bad"; return; }
  p.className = "parsed"; p.textContent = `= ${fmtCoord(la, true, "dms")} ${fmtCoord(lo, false, "dms")} · ${la.toFixed(6)}, ${lo.toFixed(6)}`;
}
$("wLat").addEventListener("input", updateParsed); $("wLon").addEventListener("input", updateParsed);
function startEdit(w) {
  setTab("plan"); $("wpTitle").textContent = "Editar waypoint " + w.name; $("stageNo").value = stageKey(w); state.stageFilter = stageKey(w) || "all"; render();
  $("wEditing").value = w.id; $("wName").value = w.name; $("wPage").value = w.page || ""; $("wDesc").value = w.desc || ""; $("wPts").value = w.pts || "";
  $("wLat").value = fmtCoord(w.lat, true, "dms"); $("wLon").value = fmtCoord(w.lon, false, "dms");
  $("wCancel").hidden = false; $("wSave").textContent = "Guardar cambios"; updateParsed();
  $("wpForm").scrollIntoView({ behavior: "smooth", block: "center" }); $("wName").focus({ preventScroll: true });
}
function clearWp() {
  ["wEditing", "wName", "wPage", "wDesc", "wLat", "wLon", "wPts"].forEach((i) => $(i).value = "");
  $("wCancel").hidden = true; $("wSave").textContent = "Guardar waypoint"; updateParsed(); $("wpTitle").textContent = "Waypoint a mano";
}
$("wCancel").onclick = clearWp;
// «Dar acceso» opens over the page from the bar with Contraseña and Salir
const accShow = (on) => { $("accWrap").hidden = !on; if (on) $("mEmail").focus(); };
$("accBtn").onclick = () => accShow(true);
$("accClose").onclick = () => accShow(false);
$("accWrap").onclick = (e) => { if (e.target === $("accWrap")) accShow(false); };
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("accWrap").hidden) accShow(false); });
$("wpForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const la = parseCoord($("wLat").value, true), lo = parseCoord($("wLon").value, false);
  if (!rally()) { $("wMsg").textContent = "Primero crea o elige el año."; return; }
  if (la === null || lo === null) { $("wMsg").textContent = "Revisa las coordenadas: no las reconozco."; return; }
  const d = { rallyId: state.rallyId, stage: currentStage(), name: $("wName").value.trim(), page: $("wPage").value.trim(), desc: $("wDesc").value.trim(), lat: la, lon: lo,
    pts: $("wPts").value ? parseInt($("wPts").value, 10) : null };
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
// waypoints from GPX (wpt, or rtept when there are none) or KML (Placemark points), into the stage of step 2
function parseWaypoints(text) {
  const xml = new DOMParser().parseFromString(text, "application/xml");
  if (xml.getElementsByTagName("parsererror").length) throw new Error("el archivo no se puede leer");
  const r6 = (v) => Math.round(parseFloat(v) * 1e6) / 1e6;
  const txtOf = (n, t) => { const el = n.getElementsByTagName(t)[0]; return el ? el.textContent.trim() : ""; };
  let nodes = [...xml.getElementsByTagName("wpt")];
  if (!nodes.length) nodes = [...xml.getElementsByTagName("rtept")];
  let out = nodes.map((n) => ({ name: txtOf(n, "name"), lat: r6(n.getAttribute("lat")), lon: r6(n.getAttribute("lon")), desc: txtOf(n, "desc") || txtOf(n, "cmt"),
    extra: [txtOf(n, "cmt"), txtOf(n, "type"), txtOf(n, "sym")].join(" ") }));
  if (!out.length) out = [...xml.getElementsByTagName("Placemark")].map((pm) => {
    const pt = pm.getElementsByTagName("Point")[0]; if (!pt) return null;
    const [lo, la] = txtOf(pt, "coordinates").split(",");
    return { name: txtOf(pm, "name"), lat: r6(la), lon: r6(lo), desc: txtOf(pm, "description").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(), extra: "" };
  }).filter(Boolean);
  out = out.filter((w) => Number.isFinite(w.lat) && Number.isFinite(w.lon) && Math.abs(w.lat) <= 90 && Math.abs(w.lon) <= 180);
  if (!out.length) throw new Error("no trae waypoints (solo track)");
  return out;
}
async function importWaypointFiles(files) {
  const msg = $("impMsg");
  if (!files.length) return;
  const st = currentStage();
  if (!st) { msg.textContent = "Pon primero el nº de etapa en el paso 2."; $("stageNo").classList.add("need"); $("stageNo").focus(); return; }
  try { await ensureRally(); } catch (e) { msg.textContent = writeErr(e); return; }
  const have = new Set(rallyWps().map((w) => stageKey(w) + "|" + w.name + "|" + w.lat + "|" + w.lon));
  const seqBase = Date.now() * 100, rows = [], bad = []; let total = 0;
  for (const f of files) {
    try {
      parseWaypoints(await f.text()).forEach((w, i) => {
        total++;
        // every waypoint keeps a number: names without one get their position in the file
        const name = /\d/.test(w.name) ? w.name : ("WP" + (i + 1) + (w.name ? " " + w.name : "")), k = st + "|" + name + "|" + w.lat + "|" + w.lon;
        if (have.has(k)) return; have.add(k);
        rows.push(wpOut({ rallyId: state.rallyId, stage: st, name, lat: w.lat, lon: w.lon, page: "", desc: w.desc, pts: ptsIn(w.name, w.desc, w.extra), seq: seqBase + rows.length, source: "gpx", by: state.user.email }));
      });
    } catch (e) { bad.push(f.name + ": " + e.message); }
  }
  try {
    if (rows.length) must(await sb.from("waypoints").insert(rows));
    state.stageFilter = st; await loadAll();
    const withPts = rows.filter((x) => x.points).length;
    msg.textContent = (total ? `Añadidos ${rows.length} waypoints a la etapa ${st}` + (total > rows.length ? ` (${total - rows.length} ya estaban).` : ".") +
      (rows.length ? ` ${withPts === rows.length ? "Todos con" : withPts + " de " + rows.length + " con"} puntuación` + (withPts < rows.length ? "; ponla en la columna Pts." : ".") : "") : "") +
      (bad.length ? " No se pudo: " + bad.join("; ") : "");
  } catch (err) { msg.textContent = writeErr(err); }
}
$("gpxFile").addEventListener("change", async (e) => { const f = [...e.target.files]; e.target.value = ""; if (f.length && await askWhere(`Waypoints: ${nFiles(f)}.`)) importWaypointFiles(f); });
const wdrop = $("wptDrop");
wdrop.addEventListener("dragover", (e) => { e.preventDefault(); wdrop.classList.add("over"); });
wdrop.addEventListener("dragleave", () => wdrop.classList.remove("over"));
wdrop.addEventListener("drop", (e) => { e.preventDefault(); wdrop.classList.remove("over"); const f = [...e.dataTransfer.files]; if (f.length) askWhere(`Waypoints: ${nFiles(f)}.`).then((ok) => ok && importWaypointFiles(f)); });

/* ---------- export ---------- */
const xe = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
const descOf = (w) => [w.pts ? w.pts + " pts" : "", w.page ? "Pág " + w.page : "", w.desc].filter(Boolean).join(" · ");
// GPX of a route with every waypoint of its stage: the ones on the route first (in order), then the rest
function routeGpx(name, segs, onRoute, stage, rallyId = state.rallyId) {
  const st = stage === undefined || stage === null ? (state.stageFilter !== "all" ? state.stageFilter : currentStage()) : stage;
  const ids = new Set(onRoute.map((w) => w.id));
  const all = st === "all" || st === undefined ? mapWps() : state.wps.filter((w) => w.rallyId === rallyId && stageKey(w) === String(st));
  const extra = all.filter((w) => !ids.has(w.id));
  download(slug(name) + ".gpx", buildGpx(onRoute, name, [{ name, segs }], true, extra), "application/gpx+xml");
  return extra;
}
function buildGpx(list, title, trks = [], keepOrder = false, extra = []) {
  const pad = $("padNums").checked;
  const nm = (w) => pad ? String(w.name).replace(/\d+/, (d) => d.padStart(3, "0")) : String(w.name);
  const tot = sumPts(list);
  const info = (keepOrder && list.length ? `${list.length} waypoints en la ruta · ${tot} pts` : "") + (extra.length ? `${list.length ? " · " : ""}${extra.length} fuera de la ruta · ${sumPts(extra)} pts` : "");
  let o = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Libro de Rallies" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpx_style="http://www.topografix.com/GPX/gpx_style/0/2" xmlns:gpxx="http://www.garmin.com/xmlschemas/GpxExtensions/v3">\n  <metadata><name>${xe(title)}</name>${info ? `<desc>${xe(info)}</desc>` : ""}</metadata>\n`;
  (keepOrder ? list : list.slice().sort(wpOrder)).forEach((w) => {
    o += `  <wpt lat="${w.lat.toFixed(6)}" lon="${w.lon.toFixed(6)}">\n    <name>${xe(nm(w))}</name>\n    <cmt>${xe(w.name)}</cmt>\n    <desc>${xe(descOf(w))}</desc>\n    <sym>Flag, Red</sym>\n  </wpt>\n`;
  });
  // the stage's other waypoints, for picking up more if there is time
  extra.slice().sort(wpOrder).forEach((w) => {
    o += `  <wpt lat="${w.lat.toFixed(6)}" lon="${w.lon.toFixed(6)}">\n    <name>${xe(nm(w))}</name>\n    <cmt>${xe(w.name)}</cmt>\n    <desc>${xe(["Fuera de la ruta", descOf(w)].filter(Boolean).join(" · "))}</desc>\n    <sym>Flag, Red</sym>\n  </wpt>\n`;
  });
  trks.forEach((t) => {
    // the route in red, in the GPS apps that read a line colour (gpx_style) and in Garmin (DisplayColor)
    o += `  <trk>\n    <name>${xe(t.name)}</name>\n` + (info ? `    <desc>${xe(info)}</desc>\n` : "") +
      `    <extensions><gpx_style:line><gpx_style:color>FF0000</gpx_style:color><gpx_style:width>4</gpx_style:width></gpx_style:line><gpxx:TrackExtension><gpxx:DisplayColor>Red</gpxx:DisplayColor></gpxx:TrackExtension></extensions>\n`;
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
    styles += `  <Style id="${sid}"><IconStyle><color>${abgr(WPC)}</color><Icon><href>http://maps.google.com/mapfiles/kml/paddle/wht-blank.png</href></Icon></IconStyle></Style>\n`;
    folders += `  <Folder><name>${xe(stageLabel(s))}</name>\n`;
    styles += `  <Style id="${sid}t"><LineStyle><color>${abgr(TRACK)}</color><width>4</width></LineStyle></Style>\n`;
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
let recDelArmed = null;
function renderDownloads() {
  const box = $("dlStages"); box.textContent = "";
  const dl = $("fDl"); dl.textContent = "";
  const all = rallyWps();
  allStages().forEach((s) => {
    const b = document.createElement("button"); b.type = "button";
    // the stage on screen downloads what is selected (filters, ticks and the tracks shown); any other stage, all of it
    const shown = state.stageFilter === "all" || state.stageFilter === s;
    const total = all.filter((w) => stageKey(w) === s).length;
    const pick = () => shown
      ? [mapWps().filter((w) => stageKey(w) === s), visibleTracks().filter((t) => stageKey(t) === s)]
      : [all.filter((w) => stageKey(w) === s), rallyTracks().filter((t) => stageKey(t) === s)];
    const [l0] = pick();
    b.className = shown ? "" : "ghost";
    b.textContent = "GPX " + (s === "" ? "sin etapa" : "etapa " + s) + (shown && l0.length !== total ? ` (${l0.length} WP)` : "");
    b.onclick = () => {
      const [list, trks] = pick();
      download(stageFile(s) + ".gpx", buildGpx(list, rally().year + " " + rally().name + " · " + stageLabel(s), trks), "application/gpx+xml");
      $("expMsg").textContent = `Descargado ${stageFile(s)}.gpx con ${list.length === total ? list.length : list.length + " de " + total} waypoints en orden` + (sumPts(list) ? ` (${sumPts(list)} pts)` : "") + (trks.length ? ` y ${trks.length === 1 ? "el track «" + trks[0].name + "»" : trks.length + " tracks"}.` : ".");
    };
    box.append(b);
  });
  // above the table: one GPX with what is on screen (the stage's waypoints and its tracks), and the recording buttons
  const st = state.stageFilter;
  const g = document.createElement("button"); g.type = "button"; g.className = "hl";
  g.textContent = "⬇ GPX " + (st === "all" ? "de lo marcado" : st === "" ? "sin etapa" : "etapa " + st);
  g.disabled = !mapWps().length && !visibleTracks().length;
  g.onclick = () => {
    const list = mapWps(), trks = visibleTracks(), f = st === "all" ? baseName() : stageFile(st);
    download(f + ".gpx", buildGpx(list, rally().year + " " + rally().name + " · " + scopeLabel(), trks), "application/gpx+xml");
    $("expMsg").textContent = `Descargado ${f}.gpx con ${list.length} waypoints en orden` + (sumPts(list) ? ` (${sumPts(list)} pts)` : "") + (trks.length ? ` y ${trks.length === 1 ? "el track «" + trks[0].name + "»" : trks.length + " tracks"}.` : ".");
  };
  dl.append(g);
  if (canEdit() && rally()) {
    const recording = $("recBtn").classList.contains("warn");
    const r = document.createElement("button"); r.type = "button"; r.className = recording ? "warn" : "ghost";
    r.textContent = recording ? "⏹ Parar ruta" : "⏺ Grabar ruta";
    r.onclick = () => {
      if (recording) { $("recBtn").onclick(); return; }
      if (st === "all" || st === "") { $("expMsg").textContent = "Elige primero la etapa: la ruta se graba en ella."; return; }
      const sel = $("recStage"); if (![...sel.options].some((o) => o.value === st)) sel.append(new Option(stageLabel(st), st));
      sel.value = st; $("recBtn").onclick();
    };
    dl.append(r);
    const last = rallyTracks().filter((t) => t.kind === "grabada" && stageKey(t) === st).sort((a, b) => String(b.created).localeCompare(String(a.created)))[0];
    if (recording || last) {
      const x = document.createElement("button"); x.type = "button"; x.className = "ghost";
      x.textContent = "🗑 Eliminar ruta"; x.title = recording ? "Descartar la grabación en curso" : `Borrar «${last.name}»`;
      const key = recording ? "rec" : last.id;
      // asks once before deleting; the question stays a few seconds even if the table is redrawn
      if (recDelArmed === key) { x.className = "warn"; x.textContent = recording ? "¿Descartar la grabación?" : `¿Borrar «${last.name}»?`; }
      x.onclick = async () => {
        if (recDelArmed !== key) { recDelArmed = key; setTimeout(() => { if (recDelArmed === key) { recDelArmed = null; renderDownloads(); } }, 5000); renderDownloads(); return; }
        recDelArmed = null;
        if (recording) { $("recDrop").dataset.armed = "1"; $("recDrop").click(); return; }
        try { must(await sb.from("tracks").delete().eq("id", last.id)); if (filt.rec === last.id) filt.rec = null; $("expMsg").textContent = `«${last.name}» borrada.`; await loadAll(); }
        catch (e) { $("expMsg").textContent = writeErr(e); }
      };
      dl.append(x);
    }
  }
  dl.hidden = !rally();
  const nw = mapWps().length, nt = visibleTracks().length;
  $("openEarth").disabled = !nw && !nt;
  $("earthScope").textContent = rally() ? `${nw} waypoint${nw === 1 ? "" : "s"}` + (nt ? ` y ${nt} track${nt === 1 ? "" : "s"}` : "") + " · " + scopeLabel() : "";
  $("dlSel").disabled = !mapWps().length;
}
$("openEarth").onclick = () => {
  const f = (state.stageFilter === "all" ? baseName() : stageFile(state.stageFilter)) + "_Earth";
  download(f + ".kml", buildKml(mapWps(), visibleTracks()), "application/vnd.google-earth.kml+xml");
  $("gMsg").textContent = `Descargado ${f}.kml. Pínchalo en la barra de descargas y se abre en Google Earth Pro.`;
};
$("dlSel").onclick = () => {
  const list = mapWps(), trks = visibleTracks(), f = (state.stageFilter === "all" ? baseName() : stageFile(state.stageFilter)) + "_seleccion";
  download(f + ".gpx", buildGpx(list, rally().year + " " + rally().name + " · selección", trks), "application/gpx+xml");
  $("expMsg").textContent = `Descargado ${f}.gpx con ${list.length} waypoints en orden` + (trks.length ? ` y ${trks.length} track${trks.length > 1 ? "s" : ""}.` : ".");
};
$("padNums").onchange = (e) => { try { localStorage.setItem("rally.pad", e.target.checked ? "1" : "0"); } catch (er) {} };
$("fmt").onchange = (e) => { state.fmt = e.target.value; try { localStorage.setItem("rally.fmt", state.fmt); } catch (er) {} render(); };

/* ---------- admin: members ---------- */
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
// picking where to record also shows that stage, with its waypoints
$("recStage").onchange = (e) => { if (e.target.value) pickStage(e.target.value); };
try { const m = localStorage.getItem("rally.followM"); if (m) $("followM").value = m; } catch (e) {}
$("followM").addEventListener("change", () => { try { localStorage.setItem("rally.followM", $("followM").value); } catch (e) {} });
// the record / stop buttons above the table follow the GPS's own recording button
new MutationObserver(() => renderDownloads()).observe($("recBtn"), { attributes: true, attributeFilter: ["class"] });
// the Mapas fold stays as it was left
try { $("lyBox").open = localStorage.getItem("rally.lyopen") === "1"; } catch (e) {}
$("lyBox").addEventListener("toggle", () => { try { localStorage.setItem("rally.lyopen", $("lyBox").open ? "1" : "0"); } catch (e) {} });
