import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm";
import { prepare, analyse, legs as legsOf, cut } from "./analisis.js";

const CFG = window.APP_CONFIG;
const sb = createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);

// database rows <-> the shape the page works with
const rallyIn = (r) => ({ id: r.id, year: r.year, name: r.name, created: r.created_at });
const wpIn = (r) => ({ id: r.id, rallyId: r.rally_id, stage: r.stage, name: r.name, lat: r.lat, lon: r.lon, page: r.page, desc: r.descr, pts: r.points ?? null, seq: r.seq, created: r.created_at });
const trackIn = (r) => ({ id: r.id, rallyId: r.rally_id, stage: r.stage, name: r.name, segs: r.points, wps: r.wps || [], created: r.created_at });
const routeIn = (r) => ({ id: r.id, name: r.name, rallyId: r.rally_id, stage: r.stage, source: r.source, segs: r.points, created: r.created_at });
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
const state = { user: null, role: null, rallies: [], wps: [], tracks: [], routes: [], rallyId: null, stageFilter: "all", hi: null, fmt: "dm", photos: [], pending: null, reading: false };
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
const allStages = () => stagesOf([...rallyWps(), ...rallyTracks(), ...(currentStage() ? [{ stage: currentStage() }] : [])]);
const visibleTracks = () => filt.tracks ? rallyTracks().filter((t) => filt.only ? t.id === filt.only : state.stageFilter === "all" || stageKey(t) === state.stageFilter) : [];
// waypoints a track joins, in the order they were joined, and the sum of their points
const trackWps = (t) => (t.wps || []).map((id) => state.wps.find((w) => w.id === id)).filter(Boolean);
const sumPts = (list) => list.reduce((s, w) => s + (w.pts || 0), 0);
const stageColor = (s) => PALETTE[(allStages().indexOf(s) + PALETTE.length) % PALETTE.length];
// roadbook order: DSS first, then by the number in the name (WP2 before WP10), ASS last; ties by reading order
function orderKey(w) {
  const n = String(w.name || "").toUpperCase().trim();
  if (/^(DSS|START|SALIDA|DEPART)/.test(n)) return -1;
  if (/^(ASS|FIN|LLEGADA|ARRIV)/.test(n)) return 1e9;
  const m = n.match(/\d+/); return m ? parseInt(m[0], 10) : 5e8;
}
// score written next to a waypoint: "25 pts", "50pts", "100 puntos", "10 points"
const PTS = [10, 25, 50, 100];
const ptsIn = (...texts) => { const m = texts.join(" ").match(/(\d{1,4})\s*(?:pts?|ptos?|puntos?|points?)\b/i); return m ? parseInt(m[1], 10) : null; };
const seqOf = (w) => typeof w.seq === "number" ? w.seq : Date.parse(w.created || 0) || 0;
const wpOrder = (a, b) => ((stageKey(a) === "") - (stageKey(b) === "")) || natural(stageKey(a), stageKey(b)) || (orderKey(a) - orderKey(b)) || (seqOf(a) - seqOf(b)) || natural(a.name, b.name);
// table filters: stage, text, WP number range; the per-row tick decides what goes to the map
const filt = { text: "", from: null, to: null, tracks: true, only: null, off: new Set(), pts: new Set(["10", "25", "50", "100", "otros", "sin"]) };
const ptsKey = (w) => !w.pts ? "sin" : PTS.includes(w.pts) ? String(w.pts) : "otros";
const textOf = (w) => [w.name, w.page && "pág " + w.page, w.desc].filter(Boolean).join(" ").toLowerCase();
const visibleWps = () => rallyWps().filter((w) => {
  if (filt.only) { const t = state.tracks.find((x) => x.id === filt.only); return !!t && t.wps.includes(w.id); }
  if (state.stageFilter !== "all" && stageKey(w) !== state.stageFilter) return false;
  const n = orderKey(w);
  if (filt.from !== null && n < filt.from) return false;
  if (filt.to !== null && n > filt.to) return false;
  if (!filt.pts.has(ptsKey(w))) return false;
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
    const [r, w, t, ro] = await Promise.all([sb.from("rallies").select("*"), sb.from("waypoints").select("*").range(0, 9999), sb.from("tracks").select("*"),
      sb.from("routes").select("*")]);
    state.rallies = must(r).map(rallyIn); state.wps = must(w).map(wpIn); state.tracks = must(t).map(trackIn);
    // the routes table arrives with a later update; until it exists the page works without it
    state.routes = ro.error ? [] : ro.data.map(routeIn);
    showNotice(""); render();
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
    .on("postgres_changes", { event: "*", schema: "public", table: "routes" }, reloadSoon)
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
  $("rallyName").textContent = r ? r.name : "";
  $("rallyDelBox").hidden = !r;

  const stList = allStages();
  if (state.stageFilter !== "all" && !stList.includes(state.stageFilter)) state.stageFilter = "all";
  $("allStages").setAttribute("aria-pressed", String(state.stageFilter === "all"));
  $("allStages").textContent = "Todas · " + rallyWps().length + " WP";
  $("stageHint").textContent = state.stageFilter === "all"
    ? "Viendo todas las etapas. Escribe un número para ver solo esa etapa" + (canEdit() ? " y guardar en ella los waypoints nuevos." : ".")
    : `Viendo la etapa ${state.stageFilter}: ${rallyWps().filter((w) => stageKey(w) === state.stageFilter).length} WP.` + (canEdit() ? " Los waypoints nuevos se guardan aquí." : "");

  $("readBtn").disabled = !r || !state.photos.length || state.reading;
  $("wSave").disabled = !r;
  $("mapTitle").textContent = r ? scopeLabel() : "Mapa";
  renderTable(); renderTracks(); renderRoutes(); renderMap(); renderReview(); renderDownloads();
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
      td.textContent = stageLabel(k) + " · " + list.filter((x) => stageKey(x) === k).length + " WP"; h.append(td); tb.append(h);
    }
    const tr = document.createElement("tr"); tr.id = "row-" + w.id; tr.className = (state.hi === w.id ? "hi" : "") + (filt.off.has(w.id) ? " off" : "");
    const tdc = document.createElement("td"); const cb = document.createElement("input"); cb.type = "checkbox"; cb.style.width = "auto";
    cb.checked = !filt.off.has(w.id); cb.setAttribute("aria-label", "Ver " + w.name + " en el mapa");
    cb.onchange = () => { if (cb.checked) filt.off.delete(w.id); else filt.off.add(w.id); tr.classList.toggle("off", !cb.checked); renderRoutes(); renderMap(); renderDownloads(); renderScope(); };
    tdc.append(cb); tr.append(tdc);
    [[w.name, "nm"], [fmtCoord(w.lat, true, state.fmt), "c"], [fmtCoord(w.lon, false, state.fmt), "c"], [w.page || "", "c"]]
      .forEach(([t, cls]) => { const td = document.createElement("td"); td.textContent = t; if (cls) td.className = cls; tr.append(td); });
    const tdp = document.createElement("td"); tdp.className = "c pts";
    if (canEdit()) {
      const sel = document.createElement("select"); sel.setAttribute("aria-label", "Puntos de " + w.name);
      const vals = ["", ...PTS.map(String)]; if (w.pts && !PTS.includes(w.pts)) vals.push(String(w.pts));
      vals.forEach((v) => { const o = document.createElement("option"); o.value = v; o.textContent = v ? v + " pts" : "—"; sel.append(o); });
      sel.value = w.pts ? String(w.pts) : "";
      sel.onchange = async () => {
        try { must(await sb.from("waypoints").update({ points: sel.value ? parseInt(sel.value, 10) : null }).eq("id", w.id)); w.pts = sel.value ? parseInt(sel.value, 10) : null; refilter(); }
        catch (er) { $("expMsg").textContent = writeErr(er); }
      };
      tdp.append(sel);
    } else tdp.textContent = w.pts ? w.pts + " pts" : "";
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
  $("exportScope").textContent = n + " waypoints · " + scopeLabel() + (m !== n ? ` · ${m} en el mapa` : "");
  const sel = $("fStage"), opts = [["all", "Todas"], ...allStages().map((k) => [k, stageLabel(k)])];
  if (sel.options.length !== opts.length || [...sel.options].some((o, i) => o.value !== opts[i][0])) {
    sel.textContent = ""; opts.forEach(([v, t]) => { const o = document.createElement("option"); o.value = v; o.textContent = t; sel.append(o); });
  }
  sel.value = state.stageFilter;
  $("fClear").hidden = !filt.text && filt.from === null && filt.to === null && !filt.off.size && filt.pts.size === 6 && !filt.only;
  // only offer "other" and "none" when there are such waypoints
  $("fPtsOtros").hidden = !rallyWps().some((w) => ptsKey(w) === "otros");
}
const numOrNull = (v) => v === "" ? null : parseInt(v, 10);
const refilter = () => { renderTable(); renderRoutes(); renderMap(); renderDownloads(); };
$("fStage").onchange = (e) => pickStage(e.target.value);
$("allStages").onclick = () => pickStage("all");
// step 2's stage number, its chips and the table's stage filter always show the same stage
function pickStage(k) {
  state.stageFilter = k; state.hi = null;
  $("stageNo").value = k === "all" ? "" : k;
  render();
}
$("fText").addEventListener("input", (e) => { filt.text = e.target.value.trim().toLowerCase(); refilter(); });
$("fFrom").addEventListener("input", (e) => { filt.from = numOrNull(e.target.value); refilter(); });
$("fTo").addEventListener("input", (e) => { filt.to = numOrNull(e.target.value); refilter(); });
$("fTracks").onchange = (e) => { filt.tracks = e.target.checked; renderMap(); renderDownloads(); };
document.querySelectorAll("#fPts input").forEach((cb) => cb.onchange = () => { if (cb.checked) filt.pts.add(cb.value); else filt.pts.delete(cb.value); refilter(); });
$("fAll").onclick = () => { visibleWps().forEach((w) => filt.off.delete(w.id)); refilter(); };
$("fNone").onclick = () => { visibleWps().forEach((w) => filt.off.add(w.id)); refilter(); };
$("fClear").onclick = () => {
  Object.assign(filt, { text: "", from: null, to: null, only: null }); filt.off.clear();
  document.querySelectorAll("#fPts input").forEach((cb) => { cb.checked = true; filt.pts.add(cb.value); });
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
  lmap.on("click", (e) => {
    if (drawing) { drawing.pts.push([Math.round(e.latlng.lat * 1e6) / 1e6, Math.round(e.latlng.lng * 1e6) / 1e6]); drawing.wpAt.push(null); renderMap(); renderDraw(); return; }
    if (measure.length) { measure = []; renderMap(); }
  });
  renderMap();
}
function renderMap() {
  if (!lmap) return;
  layer.clearLayers();
  const joined = drawing ? new Set(drawing.wpAt.filter(Boolean)) : null;
  const list = mapWps().filter((w) => !joined || !$("drawOnly").checked || joined.has(w.id)), trks = visibleTracks();
  $("scaleTxt").textContent = list.length || trks.length ? "Colores por etapa · línea continua = track · vista satélite" : "Sin waypoints en esta selección";
  if (!list.length && !trks.length) return;
  const pts = list.map((w) => [w.lat, w.lon]);
  trks.forEach((t) => t.segs.forEach((seg) => {
    L.polyline(seg, { color: "#000", weight: 6, opacity: .35, interactive: false }).addTo(layer);
    L.polyline(seg, { color: stageColor(stageKey(t)), weight: 3.5, opacity: .95 }).bindTooltip(t.name).addTo(layer);
    seg.forEach((p) => pts.push(p));
  }));
  state.routes.filter((r) => rt.show.has(r.id)).forEach((r) => r.segs.forEach((seg) => {
    L.polyline(seg, { color: "#7a3b8f", weight: 3, opacity: .85 }).bindTooltip(r.name).addTo(layer);
  }));
  if (rt.leg) {
    L.polyline(rt.leg, { color: "#000", weight: 9, opacity: .35, interactive: false }).addTo(layer);
    L.polyline(rt.leg, { color: "#f2b53a", weight: 5, opacity: 1, interactive: false }).addTo(layer);
  }
  if (drawing) {
    L.polyline(drawing.pts, { color: "#000", weight: 7, opacity: .35, interactive: false }).addTo(layer);
    L.polyline(drawing.pts, { color: "#ff7a00", weight: 4, opacity: 1, interactive: false }).addTo(layer);
    drawing.pts.forEach((p) => L.circleMarker(p, { radius: 4, color: "#ff7a00", weight: 2, fillColor: "#fff", fillOpacity: 1, interactive: false }).addTo(layer));
  }
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
    const hi = state.hi === w.id || measure.includes(w.id) || (joined && joined.has(w.id));
    const m = L.circleMarker([w.lat, w.lon], { radius: hi ? 10 : 7, color: hi ? "#000" : "#fff", weight: 2, fillColor: stageColor(stageKey(w)), fillOpacity: 1 })
      .bindTooltip(w.pts ? `${w.name} · ${w.pts}` : w.name, { permanent: true, direction: "top", offset: [0, -8], className: "wp-lbl" })
      .on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        if (drawing) { drawing.pts.push([w.lat, w.lon]); drawing.wpAt.push(w.id); renderMap(); renderDraw(); return; }
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
$("stageNo").addEventListener("input", () => {
  $("stageNo").classList.remove("need");
  state.stageFilter = currentStage() || "all"; state.hi = null; render();
});
$("stageNo").addEventListener("change", () => {
  const s = currentStage();
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
      pts: parseInt(o.puntos, 10) || ptsIn(o.note || ""),
    }));
    // good readings are saved straight away; only the ones that can't be used wait in the review table
    const isOk = (x) => x.name && parseCoord(x.latRaw, true) !== null && parseCoord(x.lonRaw, false) !== null;
    const good = rows.filter(isOk), bad = rows.filter((x) => !isOk(x));
    try {
      const res = await saveRows(good);
      state.pending = bad.length ? bad : null;
      $("photos").value = ""; setPhotos([]);
      const doubts = good.filter((x) => x.doubt).length;
      const withPts = good.filter((x) => x.pts).length;
      msg.textContent = `Guardados ${res.added} waypoints en la etapa ${currentStage()}` + (res.skipped ? ` (${res.skipped} ya estaban)` : "") + "." +
        (good.length ? ` ${withPts === good.length ? "Todos con" : withPts + " de " + good.length + " con"} puntuación.` : "") +
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
    const tw = trackWps(t);
    const nm = document.createElement("span"); nm.className = "em";
    nm.textContent = `${stageLabel(stageKey(t))} · ${t.name} · ${kmOf(t.segs).toFixed(1)} km` + (tw.length ? ` · ${tw.length} WP · ${sumPts(tw)} pts` : "");
    const gx = document.createElement("button"); gx.type = "button"; gx.className = "ghost"; gx.textContent = "GPX";
    gx.title = tw.length ? "GPX limpio: este track y solo los waypoints que une" : "Descargar solo este track";
    gx.onclick = () => download(slug(t.name) + ".gpx", buildGpx(tw, t.name, [t], true), "application/gpx+xml");
    li.append(sw, nm, gx);
    if (tw.length) {
      const only = document.createElement("button"); only.type = "button"; only.className = filt.only === t.id ? "hl" : "ghost";
      only.textContent = filt.only === t.id ? "Ver todos" : "Solo sus WP";
      only.title = "Apaga en el mapa y en la tabla los waypoints que no une este track";
      only.onclick = () => { filt.only = filt.only === t.id ? null : t.id; refilter(); renderTracks(); };
      li.append(only);
    }
    if (canEdit()) {
      const del = document.createElement("button"); del.type = "button"; del.className = "ghost"; del.textContent = "Borrar";
      del.onclick = async () => {
        if (!del.dataset.armed) { del.dataset.armed = "1"; del.textContent = "¿Seguro?"; del.className = "warn"; return; }
        try { must(await sb.from("tracks").delete().eq("id", t.id)); if (filt.only === t.id) filt.only = null; await loadAll(); } catch (e) { $("trkMsg").textContent = writeErr(e); }
      };
      li.append(del);
    }
    ul.append(li);
  });
}

