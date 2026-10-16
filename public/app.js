import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut, connectAuthEmulator } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { getFirestore, collection, doc, onSnapshot, addDoc, updateDoc, deleteDoc, setDoc, getDoc, writeBatch, connectFirestoreEmulator } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { getFunctions, httpsCallable, connectFunctionsEmulator } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js";

const CFG = window.APP_CONFIG;
const fb = initializeApp(CFG.firebase);
const auth = getAuth(fb);
const db = getFirestore(fb);
const fns = getFunctions(fb, CFG.functionsRegion || "europe-west1");
if (CFG.emulators && location.hostname === "localhost") { // local testing only (firebase emulators:start)
  connectAuthEmulator(auth, "http://localhost:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "localhost", 8080);
  connectFunctionsEmulator(fns, "localhost", 5001);
}
const leerRoadbook = httpsCallable(fns, "leerRoadbook", { timeout: 300000 });

const $ = (id) => document.getElementById(id);
const PALETTE = ["#c1272d", "#2f4fb5", "#006233", "#e3a21a", "#b5532c", "#1b8a8a", "#7a3b8f", "#d9662b", "#4f7f2a", "#8c1d40"];
const state = { user: null, role: null, rallies: [], wps: [], rallyId: null, stageFilter: "all", hi: null, fmt: "dm", photos: [], pending: null, reading: false };
const unsubs = [];
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
const stageColor = (s) => PALETTE[(stagesOf(rallyWps()).indexOf(s) + PALETTE.length) % PALETTE.length];
// roadbook order: DSS first, then by the number in the name (WP2 before WP10), ASS last; ties by reading order
function orderKey(w) {
  const n = String(w.name || "").toUpperCase().trim();
  if (/^(DSS|START|SALIDA|DEPART)/.test(n)) return -1;
  if (/^(ASS|FIN|LLEGADA|ARRIV)/.test(n)) return 1e9;
  const m = n.match(/\d+/); return m ? parseInt(m[0], 10) : 5e8;
}
const seqOf = (w) => typeof w.seq === "number" ? w.seq : Date.parse(w.created || 0) || 0;
const wpOrder = (a, b) => ((stageKey(a) === "") - (stageKey(b) === "")) || natural(stageKey(a), stageKey(b)) || (orderKey(a) - orderKey(b)) || (seqOf(a) - seqOf(b)) || natural(a.name, b.name);
const visibleWps = () => rallyWps().filter((w) => state.stageFilter === "all" || stageKey(w) === state.stageFilter).sort(wpOrder);
const scopeLabel = () => { const r = rally(); return r ? r.year + " · " + (state.stageFilter === "all" ? "todas las etapas" : stageLabel(state.stageFilter)) : ""; };
const currentStage = () => { const v = $("stageNo").value.trim(); return v === "" ? "" : String(parseInt(v, 10)); };

function showNotice(t) { $("notice").textContent = t || ""; $("notice").hidden = !t; }
function writeErr(e) {
  return e && e.code === "permission-denied" ? "No tienes permiso para guardar." : "No se pudo guardar (" + (e && e.code || "error") + "). Inténtalo de nuevo.";
}

/* ---------- sign-in and access ---------- */
$("login").onclick = () => signInWithPopup(auth, new GoogleAuthProvider()).catch((e) => { $("gateText").textContent = "No se pudo entrar (" + e.code + ")."; });
$("logout").onclick = () => signOut(auth);
$("claim").onclick = async () => {
  try { await setDoc(doc(db, "config/owner"), { uid: state.user.uid, email: state.user.email, created: new Date().toISOString() }); boot(state.user); }
  catch (e) { $("gateText").textContent = "Otra persona ya es la administradora de esta web."; }
};

function gate(title, text, { login = false, claim = false } = {}) {
  $("gate").hidden = false; $("app").hidden = true;
  $("gateTitle").textContent = title; $("gateText").textContent = text;
  $("login").hidden = !login; $("claim").hidden = !claim;
}

async function roleFor(user) {
  const owner = await getDoc(doc(db, "config/owner"));
  if (!owner.exists()) return "unclaimed";
  if (owner.data().uid === user.uid) return "admin";
  try { const m = await getDoc(doc(db, "members", user.email.toLowerCase())); return m.exists() ? m.data().role : null; }
  catch (e) { return null; }
}

onAuthStateChanged(auth, (user) => boot(user));

async function boot(user) {
  unsubs.splice(0).forEach((u) => u());
  state.user = user;
  $("userbar").hidden = !user;
  if (!user) { gate("Entrar", "Entra con tu cuenta de Google para ver las pruebas.", { login: true }); return; }
  $("uName").textContent = user.displayName || user.email;
  $("uPhoto").src = user.photoURL || ""; $("uPhoto").hidden = !user.photoURL;
  const role = await roleFor(user);
  if (role === "unclaimed") { gate("Web nueva", "Nadie administra todavía esta web. Si es tuya, pulsa el botón y serás el administrador.", { claim: true }); return; }
  if (!role) { gate("Sin acceso", `Tu cuenta (${user.email}) no tiene acceso. Pide al administrador que te añada con este correo.`); return; }
  state.role = role;
  $("gate").hidden = true; $("app").hidden = false;
  document.body.classList.toggle("viewer-only-hide", !canEdit());
  $("adminPanel").hidden = role !== "admin";
  const err = (e) => showNotice("No se pudo leer el registro (" + e.code + ").");
  unsubs.push(onSnapshot(collection(db, "rallies"), (s) => { state.rallies = s.docs.map((d) => ({ id: d.id, ...d.data() })); render(); }, err));
  unsubs.push(onSnapshot(collection(db, "waypoints"), (s) => { state.wps = s.docs.map((d) => ({ id: d.id, ...d.data() })); render(); }, err));
  if (role === "admin") {
    unsubs.push(onSnapshot(collection(db, "members"), (s) => renderMembers(s.docs.map((d) => ({ id: d.id, ...d.data() })))));
    unsubs.push(onSnapshot(doc(db, "config/feed"), (s) => renderFeed(s.exists() ? s.data().token : null)));
  } else {
    $("feedUrl").textContent = "El administrador puede crear y compartir este enlace.";
  }
  loadMaps();
}

/* ---------- render ---------- */
function render() {
  if (state.rallyId && !rally()) state.rallyId = null;
  if (!state.rallyId && state.rallies.length) state.rallyId = ralliesSorted()[0].id;
  const r = rally();

  $("stYears").textContent = new Set(state.rallies.map((x) => x.year)).size;
  $("stStages").textContent = new Set(state.wps.filter((w) => stageKey(w) !== "").map((w) => w.rallyId + "|" + stageKey(w))).size;
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
  const stList = stagesOf(rallyWps());
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
  $("photos").disabled = !r; $("wSave").disabled = !r; $("gpxFile").disabled = !r;
  $("mapTitle").textContent = r ? scopeLabel() : "Mapa";
  renderTable(); renderMap(); renderReview(); renderDownloads();
}

function renderTable() {
  const tb = $("wpBody"); tb.textContent = "";
  const list = visibleWps();
  if (!list.length) {
    const tr = document.createElement("tr"); const td = document.createElement("td"); td.colSpan = 6; td.className = "hint";
    td.textContent = rally() ? "Aún no hay waypoints aquí." + (canEdit() ? " Importa las fotos del roadbook en el paso 3." : "") : "Todavía no hay ninguna prueba.";
    tr.append(td); tb.append(tr);
  }
  let last = null;
  list.forEach((w) => {
    const k = stageKey(w);
    if (k !== last) {
      last = k;
      const h = document.createElement("tr"); h.className = "stagehead"; const td = document.createElement("td"); td.colSpan = 6;
      td.textContent = stageLabel(k) + " · " + list.filter((x) => stageKey(x) === k).length + " WP"; h.append(td); tb.append(h);
    }
    const tr = document.createElement("tr"); tr.id = "row-" + w.id; if (state.hi === w.id) tr.className = "hi";
    [[w.name, "nm"], [fmtCoord(w.lat, true, state.fmt), "c"], [fmtCoord(w.lon, false, state.fmt), "c"], [w.page || "", "c"], [w.desc || "", ""]]
      .forEach(([t, cls]) => { const td = document.createElement("td"); td.textContent = t; if (cls) td.className = cls; tr.append(td); });
    const act = document.createElement("td"); act.className = "act";
    const link = (txt, href) => { const a = document.createElement("a"); a.className = "gm"; a.target = "_blank"; a.rel = "noopener"; a.href = href; a.textContent = txt; return a; };
    act.append(link("Maps", `https://www.google.com/maps/search/?api=1&query=${w.lat},${w.lon}`), " ", link("Earth", `https://earth.google.com/web/search/${w.lat},${w.lon}`));
    if (canEdit()) {
      const ed = document.createElement("button"); ed.type = "button"; ed.className = "ghost"; ed.textContent = "Editar"; ed.onclick = () => startEdit(w);
      const del = document.createElement("button"); del.type = "button"; del.className = "ghost"; del.textContent = "Borrar";
      del.onclick = async () => {
        if (del.dataset.armed) { try { await deleteDoc(doc(db, "waypoints", w.id)); } catch (er) { $("expMsg").textContent = writeErr(er); } return; }
        del.dataset.armed = "1"; del.textContent = "¿Seguro?"; del.className = "warn";
        setTimeout(() => { if (del.isConnected) { delete del.dataset.armed; del.textContent = "Borrar"; del.className = "ghost"; } }, 4000);
      };
      act.append(" ", ed, " ", del);
    }
    tr.append(act);
    tr.onclick = (ev) => { if (ev.target.closest("a,button")) return; state.hi = w.id; renderTable(); renderMap(); };
    tb.append(tr);
  });
  $("exportScope").textContent = list.length + " waypoints · " + scopeLabel();
}

/* ---------- Google Maps ---------- */
let gmap = null, overlays = [], mapsState = "idle", fitKey = "";
function loadMaps() {
  if (mapsState !== "idle") return;
  if (!CFG.mapsApiKey || CFG.mapsApiKey === "PEGA_AQUI") { mapsState = "nokey"; $("gmap").innerHTML = '<p class="hint" style="padding:16px">Falta la clave de Google Maps en config.js.</p>'; return; }
  mapsState = "loading";
  window.__initMap = () => {
    mapsState = "ready";
    gmap = new google.maps.Map($("gmap"), { center: { lat: 31.5, lng: -5.5 }, zoom: 6, mapTypeId: "hybrid", streetViewControl: false, fullscreenControl: true, gestureHandling: "greedy" });
    renderMap();
  };
  const s = document.createElement("script");
  s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(CFG.mapsApiKey)}&callback=__initMap&loading=async&language=es&region=ES`;
  s.async = true; s.onerror = () => { $("gmap").innerHTML = '<p class="hint" style="padding:16px">No se pudo cargar Google Maps. Revisa la clave.</p>'; };
  document.head.append(s);
}
function renderMap() {
  if (mapsState !== "ready") return;
  overlays.forEach((o) => o.setMap(null)); overlays = [];
  const list = visibleWps();
  $("scaleTxt").textContent = list.length ? "Colores por etapa · satélite de Google" : "Sin waypoints en esta selección";
  if (!list.length) return;
  const groups = {};
  list.forEach((w) => (groups[stageKey(w)] = groups[stageKey(w)] || []).push(w));
  Object.entries(groups).forEach(([s, ws]) => {
    if (ws.length < 2) return;
    overlays.push(new google.maps.Polyline({ map: gmap, path: ws.map((w) => ({ lat: w.lat, lng: w.lon })), strokeOpacity: 0,
      icons: [{ icon: { path: "M 0,-1 0,1", strokeOpacity: .9, strokeColor: stageColor(s), scale: 3 }, offset: "0", repeat: "14px" }] }));
  });
  const bounds = new google.maps.LatLngBounds();
  list.forEach((w) => {
    const hi = state.hi === w.id;
    const m = new google.maps.Marker({
      map: gmap, position: { lat: w.lat, lng: w.lon }, title: `${stageLabel(stageKey(w))} · ${w.name}`, zIndex: hi ? 999 : 1,
      icon: { path: google.maps.SymbolPath.CIRCLE, scale: hi ? 10 : 7, fillColor: stageColor(stageKey(w)), fillOpacity: 1, strokeColor: hi ? "#000" : "#fff", strokeWeight: 2, labelOrigin: new google.maps.Point(0, -2.6) },
      label: { text: w.name, color: "#fff", fontSize: "11px", fontWeight: "600" },
    });
    m.addListener("click", () => { state.hi = w.id; renderTable(); renderMap(); const row = $("row-" + w.id); if (row) row.scrollIntoView({ block: "nearest" }); });
    overlays.push(m); bounds.extend(m.getPosition());
  });
  const key = state.rallyId + "|" + state.stageFilter + "|" + list.length;
  if (key !== fitKey) { fitKey = key; gmap.fitBounds(bounds, 60); if (list.length === 1) gmap.setZoom(15); }
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
$("yearForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const d = { year: parseInt($("nyYear").value, 10), name: $("nyName").value.trim(), created: new Date().toISOString() };
  if (!d.year || !d.name) return;
  try { const ref = await addDoc(collection(db, "rallies"), d); $("yearForm").hidden = true; state.rallyId = ref.id; state.stageFilter = "all"; render(); }
  catch (err) { showNotice(writeErr(err)); }
});
function resetDel() { $("rallyDel").hidden = false; $("rallyDelYes").hidden = true; $("rallyDelNo").hidden = true; }
$("rallyDel").onclick = () => { $("rallyDel").hidden = true; $("rallyDelYes").hidden = false; $("rallyDelNo").hidden = false; };
$("rallyDelNo").onclick = resetDel;
$("rallyDelYes").onclick = async () => {
  const id = state.rallyId; if (!id) return;
  try {
    const mine = state.wps.filter((w) => w.rallyId === id);
    for (let i = 0; i < mine.length; i += 400) { const b = writeBatch(db); mine.slice(i, i + 400).forEach((w) => b.delete(doc(db, "waypoints", w.id))); await b.commit(); }
    await deleteDoc(doc(db, "rallies", id)); state.rallyId = null; resetDel();
  } catch (err) { showNotice(writeErr(err)); }
};

/* ---------- step 2: stage ---------- */
$("stageNo").addEventListener("change", () => {
  const s = currentStage(); if (s && stagesOf(rallyWps()).includes(s)) state.stageFilter = s; render();
  if (s && state.photos.length && !state.pending && !state.reading) readPhotos();
});

/* ---------- step 3: photos ---------- */
function setPhotos(files) {
  state.photos = [...files].filter((f) => /^image\//.test(f.type));
  const t = $("thumbs"); t.querySelectorAll("img").forEach((i) => URL.revokeObjectURL(i.src)); t.textContent = "";
  state.photos.forEach((f) => { const i = document.createElement("img"); i.src = URL.createObjectURL(f); i.alt = f.name; t.append(i); });
  $("clearPhotos").hidden = !state.photos.length; $("readBtn").hidden = true;
  $("photoMsg").textContent = state.photos.length ? state.photos.length + " foto(s) cargadas." + (currentStage() ? "" : " Pon el nº de etapa en el paso 2 y se leen solas.") : "";
  render();
  if (state.photos.length && currentStage()) readPhotos();
}
$("photos").addEventListener("change", (e) => setPhotos(e.target.files));
$("clearPhotos").onclick = () => { $("photos").value = ""; setPhotos([]); };
const drop = $("drop");
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); setPhotos(e.dataTransfer.files); });

// phone photos are large; send a 2000px JPEG, plenty to read the coordinates
async function toJpeg(file, max = 2000) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  const url = c.toDataURL("image/jpeg", 0.85);
  return { mediaType: "image/jpeg", data: url.slice(url.indexOf(",") + 1) };
}
$("readBtn").onclick = () => readPhotos();
async function readPhotos() {
  const msg = $("photoMsg");
  if (!currentStage()) { msg.textContent = "Pon primero el nº de etapa en el paso 2."; $("stageNo").focus(); return; }
  state.reading = true; render();
  const found = []; let failed = false;
  try {
    for (let i = 0; i < state.photos.length; i += 4) {
      const batch = state.photos.slice(i, i + 4);
      msg.textContent = `Leyendo foto${batch.length > 1 ? "s" : ""} ${i + 1}${batch.length > 1 ? "–" + (i + batch.length) : ""} de ${state.photos.length}…`;
      const images = await Promise.all(batch.map((f) => toJpeg(f)));
      const res = await leerRoadbook({ images });
      (res.data.waypoints || []).forEach((o) => found.push(o));
    }
  } catch (e) {
    failed = true;
    msg.textContent = (e && e.message) || "No se pudieron leer las fotos.";
  }
  state.reading = false;
  if (found.length) {
    state.pending = found.map((o) => ({
      on: parseCoord(o.lat, true) !== null && parseCoord(o.lon, false) !== null,
      name: String(o.name || "").trim(), latRaw: String(o.lat ?? ""), lonRaw: String(o.lon ?? ""), page: String(o.page || ""),
      desc: [o.box ? "Casilla " + o.box : "", o.km ? "km " + o.km : "", o.note || ""].filter(Boolean).join(", "), doubt: !!o.dudoso,
    }));
    msg.textContent = `Leídos ${found.length} waypoints. Están en la tabla: pulsa Guardar en la etapa.`;
  } else if (!failed) msg.textContent = "No encontré waypoints con coordenadas en las fotos.";
  $("readBtn").hidden = !state.photos.length;
  render();
  if (found.length) $("review").scrollIntoView({ behavior: "smooth", block: "start" });
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
  const have = new Set(rallyWps().map((w) => stageKey(w) + "|" + w.name));
  const seqBase = Date.now() * 100, now = new Date().toISOString();
  const b = writeBatch(db); let added = 0, skipped = 0;
  rows.forEach((x, i) => {
    if (have.has(st + "|" + x.name.trim())) { skipped++; return; }
    b.set(doc(collection(db, "waypoints")), { rallyId: r.id, stage: st, name: x.name.trim(), lat: parseCoord(x.latRaw, true), lon: parseCoord(x.lonRaw, false), page: x.page.trim(), desc: x.desc.trim(), seq: seqBase + i, source: "foto", created: now, by: state.user.email });
    added++;
  });
  $("revSave").disabled = true;
  try {
    await b.commit();
    state.pending = null; state.stageFilter = st;
    $("photoMsg").textContent = `Guardados ${added} waypoints en la etapa ${st || "(sin número)"}` + (skipped ? `; ${skipped} ya existían y no se duplicaron.` : ".");
    $("photos").value = ""; setPhotos([]);
  } catch (e) { $("photoMsg").textContent = writeErr(e); }
  $("revSave").disabled = false; render();
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
    if (ed) await updateDoc(doc(db, "waypoints", ed), d);
    else await addDoc(collection(db, "waypoints"), { ...d, seq: Date.now() * 100, source: "manual", created: new Date().toISOString(), by: state.user.email });
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
  const st = currentStage(), seqBase = Date.now() * 100, now = new Date().toISOString();
  const have = new Set(rallyWps().map((w) => stageKey(w) + "|" + w.name + "|" + w.lat + "|" + w.lon));
  const txtOf = (n, t) => { const el = n.getElementsByTagName(t)[0]; return el ? el.textContent.trim() : ""; };
  const rows = [];
  nodes.forEach((n, i) => {
    const lat = Math.round(parseFloat(n.getAttribute("lat")) * 1e6) / 1e6, lon = Math.round(parseFloat(n.getAttribute("lon")) * 1e6) / 1e6;
    const name = txtOf(n, "name") || "WP" + (i + 1);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || have.has(st + "|" + name + "|" + lat + "|" + lon)) return;
    rows.push({ rallyId: state.rallyId, stage: st, name, lat, lon, page: "", desc: txtOf(n, "desc") || txtOf(n, "cmt"), seq: seqBase + i, source: "gpx", created: now, by: state.user.email });
  });
  try {
    for (let i = 0; i < rows.length; i += 400) { const b = writeBatch(db); rows.slice(i, i + 400).forEach((r) => b.set(doc(collection(db, "waypoints")), r)); await b.commit(); }
    msg.textContent = `Añadidos ${rows.length} waypoints a ${stageLabel(st).toLowerCase()}` + (nodes.length > rows.length ? ` (${nodes.length - rows.length} repetidos u omitidos).` : ".");
  } catch (err) { msg.textContent = writeErr(err); }
});

/* ---------- export ---------- */
const xe = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
const descOf = (w) => [w.page ? "Pág " + w.page : "", w.desc].filter(Boolean).join(" · ");
function buildGpx(list, title) {
  const pad = $("padNums").checked;
  const nm = (w) => pad ? String(w.name).replace(/\d+/, (d) => d.padStart(3, "0")) : String(w.name);
  let o = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Libro de Rallies" xmlns="http://www.topografix.com/GPX/1/1">\n  <metadata><name>${xe(title)}</name></metadata>\n`;
  list.slice().sort(wpOrder).forEach((w) => {
    o += `  <wpt lat="${w.lat.toFixed(6)}" lon="${w.lon.toFixed(6)}">\n    <name>${xe(nm(w))}</name>\n    <cmt>${xe(w.name)}</cmt>\n    <desc>${xe(descOf(w))}</desc>\n    <sym>Flag</sym>\n  </wpt>\n`;
  });
  return o + `</gpx>\n`;
}
function buildKml(list) {
  const r = rally(), groups = {};
  list.forEach((w) => (groups[stageKey(w)] = groups[stageKey(w)] || []).push(w));
  const abgr = (c) => "ff" + c.slice(5, 7) + c.slice(3, 5) + c.slice(1, 3);
  let styles = "", folders = "";
  Object.keys(groups).sort((a, b) => ((a === "") - (b === "")) || natural(a, b)).forEach((s) => {
    const sid = "e" + (s || "x");
    styles += `  <Style id="${sid}"><IconStyle><color>${abgr(stageColor(s))}</color><Icon><href>http://maps.google.com/mapfiles/kml/paddle/wht-blank.png</href></Icon></IconStyle></Style>\n`;
    folders += `  <Folder><name>${xe(stageLabel(s))}</name>\n`;
    groups[s].slice().sort(wpOrder).forEach((w) => {
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
  stagesOf(all).forEach((s) => {
    const b = document.createElement("button"); b.type = "button";
    b.className = state.stageFilter === "all" || state.stageFilter === s ? "" : "ghost";
    b.textContent = "GPX " + (s === "" ? "sin etapa" : "etapa " + s);
    b.onclick = () => {
      const list = all.filter((w) => stageKey(w) === s);
      download(stageFile(s) + ".gpx", buildGpx(list, rally().year + " " + rally().name + " · " + stageLabel(s)), "application/gpx+xml");
      $("expMsg").textContent = `Descargado ${stageFile(s)}.gpx con ${list.length} waypoints en orden.`;
    };
    box.append(b);
  });
  $("dlKml").disabled = !visibleWps().length;
}
$("dlKml").onclick = () => {
  const f = state.stageFilter === "all" ? baseName() : stageFile(state.stageFilter);
  download(f + ".kml", buildKml(visibleWps()), "application/vnd.google-earth.kml+xml");
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
    sel.onchange = () => setDoc(doc(db, "members", m.id), { role: sel.value, added: m.added || new Date().toISOString() }).catch((e) => { $("mMsg").textContent = writeErr(e); });
    const rm = document.createElement("button"); rm.type = "button"; rm.className = "ghost"; rm.textContent = "Quitar";
    rm.onclick = () => deleteDoc(doc(db, "members", m.id)).catch((e) => { $("mMsg").textContent = writeErr(e); });
    const right = document.createElement("span"); right.className = "btns"; right.append(sel, rm);
    li.append(em, right); ul.append(li);
  });
}
$("memberForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("mEmail").value.trim().toLowerCase();
  try { await setDoc(doc(db, "members", email), { role: $("mRole").value, added: new Date().toISOString() }); $("mEmail").value = ""; $("mMsg").textContent = `${email} ya puede entrar con su cuenta de Google en esta misma dirección.`; }
  catch (err) { $("mMsg").textContent = writeErr(err); }
});
function renderFeed(token) {
  $("feedMake").hidden = !!token; $("feedCopy").disabled = !token;
  $("feedUrl").textContent = token ? `${location.origin}/kml/${token}.kml` : "Aún no hay enlace. Créalo con el botón.";
}
$("feedMake").onclick = async () => {
  const token = [...crypto.getRandomValues(new Uint8Array(18))].map((b) => b.toString(16).padStart(2, "0")).join("");
  try { await setDoc(doc(db, "config/feed"), { token, created: new Date().toISOString() }); } catch (e) { $("gMsg").textContent = writeErr(e); }
};
$("feedCopy").onclick = async () => {
  try { await navigator.clipboard.writeText($("feedUrl").textContent); $("gMsg").textContent = "Enlace copiado. En Google Earth Pro: Añadir › Enlace de red y pégalo."; }
  catch (e) { $("gMsg").textContent = "Selecciona el enlace y cópialo."; }
};