async function saveTrack(name, segs, msgEl, wps = []) {
  const st = currentStage();
  if (!st) { msgEl.textContent = "Pon primero el nº de etapa en el paso 2."; $("stageNo").classList.add("need"); $("stageNo").focus(); return false; }
  try {
    await ensureRally();
    const row = { rally_id: state.rallyId, stage: st, name, points: segs, created_by: state.user.email };
    if (wps.length) row.wps = wps.map((w) => w.id);
    must(await sb.from("tracks").insert(row));
    await loadAll();
    msgEl.textContent = `Guardado «${name}» (${kmOf(segs).toFixed(1)} km` + (wps.length ? `, ${wps.length} WP, ${sumPts(wps)} pts` : "") + `) como track de la etapa ${st}. Sale en el mapa y en el GPX de la etapa.`;
    return true;
  } catch (e) { msgEl.textContent = writeErr(e); return false; }
}

/* ---------- reference routes (Wikiloc): which ones join the waypoints ---------- */
const MAX_ROUTE_POINTS = 5000;
const rt = { radius: 300, show: new Set(), leg: null, legIdx: null, cacheKey: "", results: [], legs: [] };
const prepared = new Map();
const prep = (r) => { let p = prepared.get(r.id); if (!p || p.route !== r) { p = prepare(r); prepared.set(r.id, p); } return p; };
$("rtRadius").addEventListener("input", (e) => { const v = parseInt(e.target.value, 10); if (v > 0) { rt.radius = v; renderRoutes(); renderMap(); } });
$("routeFile").addEventListener("change", async (e) => {
  const files = [...e.target.files]; e.target.value = ""; if (!files.length) return;
  const msg = $("rtMsg");
  const ans = prompt(`¿Para qué etapa ${files.length > 1 ? "son estas " + files.length + " rutas" : "es esta ruta"}? Escribe el número:`, currentStage());
  if (ans === null) return;
  const st = ans.trim() === "" ? "" : String(parseInt(ans, 10) || ans.trim());
  if (st) { try { await ensureRally(); } catch (er) { msg.textContent = writeErr(er); return; } }
  msg.textContent = "Subiendo…";
  const rows = [], bad = [];
  for (const f of files) {
    try {
      let { name, segs } = parseTrack(await f.text(), f.name);
      const total = segs.reduce((n, sg) => n + sg.length, 0);
      if (total > MAX_ROUTE_POINTS) { const k = Math.ceil(total / MAX_ROUTE_POINTS); segs = segs.map((sg) => sg.filter((p, i) => i % k === 0 || i === sg.length - 1)); }
      rows.push({ name, rally_id: st ? state.rallyId : null, stage: st, source: /wikiloc/i.test(f.name) ? "wikiloc" : "archivo", points: segs, created_by: state.user.email });
    } catch (er) { bad.push(f.name + ": " + er.message); }
  }
  try {
    if (rows.length) must(await sb.from("routes").insert(rows));
    await loadAll();
    if (st && rows.length) pickStage(st);
    msg.textContent = (rows.length ? `Importada${rows.length > 1 ? "s " + rows.length + " rutas" : " la ruta"}${st ? " para la etapa " + st : ""}.` : "") + (bad.length ? " No se pudo: " + bad.join("; ") : "");
  } catch (er) { msg.textContent = writeErr(er); }
});
function renderRoutes() {
  const ul = $("rtList"), wps = mapWps(), msg = $("rtMsg");
  ul.textContent = "";
  $("rtLegsBox").hidden = true;
  if (!state.routes.length) { if (!msg.textContent) msg.textContent = "Aún no hay rutas subidas."; return; }
  if (msg.textContent === "Aún no hay rutas subidas.") msg.textContent = "";
  const staged = state.stageFilter !== "all";
  const key = state.routes.map((r) => r.id).join(",") + "|" + wps.map((w) => w.id).join(",") + "|" + rt.radius;
  if (staged && key !== rt.cacheKey) {
    rt.cacheKey = key;
    rt.results = analyse(state.routes.map(prep), wps, rt.radius);
    rt.legs = legsOf(rt.results, wps);
    rt.leg = null; rt.legIdx = null;
  }
  const rows = staged ? rt.results : state.routes.map((r) => ({ pr: prep(r), covered: null }));
  rows.forEach((res) => {
    const r = res.pr.route, li = document.createElement("li");
    if (staged && !res.covered) li.className = "none";
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = rt.show.has(r.id); cb.title = "Ver en el mapa";
    cb.onchange = () => { if (cb.checked) rt.show.add(r.id); else rt.show.delete(r.id); renderMap(); };
    const em = document.createElement("span"); em.className = "em";
    const b = document.createElement("b"); b.textContent = r.name; em.append(b);
    if (r.stage) { const rr = state.rallies.find((x) => x.id === r.rallyId); em.append(` · Etapa ${r.stage}` + (rr && rr.id !== state.rallyId ? ` (${rr.year})` : "")); }
    let t = ` · ${(res.pr.length / 1000).toFixed(1)} km`;
    if (staged) t += res.covered
      ? ` · pasa por ${res.covered} de ${wps.length} WP, ${res.inOrder} en orden${res.reverse ? " (en sentido contrario)" : ""}, a ${Math.round(res.mean)} m de media`
      : " · no pasa cerca de estos waypoints";
    em.append(t);
    li.append(cb, em);
    if (canEdit() && staged && res.covered >= 2) {
      const use = document.createElement("button"); use.type = "button"; use.className = "ghost"; use.textContent = "Usar como track";
      use.title = "Guarda el trozo de esta ruta entre el primer y el último waypoint por el que pasa";
      use.onclick = () => {
        const al = res.hits.filter(Boolean).map((h) => h.along);
        const from = res.reverse ? Math.max(...al) : Math.min(...al), to = res.reverse ? Math.min(...al) : Math.max(...al);
        saveTrack(r.name + " (recortada)", [cut(res.pr, from, to)], $("rtMsg"));
      };
      li.append(use);
    }
    if (canEdit()) {
      const del = document.createElement("button"); del.type = "button"; del.className = "ghost"; del.textContent = "Borrar";
      del.onclick = async () => {
        if (!del.dataset.armed) { del.dataset.armed = "1"; del.textContent = "¿Seguro?"; del.className = "warn"; return; }
        try { must(await sb.from("routes").delete().eq("id", r.id)); rt.show.delete(r.id); await loadAll(); } catch (er) { $("rtMsg").textContent = writeErr(er); }
      };
      li.append(del);
    }
    ul.append(li);
  });
  if (!staged) { const li = document.createElement("li"); li.className = "hint"; li.textContent = "Elige una etapa para ver qué rutas unen sus waypoints."; ul.prepend(li); return; }
  if (wps.length < 2) return;
  $("rtLegsBox").hidden = false;
  const tb = $("rtLegs"); tb.textContent = "";
  rt.legs.forEach((lg, i) => {
    const tr = document.createElement("tr"); if (rt.legIdx === i) tr.className = "hi";
    const o = lg.opts[0];
    const cells = [[`${lg.a.name} → ${lg.b.name}`, "nm"], [fmtKm(distKm(lg.a, lg.b)) + " recto", ""],
      [o ? `${o.r.pr.route.name}: ${fmtKm(o.km)} por la ruta` + (lg.opts.length > 1 ? ` (y ${lg.opts.length - 1} más)` : "") : "Ninguna ruta pasa por los dos", o ? "" : "no"]];
    cells.forEach(([txt, cls]) => { const td = document.createElement("td"); td.textContent = txt; if (cls) td.className = cls; tr.append(td); });
    tr.onclick = () => {
      rt.legIdx = i;
      rt.leg = o ? cut(o.r.pr, o.from, o.to) : [[lg.a.lat, lg.a.lon], [lg.b.lat, lg.b.lon]];
      renderRoutes(); renderMap(); if (lmap) lmap.fitBounds(rt.leg.concat([[lg.a.lat, lg.a.lon], [lg.b.lat, lg.b.lon]]), { padding: [50, 50] });
    };
    tb.append(tr);
  });
}
// one trace through every waypoint: along the best route of each leg, straight where there is none
$("rtBuild").onclick = () => {
  const pts = [];
  const add = (p) => { const q = pts[pts.length - 1]; if (!q || q[0] !== p[0] || q[1] !== p[1]) pts.push(p); };
  rt.legs.forEach((lg) => {
    add([lg.a.lat, lg.a.lon]);
    const o = lg.opts[0];
    if (o) cut(o.r.pr, o.from, o.to).forEach(add);
    add([lg.b.lat, lg.b.lon]);
  });
  if (pts.length < 2) return;
  const withRoute = rt.legs.filter((lg) => lg.opts.length).length;
  saveTrack(`Traza con rutas (${withRoute}/${rt.legs.length} tramos) · Etapa ${currentStage() || state.stageFilter}`, [pts], $("rtMsg"));
};

/* ---------- drawing a route by hand on the map ---------- */
let drawing = null;
function renderDraw() {
  const on = !!drawing;
  $("drawStart").hidden = on; $("drawTools").hidden = !on;
  $("gmap").classList.toggle("drawing", on);
  $("scaleHelp").textContent = on ? "Toca el mapa para añadir puntos; toca un waypoint para pasar justo por él" : "Toca dos waypoints para ver la distancia";
  const jw = on ? drawnWps() : [];
  $("drawInfo").textContent = on ? `${drawing.pts.length} puntos · ${kmOf([drawing.pts]).toFixed(2)} km · ${jw.length} WP unidos · total ${sumPts(jw)} pts` : "";
  $("drawSave").disabled = $("drawGpx").disabled = !on || drawing.pts.length < 2; $("drawUndo").disabled = !on || !drawing.pts.length;
}
// waypoints joined by the drawn line, once each, in the order they were tapped
const drawnWps = () => [...new Set(drawing.wpAt.filter(Boolean))].map((id) => state.wps.find((w) => w.id === id)).filter(Boolean);
$("drawOnly").onchange = () => renderMap();
$("drawStart").onclick = () => { drawing = { pts: [], wpAt: [] }; $("drawMsg").textContent = ""; measure = []; renderDraw(); renderMap(); };
$("drawCancel").onclick = () => { drawing = null; renderDraw(); renderMap(); };
$("drawUndo").onclick = () => { drawing.pts.pop(); drawing.wpAt.pop(); renderDraw(); renderMap(); };
$("drawAll").onclick = () => { const l = mapWps(); drawing.pts = l.map((w) => [w.lat, w.lon]); drawing.wpAt = l.map((w) => w.id); renderDraw(); renderMap(); };
$("drawSave").onclick = async () => {
  const st = currentStage();
  const name = prompt("Nombre de la ruta:", "Ruta dibujada" + (st ? " · Etapa " + st : ""));
  if (name === null) return;
  if (await saveTrack(name.trim() || "Ruta dibujada", [drawing.pts], $("drawMsg"), drawnWps())) { drawing = null; renderDraw(); renderMap(); }
};

// the drawn line straight to a clean GPX file (only the waypoints it joins), without saving it
$("drawGpx").onclick = () => {
  const st = currentStage();
  const name = prompt("Nombre del track:", "Ruta dibujada" + (st ? " · Etapa " + st : ""));
  if (name === null) return;
  const t = { name: name.trim() || "Ruta dibujada", segs: [drawing.pts] }, wps = drawnWps();
  download(slug(t.name) + ".gpx", buildGpx(wps, t.name, [t], true), "application/gpx+xml");
  $("drawMsg").textContent = `Descargado ${slug(t.name)}.gpx: ${kmOf(t.segs).toFixed(1)} km` + (wps.length ? `, ${wps.length} waypoints, ${sumPts(wps)} pts.` : ".");
};

/* ---------- manual & GPX ---------- */
function updateParsed() {
  const la = parseCoord($("wLat").value, true), lo = parseCoord($("wLon").value, false), p = $("wParsed");
  if (!$("wLat").value && !$("wLon").value) { p.textContent = ""; p.className = "parsed"; return; }
  if (la === null || lo === null) { p.textContent = (la === null ? "Latitud" : "Longitud") + " no reconocida"; p.className = "parsed bad"; return; }
  p.className = "parsed"; p.textContent = "= " + la.toFixed(6) + ", " + lo.toFixed(6);
}
$("wLat").addEventListener("input", updateParsed); $("wLon").addEventListener("input", updateParsed);
function startEdit(w) {
  $("moreWays").open = true; $("stageNo").value = stageKey(w); state.stageFilter = stageKey(w) || "all"; render();
  $("wEditing").value = w.id; $("wName").value = w.name; $("wPage").value = w.page || ""; $("wDesc").value = w.desc || ""; $("wPts").value = w.pts && PTS.includes(w.pts) ? String(w.pts) : "";
  $("wLat").value = fmtCoord(w.lat, true, "dm"); $("wLon").value = fmtCoord(w.lon, false, "dm");
  $("wCancel").hidden = false; $("wSave").textContent = "Guardar cambios"; updateParsed();
  $("wpForm").scrollIntoView({ behavior: "smooth", block: "center" }); $("wName").focus({ preventScroll: true });
}
function clearWp() {
  ["wEditing", "wName", "wPage", "wDesc", "wLat", "wLon", "wPts"].forEach((i) => $(i).value = "");
  $("wCancel").hidden = true; $("wSave").textContent = "Guardar waypoint"; updateParsed();
}
$("wCancel").onclick = clearWp;
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
$("gpxFile").addEventListener("change", (e) => { const f = [...e.target.files]; e.target.value = ""; importWaypointFiles(f); });
const wdrop = $("wptDrop");
wdrop.addEventListener("dragover", (e) => { e.preventDefault(); wdrop.classList.add("over"); });
wdrop.addEventListener("dragleave", () => wdrop.classList.remove("over"));
wdrop.addEventListener("drop", (e) => { e.preventDefault(); wdrop.classList.remove("over"); importWaypointFiles([...e.dataTransfer.files]); });

/* ---------- export ---------- */
const xe = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
const descOf = (w) => [w.pts ? w.pts + " pts" : "", w.page ? "Pág " + w.page : "", w.desc].filter(Boolean).join(" · ");
function buildGpx(list, title, trks = [], keepOrder = false) {
  const pad = $("padNums").checked;
  const nm = (w) => pad ? String(w.name).replace(/\d+/, (d) => d.padStart(3, "0")) : String(w.name);
  const tot = sumPts(list), info = keepOrder && list.length ? `${list.length} waypoints · ${tot} pts` : "";
  let o = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Libro de Rallies" xmlns="http://www.topografix.com/GPX/1/1">\n  <metadata><name>${xe(title)}</name>${info ? `<desc>${xe(info)}</desc>` : ""}</metadata>\n`;
  (keepOrder ? list : list.slice().sort(wpOrder)).forEach((w) => {
    o += `  <wpt lat="${w.lat.toFixed(6)}" lon="${w.lon.toFixed(6)}">\n    <name>${xe(nm(w))}</name>\n    <cmt>${xe(w.name)}</cmt>\n    <desc>${xe(descOf(w))}</desc>\n    <sym>Flag</sym>\n  </wpt>\n`;
  });
  trks.forEach((t) => {
    o += `  <trk>\n    <name>${xe(t.name)}</name>\n` + (info ? `    <desc>${xe(info)}</desc>\n` : "");
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
