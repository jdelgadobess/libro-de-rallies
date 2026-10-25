// The phone's GPS: where am I on the map, and recording the route driven as a track.
// The recording is kept on the device as it goes, so a reload or a lost connection doesn't lose it.
import { idb } from "./mapas.js";
const $ = (id) => document.getElementById(id);
const R = 6371008.8, rad = Math.PI / 180;
const meters = (a, b) => {
  const h = Math.sin((b[0] - a[0]) * rad / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin((b[1] - a[1]) * rad / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const MIN_STEP = 8, MAX_ACC = 60, GAP_MS = 120000; // metres between saved points, worst accuracy kept, pause that starts a new segment
const fmtTime = (s) => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; return h ? `${h} h ${String(m).padStart(2, "0")} min` : `${m} min ${String(s % 60).padStart(2, "0")} s`; };
const kmOf = (segs) => segs.reduce((t, s) => { for (let i = 1; i < s.length; i++) t += meters(s[i - 1], s[i]); return t; }, 0) / 1000;

// distance in metres from a point to a route, and the nearest point on it (flat projection: fine at these distances)
function nearestOn(p, segs) {
  const kx = Math.cos(p[0] * rad) * R * rad, ky = R * rad;
  let best = { d: Infinity, at: null };
  for (const s of segs) for (let i = 0; i < s.length; i++) {
    const a = s[i], b = s[i + 1] || a;
    const ax = (a[1] - p[1]) * kx, ay = (a[0] - p[0]) * ky, bx = (b[1] - p[1]) * kx, by = (b[0] - p[0]) * ky;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
    const x = ax + t * dx, y = ay + t * dy, d = Math.hypot(x, y);
    if (d < best.d) best = { d, at: [p[0] + y / ky, p[1] + x / kx] };
  }
  return best;
}
const brg = (a, b) => { const y = Math.sin((b[1] - a[1]) * rad) * Math.cos(b[0] * rad), x = Math.cos(a[0] * rad) * Math.sin(b[0] * rad) - Math.sin(a[0] * rad) * Math.cos(b[0] * rad) * Math.cos((b[1] - a[1]) * rad); return (Math.atan2(y, x) / rad + 360) % 360; };
const card = (d) => ["N", "NE", "E", "SE", "S", "SO", "O", "NO"][Math.round(d / 45) % 8];
// beeps with the phone's speaker; the sound is unlocked when «Iniciar ruta» is tapped
let actx = null;
const audioOn = () => { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === "suspended") actx.resume(); } catch (e) {} };
// browsers only allow sound after a tap: the first touch anywhere turns it on
["pointerdown", "keydown"].forEach((ev) => document.addEventListener(ev, audioOn, { capture: true, passive: true }));
function beep(times, ms, hz) {
  if (!actx) return;
  if (actx.state === "suspended") actx.resume().catch(() => {});
  for (let i = 0; i < times; i++) {
    const t = actx.currentTime + i * (ms + 120) / 1000, o = actx.createOscillator(), g = actx.createGain();
    o.type = "square"; o.frequency.value = hz; g.gain.setValueAtTime(0.25, t); g.gain.setValueAtTime(0, t + ms / 1000);
    o.connect(g).connect(actx.destination); o.start(t); o.stop(t + ms / 1000 + 0.02);
  }
}
// recorded time without the pauses
const recSecs = (r) => Math.max(0, ((r.end || Date.now()) - r.start - (r.pausedMs || 0) - (r.paused ? Date.now() - r.paused : 0)) / 1000);
const say = (t) => { try { if (!("speechSynthesis" in window)) return; speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(t); u.lang = "es-ES"; u.rate = 1; speechSynthesis.speak(u); } catch (e) {} };

export function setupGps({ map, sb, canEdit, rallyId, stage, user, writeErr, onSaved, onMeasure, onMove, routes, waypoints, layers, busy }) {
  const layer = L.layerGroup().addTo(map), recLayer = L.layerGroup().addTo(map);
  // on a phone or tablet the map comes in close when the GPS starts following, so tracks and the way ahead read well;
  // after that the zoom is the driver's (+ and -)
  const CLOSE = window.matchMedia && matchMedia("(pointer: coarse)").matches ? 17 : 15;
  let zoomIn = true;
  let watch = null, follow = true, last = null, rec = null, wake = null, dot = null, ring = null, head = null, recLine = null, pendingTry = false;
  let course; // where I'm heading, degrees from north: the GPS's own when moving, else from the last metres driven
  let cPrev = null;
  // the map turned with two fingers, or along the way I drive («Marcha») with north wherever it falls
  const canRot = !!(map.setBearing && map._rotate);
  const bear = () => (canRot ? map.getBearing() : 0);
  let hold = false; // a stage just picked keeps the map on it until "Mi posición" is pressed
  let up = canRot && localStorage.getItem("rally.up") !== "0", selfRot = false, handRot = 0, lastUser = 0;
  const setB = (b) => { if (!canRot) return; const d = Math.abs(((b - bear()) % 360 + 540) % 360 - 180); if (d < 2) return; selfRot = true; map.setBearing(b); selfRot = false; };
  let fol = null; // the route being followed (declared here: the buttons read it from the start)
  let keepUntil = 0; // an important message stays a few seconds before the accuracy readout replaces it
  const msg = (t, sticky) => { if (!sticky && Date.now() < keepUntil) return; $("gpsMsg").textContent = t || ""; if (sticky) keepUntil = Date.now() + 10000; };

  function ui() {
    $("gpsBtn").textContent = watch === null ? "📍 Mi posición (GPS)" : follow ? "📍 GPS activo · siguiendo" : "📍 GPS activo · centrar";
    $("gpsBtn").className = watch === null ? "ghost" : "hl";
    // one button: recording also follows the stage's route (there is no separate «Iniciar ruta»)
    const going = !!(rec || fol);
    $("recBtn").textContent = going ? "⏹ Terminar ruta" : canEdit() ? "⏺ Grabar ruta" : "▶ Seguir la ruta";
    $("recBtn").className = going ? "warn" : "ghost";
    $("recBtn").hidden = false;
    $("recDrop").hidden = !rec;
    $("gpsMeasure").hidden = watch === null;
    $("recStage").hidden = true; $("recStage").disabled = !!rec; // the stage is the one chosen in the Libro de ruta
    if (rec) $("recStage").value = rec.stage;
    if (rec) {
      $("recInfo").textContent = `${rec.paused ? "⏸ En pausa" : "Grabando"} · ${kmOf(rec.segs).toFixed(2)} km · ${fmtTime(recSecs(rec))}`;
    } else $("recInfo").textContent = "";
    // the record / pause / stop buttons on top of the app
    const on = !!(rec || fol);
    $("rcGo").disabled = !!rec && !rec.paused; $("rcGo").title = rec && rec.paused ? "Seguir grabando" : "Grabar ruta";
    $("rcPause").disabled = !rec || !!rec.paused;
    $("rcStop").disabled = !on;
    $("recCtl").classList.toggle("live", !!rec && !rec.paused); $("recCtl").classList.toggle("paused", !!(rec && rec.paused));
  }

  function draw(p) {
    const ll = [p.coords.latitude, p.coords.longitude], acc = p.coords.accuracy || 0;
    if (!dot) {
      ring = L.circle(ll, { radius: acc, color: "#1a73e8", weight: 1, fillColor: "#1a73e8", fillOpacity: .12, interactive: false }).addTo(layer);
      dot = L.circleMarker(ll, { radius: 8, color: "#fff", weight: 3, fillColor: "#1a73e8", fillOpacity: 1 }).bindTooltip("Estás aquí · tócame para medir desde aquí").addTo(layer);
      dot.on("click", (e) => { L.DomEvent.stopPropagation(e); measureHere(); });
    } else { dot.setLatLng(ll); ring.setLatLng(ll).setRadius(acc); }
    // once I'm moving, an arrow twice the dot's size pointing where I'm heading takes the dot's place
    // (the dot stays, invisible, so it can still be touched to measure from here)
    if (course !== undefined) {
      const icon = L.divIcon({ className: "gps-head", iconSize: [46, 46], iconAnchor: [23, 23],
        html: `<svg viewBox="0 0 46 46" style="transform:rotate(${Math.round(course)}deg)"><path d="M23 3 L39 41 L23 32 L7 41 Z" fill="#1a73e8" stroke="#fff" stroke-width="3" stroke-linejoin="round"/></svg>` });
      if (!head) head = L.marker(ll, { icon, rotateWithView: true, interactive: false, keyboard: false }).addTo(layer); else head.setLatLng(ll).setIcon(icon);
      dot.setStyle({ opacity: 0, fillOpacity: 0 });
    } else { if (head) { layer.removeLayer(head); head = null; } dot.setStyle({ opacity: 1, fillOpacity: 1 }); }
    if (follow) center(ll);
  }
  // the map goes where I am; along the way, with me low on the screen so more of the road ahead shows
  function center(ll) {
    const z = zoomIn ? Math.max(map.getZoom(), CLOSE) : map.getZoom(); zoomIn = false;
    if (up && course !== undefined && Date.now() - handRot > 8000) setB(360 - course);
    let c = L.latLng(ll);
    if (canRot && up && course !== undefined) {
      const px = map.project(c, z), b = -bear() * rad, k = map.getSize().y * 0.22;
      c = map.unproject(px.add([Math.sin(b) * k, -Math.cos(b) * k]), z);
    }
    map.setView(c, z, { animate: true });
  }

  function onPos(p) {
    last = p;
    const here = [p.coords.latitude, p.coords.longitude], hd = p.coords.heading;
    if (p.coords.accuracy <= MAX_ACC) {
      if (!cPrev) cPrev = here;
      else if (meters(cPrev, here) >= 5) { course = brg(cPrev, here); cPrev = here; }
      if (hd !== null && hd !== undefined && !Number.isNaN(hd) && (p.coords.speed || 0) > 1) course = hd;
    }
    draw(p);
    if (offOn() && !offLooked) applyOff(false); onMove(p.coords.latitude, p.coords.longitude); checkRoute(p); checkNav(p);
    const speed = p.coords.speed ? ` · ${Math.round(p.coords.speed * 3.6)} km/h` : "";
    msg(`Precisión ±${Math.round(p.coords.accuracy)} m${speed}`);
    if (rec && !rec.paused && p.coords.accuracy <= MAX_ACC) {
      const pt = [Math.round(p.coords.latitude * 1e6) / 1e6, Math.round(p.coords.longitude * 1e6) / 1e6];
      let seg = rec.segs[rec.segs.length - 1];
      const prev = seg && seg[seg.length - 1];
      if (!seg || (rec.lastT && p.timestamp - rec.lastT > GAP_MS)) { seg = []; rec.segs.push(seg); }
      if (!prev || meters(prev, pt) >= MIN_STEP || seg.length === 0) {
        seg.push(pt); rec.lastT = p.timestamp;
        idb.put("kv", rec, "rec").catch(() => {});
        drawRec();
      }
    }
    ui();
  }
  function onErr(e) {
    const why = e.code === 1 ? "No has dado permiso para usar la ubicación. Actívalo en los ajustes del navegador (en iPhone: Ajustes › Privacidad › Localización › Safari)." :
      e.code === 2 ? "No hay señal de GPS ahora mismo." : "El GPS tarda en responder; sigo intentándolo.";
    msg(why, true);
    if (e.code === 1) stopWatch();
  }
  function startWatch() {
    if (!("geolocation" in navigator)) { msg("Este navegador no tiene GPS."); return false; }
    if (watch !== null) return true;
    watch = navigator.geolocation.watchPosition(onPos, onErr, { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
    // the screen stays on while the GPS is on: with it off the phone stops and the beeps don't sound
    keepAwake(); sndAsk();
    msg("Buscando señal de GPS…"); ui(); return true;
  }
  function stopWatch() {
    if (watch !== null) navigator.geolocation.clearWatch(watch);
    watch = null; layer.clearLayers(); dot = ring = head = null; course = undefined; cPrev = null; hdg.hidden = true; wpb.hidden = true; ui(); sndAsk();
    if (!rec && wake) { wake.release().catch(() => {}); wake = null; }
  }

  function drawRec() {
    recLayer.clearLayers();
    if (!rec) return;
    rec.segs.forEach((s) => { if (s.length > 1) { L.polyline(s, { color: "#000", weight: 7, opacity: .35, interactive: false }).addTo(recLayer); L.polyline(s, { color: "#ffd600", weight: 4, interactive: false }).addTo(recLayer); } });
  }

  // keeps the screen on while recording: with the screen off the phone stops giving the browser positions
  async function keepAwake() {
    try { if ((rec || watch !== null) && !wake && "wakeLock" in navigator && document.visibilityState === "visible") wake = await navigator.wakeLock.request("screen"); } catch (e) { wake = null; }
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") keepAwake(); });

  async function startRec(resumed) {
    if (!rallyId()) { msg("Elige primero el año en el paso 1.", true); return; }
    if (!resumed && !stage()) { msg("Elige primero la etapa en el Libro de ruta: la ruta se graba en ella.", true); return; }
    if (!startWatch()) return;
    if (!resumed) rec = { start: Date.now(), segs: [], rally: rallyId(), stage: stage() };
    idb.put("kv", rec, "rec").catch(() => {});
    follow = true; hold = false; zoomIn = true; keepAwake(); drawRec(); ui();
    clearInterval(startRec.t); startRec.t = setInterval(ui, 1000);
  }

  async function upload(r) {
    const segs = r.segs.filter((s) => s.length > 1);
    const d = new Date(r.start);
    const name = `Grabada ${d.toLocaleDateString("es", { day: "2-digit", month: "2-digit" })} ${d.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })}`;
    const row = { rally_id: r.rally, stage: r.stage || "", name, points: segs, kind: "grabada", meta: { start: new Date(r.start).toISOString(), end: new Date(r.end).toISOString(), secs: Math.round(recSecs(r)), km: Math.round(kmOf(segs) * 100) / 100 }, created_by: user().email };
    const { error } = await sb.from("tracks").insert(row);
    if (error) throw error;
    return row;
  }
  async function stopRec() {
    rec.end = Date.now();
    if (rec.paused) { rec.pausedMs = (rec.pausedMs || 0) + rec.end - rec.paused; rec.paused = null; }
    const r = rec; rec = null; clearInterval(startRec.t);
    if (wake) { wake.release().catch(() => {}); wake = null; }
    idb.del("kv", "rec").catch(() => {});
    recLayer.clearLayers(); ui();
    if (!r.segs.some((s) => s.length > 1)) { msg("La grabación no tenía recorrido: no se ha guardado.", true); return; }
    if (offOn()) { await keep(r); msg("Ruta guardada en el móvil. Se subirá cuando quites «Trabajar sin conexión» y haya internet.", true); return; }
    try { const row = await upload(r); msg(`Ruta guardada en la etapa ${r.stage} («Rutas grabadas»): ${row.meta.km.toFixed(2)} km en ${fmtTime(row.meta.secs)}.`, true); onSaved(); }
    catch (e) {
      // no connection: kept on the phone and sent as soon as there is internet
      await keep(r);
      msg(navigator.onLine ? "No se pudo guardar: " + writeErr(e) + " Queda en el móvil y lo intento de nuevo luego." : "Sin conexión: la ruta queda guardada en el móvil y se subirá cuando haya internet.", true);
    }
  }
  async function keep(r) {
    let pend = []; try { pend = (await idb.get("kv", "recPending")) || []; } catch (er) {}
    pend.push(r); await idb.put("kv", pend, "recPending").catch(() => {});
  }
  async function sendPending() {
    if (pendingTry || !navigator.onLine || offOn()) return; pendingTry = true;
    try {
      let pend = (await idb.get("kv", "recPending")) || [];
      if (pend.length) {
        const left = [];
        for (const r of pend) { try { await upload(r); } catch (e) { left.push(r); } }
        await idb.put("kv", left, "recPending");
        if (left.length < pend.length) { msg(`${pend.length - left.length} ruta${pend.length - left.length > 1 ? "s grabadas subidas" : " grabada subida"} ahora que hay conexión.`, true); onSaved(); }
      }
    } catch (e) {}
    pendingTry = false;
  }
  window.addEventListener("online", sendPending);

  $("gpsBtn").onclick = () => {
    audioOn(); // the beeps need a tap to be allowed
    if (watch === null) { follow = true; hold = false; zoomIn = true; startWatch(); }
    else if (!follow) { follow = true; hold = false; zoomIn = true; if (last) draw(last); ui(); }
    else if (!rec) stopWatch();
    else { follow = false; ui(); }
  };
  map.on("dragstart", () => { if (watch !== null && follow) { follow = false; ui(); } });
  // after a few seconds without touching the map it goes back to my arrow, and turns along the way again
  const touched = () => { lastUser = Date.now(); };
  ["pointerdown", "touchstart", "wheel"].forEach((ev) => map.getContainer().addEventListener(ev, touched, { passive: true }));
  map.on("drag", touched);
  map.on("rotate", () => { compass(); if (!selfRot) { handRot = Date.now(); touched(); } });
  setInterval(() => {
    if (hold || watch === null || follow || !last || Date.now() - lastUser < 8000) return;
    if (busy && busy()) return;
    follow = true; hold = false; draw(last); ui();
  }, 2000);
  const Compass = L.Control.extend({ options: { position: "topleft" }, onAdd() {
    const b = L.DomUtil.create("button", "compass-ctl"); b.type = "button"; b.id = "compassBtn";
    L.DomEvent.disableClickPropagation(b);
    b.onclick = () => {
      up = !up; try { localStorage.setItem("rally.up", up ? "1" : "0"); } catch (e) {}
      handRot = 0;
      if (!up) setB(0); else if (last && watch !== null) { follow = true; hold = false; draw(last); ui(); }
      compass();
    };
    return b;
  } });
  const compass = () => {
    const b = $("compassBtn"); if (!b) return;
    b.innerHTML = `<svg viewBox="0 0 24 24" style="transform:rotate(${Math.round(bear())}deg)"><path d="M12 2 L16 12 L8 12 Z" fill="#c62828"/><path d="M12 22 L16 12 L8 12 Z" fill="#9aa3ad"/></svg><span>${up ? "Marcha" : "Norte"}</span>`;
    b.title = up ? "El mapa gira con el sentido de la marcha. Toca para poner el norte arriba." : "Norte arriba (gira con dos dedos). Toca para que el mapa gire con la marcha.";
    b.classList.toggle("on", up);
  };
  if (canRot) { new Compass().addTo(map); compass(); }
  /* ---------- following a route: a warning when I leave it by more than the metres chosen ---------- */
  fol = null; // { route, thr, off, quiet, lastWarn, ownRec }
  const folLayer = L.layerGroup().addTo(map);
  const banner = document.createElement("div"); banner.className = "offroute"; banner.hidden = true;
  banner.innerHTML = '<span id="offTxt"></span><button type="button" id="offOk">🔇 Silenciar</button>';
  L.DomEvent.disableClickPropagation(banner); map.getContainer().append(banner);
  // «Silenciar»: no more spoken warnings for this route (until «Avisar» or the route ends)
  banner.querySelector("#offOk").onclick = () => { if (!fol) return; fol.quiet = !fol.quiet; if (fol.quiet) { try { speechSynthesis.cancel(); } catch (e) {} } else { fol.lastWarn = 0; say("Avisos activados"); } showOff(fol.lastD); };
  function showOff(d) {
    banner.hidden = !fol || !fol.off;
    banner.classList.toggle("quiet", !!(fol && fol.quiet));
    banner.querySelector("#offTxt").textContent = fol && fol.quiet ? `🔇 Fuera de la ruta: ${Math.round(d)} m (avisos en silencio)` : `⚠ Te estás desviando: ${Math.round(d)} m de la ruta`;
    banner.querySelector("#offOk").textContent = fol && fol.quiet ? "🔔 Avisar" : "🔇 Silenciar";
  }
  function followUi() {
    ui();
    $("followBtn").textContent = fol ? "⏹ Terminar ruta" : "▶ Iniciar ruta";
    $("followBtn").className = fol ? "warn" : "hl";
    $("followSel").disabled = !!fol;
    $("followInfo").textContent = fol ? `Siguiendo «${fol.route.name}» · aviso a ${fol.thr} m` : "";
  }
  function checkRoute(p) {
    if (!fol || p.coords.accuracy > MAX_ACC || !fol.route.segs.length) return;
    const here = [p.coords.latitude, p.coords.longitude], n = nearestOn(here, fol.route.segs);
    if (!n.at) return;
    fol.lastD = n.d; folLayer.clearLayers();
    if (n.d > fol.thr) {
      L.polyline([here, n.at], { color: "#c62828", weight: 4, dashArray: "8 6", interactive: false })
        .bindTooltip(`${Math.round(n.d)} m a la ruta`, { permanent: true, direction: "center", className: "wp-lbl dist" }).addTo(folLayer);
      L.circleMarker(n.at, { radius: 6, color: "#fff", weight: 2, fillColor: "#c62828", fillOpacity: 1, interactive: false }).addTo(folLayer);
      if (!fol.off) { fol.off = true; fol.lastWarn = 0; }
      if (!fol.quiet && Date.now() - fol.lastWarn > 45000) {
        fol.lastWarn = Date.now(); say(`Te estás desviando. ${Math.round(n.d)} metros de la ruta`);
        try { navigator.vibrate && navigator.vibrate([300, 150, 300]); } catch (e) {}
      }
      showOff(n.d);
    } else if (fol.off && n.d <= fol.thr * 0.7) {
      fol.off = false; showOff(0); if (!fol.quiet) say("De nuevo en la ruta");
    } else if (fol.off) showOff(n.d);
  }
  /* ---------- while following: the course in a box, and each waypoint announced at 50 m and taken at 5 m ---------- */
  const NEAR = 50, TAKEN = 5;
  const hdg = document.createElement("div"); hdg.className = "navbox hdg"; hdg.hidden = true;
  const wpb = document.createElement("div"); wpb.className = "navbox wpnav"; wpb.hidden = true;
  [hdg, wpb].forEach((d) => { L.DomEvent.disableClickPropagation(d); map.getContainer().append(d); });
  const arrowSvg = (deg, color) => `<svg viewBox="0 0 40 40" style="transform:rotate(${Math.round(deg)}deg)"><path d="M20 3 L31 33 L20 26 L9 33 Z" fill="${color}" stroke="#fff" stroke-width="2"/></svg>`;
  // the course box shows whenever the GPS is on, following a route or not
  // speed limit chosen in «Ajustes»: over it, three quick beeps every few seconds and the box turns red; empty: never
  const spdIn = $("spdMax");
  try { spdIn.value = localStorage.getItem("rally.spdMax") || ""; } catch (e) {}
  spdIn.addEventListener("change", () => { try { localStorage.setItem("rally.spdMax", spdIn.value); } catch (e) {} });
  let spdBeep = 0;
  function checkSpeed(kmh) {
    const max = parseFloat(spdIn.value), over = max > 0 && kmh > max;
    hdg.classList.toggle("fast", over);
    if (over && Date.now() - spdBeep > 4000) { spdBeep = Date.now(); beep(3, 110, 1700); }
  }
  // the speed the GPS gives; some phones give none: then from the distance since the last fix
  let sPrev = null, sCalc = 0;
  function speedOf(p) {
    const here = [p.coords.latitude, p.coords.longitude], t = p.timestamp || Date.now();
    if (sPrev && t - sPrev.t >= 1000 && p.coords.accuracy <= MAX_ACC) { sCalc = meters(sPrev.ll, here) / ((t - sPrev.t) / 1000); sPrev = { ll: here, t }; }
    else if (!sPrev || t - sPrev.t > 30000) sPrev = { ll: here, t };
    return p.coords.speed !== null && p.coords.speed !== undefined && !Number.isNaN(p.coords.speed) ? p.coords.speed : sCalc;
  }
  function showHdg(p) {
    const spd = speedOf(p);
    checkSpeed(spd * 3.6);
    hdg.hidden = false;
    hdg.innerHTML = course === undefined ? `<b>Rumbo</b><span class="big">—</span><small>muévete unos metros</small>`
      : `<b>Rumbo</b>${arrowSvg(course + bear(), "#1a73e8")}<span class="big">${String(Math.round(course) % 360).padStart(3, "0")}°</span><small>${card(course)}${spd ? " · " + Math.round(spd * 3.6) + " km/h" : ""}</small>`;
  }
  // the browser only lets the page beep after a touch (after opening or updating the app there has been none):
  // while the GPS is on and the sound is still locked, a notice asks for one touch
  const snd = document.createElement("button"); snd.type = "button"; snd.className = "sndask"; snd.hidden = true;
  snd.textContent = "🔇 Toca aquí para activar los pitidos de los waypoints";
  L.DomEvent.disableClickPropagation(snd); map.getContainer().append(snd);
  snd.onclick = () => { audioOn(); setTimeout(() => { beep(1, 150, 880); sndAsk(); }, 150); };
  function sndAsk() { try { snd.hidden = watch === null || !!(actx && actx.state === "running"); } catch (e) {} }
  ["pointerdown", "keydown"].forEach((ev) => document.addEventListener(ev, () => setTimeout(sndAsk, 200), { passive: true }));
  setInterval(sndAsk, 3000);
  // «Probar pitidos» in Ajustes: the three warnings one after the other
  const tb = $("beepTest");
  if (tb) tb.onclick = () => { audioOn(); setTimeout(() => { beep(1, 150, 880); setTimeout(() => beep(2, 150, 880), 1200); setTimeout(() => beep(1, 2000, 1320), 2800); sndAsk(); }, 150); };
  // waypoint alerts whenever the GPS is on: 50 m one short beep, 10 m two short beeps, 5 m one long beep of 2 s (taken)
  const nav = { taken: new Set(), level: new Map(), lastTaken: null };
  const NEAR2 = 10;
  /* ---------- «Llévame»: guided to one waypoint, with an arrow, the distance and a line to it ---------- */
  let goTo = null;
  const goLayer = L.layerGroup().addTo(map);
  const fmtD = (d) => d < 1000 ? Math.round(d) + " m" : (d / 1000).toFixed(d < 10000 ? 2 : 1).replace(".", ",") + " km";
  function showGo(here) {
    goLayer.clearLayers(); if (!goTo) return false;
    const t = [goTo.lat, goTo.lon], d = meters(here, t), b = brg(here, t);
    if (d <= TAKEN) {
      say(`Has llegado al waypoint ${goTo.name}`); beep(1, 2000, 1320);
      wpb.hidden = false; wpb.innerHTML = `<span class="ok">✓ Has llegado a WP ${goTo.name}</span>`; goTo = null; return true;
    }
    L.polyline([here, t], { color: "#1a73e8", weight: 4, dashArray: "8 8", interactive: false }).addTo(goLayer);
    L.circleMarker(t, { radius: 11, color: "#1a73e8", weight: 3, fill: false, interactive: false }).addTo(goLayer);
    wpb.hidden = false;
    wpb.innerHTML = `${arrowSvg(b + bear(), "#1a73e8")}<div><b>Llévame a WP ${goTo.name}${goTo.pts ? " · " + goTo.pts + " pts" : ""}</b><span class="big">${fmtD(d)}</span><small>rumbo ${String(Math.round(b) % 360).padStart(3, "0")}° ${card(b)}</small></div><button type="button" class="gox" aria-label="Dejar de ir a este waypoint">✕</button>`;
    wpb.querySelector(".gox").onclick = () => { goTo = null; goLayer.clearLayers(); wpb.hidden = true; say("Vale"); };
    return true;
  }
  function checkNav(p) {
    showHdg(p);
    if (p.coords.accuracy > MAX_ACC) return;
    const here = [p.coords.latitude, p.coords.longitude];
    if (fol) fol.course = course;
    // the nearest waypoint of the stage not taken yet
    let best = null;
    for (const w of waypoints()) {
      if (nav.taken.has(w.id)) continue;
      const d = meters(here, [w.lat, w.lon]);
      // gone well away from one: it warns again when coming back
      if (d > NEAR + 30) nav.level.delete(w.id);
      if (!best || d < best.d) best = { w, d };
    }
    if ((!best || best.d > NEAR) && showGo(here)) return;
    if (!best || best.d > NEAR) { wpb.hidden = !nav.lastTaken || Date.now() - nav.lastTaken.at > 8000; if (!wpb.hidden) wpb.innerHTML = `<span class="ok">✓ WP ${nav.lastTaken.name} cogido</span>`; return; }
    const w = best.w, b = brg(here, [w.lat, w.lon]), lv = nav.level.get(w.id) || 0;
    if (best.d <= TAKEN) {
      nav.taken.add(w.id); nav.lastTaken = { name: w.name, at: Date.now() };
      if (goTo && goTo.id === w.id) { goTo = null; goLayer.clearLayers(); say(`Has llegado al waypoint ${w.name}`); }
      beep(1, 2000, 1320); try { navigator.vibrate && navigator.vibrate(2000); } catch (e) {}
      wpb.hidden = false; wpb.innerHTML = `<span class="ok">✓ WP ${w.name} cogido${w.pts ? " · " + w.pts + " pts" : ""}</span>`;
      return;
    }
    if (best.d <= NEAR2 && lv < 2) { nav.level.set(w.id, 2); beep(2, 150, 880); try { navigator.vibrate && navigator.vibrate([150, 100, 150]); } catch (e) {} }
    else if (lv < 1) { nav.level.set(w.id, 1); beep(1, 150, 880); try { navigator.vibrate && navigator.vibrate(150); } catch (e) {} }
    // turned by the map's own rotation, so the arrow points straight at the waypoint on screen
    wpb.hidden = false;
    wpb.innerHTML = `${arrowSvg(b + bear(), "#c62828")}<div><b>WP ${w.name}${w.pts ? " · " + w.pts + " pts" : ""}</b><span class="big">${Math.round(best.d)} m</span><small>rumbo ${String(Math.round(b) % 360).padStart(3, "0")}° ${card(b)}</small></div>`;
  }
  function startFollow() {
    const r = routes().find((x) => x.key === $("followSel").value);
    if (!r) { msg("Esta etapa no tiene ninguna ruta que seguir: dibuja una, haz una propuesta o importa un track.", true); return; }
    const thr = Math.max(10, parseInt($("followM").value, 10) || 50);
    audioOn();
    fol = { route: { name: r.name, segs: r.segs.filter((s) => s.length) }, thr, off: false, quiet: false, lastWarn: 0, ownRec: false, taken: new Set(), warned: null, prev: null, course: undefined, lastTaken: null };
    say(`Iniciando ruta. Te aviso si te desvías más de ${thr} metros`);
    follow = true; hold = false; zoomIn = true; startWatch();
    if (!rec && canEdit() && stage()) { fol.ownRec = true; startRec(false); }
    const all = fol.route.segs.flat(); if (!last && all.length > 1) map.fitBounds(all, { padding: [30, 30] });
    followUi(); if (last) checkRoute(last);
  }
  function stopFollow() {
    const own = fol && fol.ownRec; fol = null; folLayer.clearLayers(); showOff(0); wpb.hidden = true; followUi(); say("Ruta terminada");
    if (own && rec) stopRec();
  }
  $("followBtn").onclick = () => (fol ? stopFollow() : startFollow());
  followUi();

  // distance and course from where I am to any waypoint or spot tapped next
  function measureHere() {
    if (!last) { msg("Aún no tengo tu posición: espera a que salga el punto azul.", true); return; }
    const on = onMeasure(last.coords.latitude, last.coords.longitude);
    msg(on ? "Toca un waypoint o cualquier punto del mapa para ver la distancia desde tu posición." : "", true);
  }
  $("gpsMeasure").onclick = measureHere;
  $("recBtn").onclick = () => {
    audioOn();
    if (fol) { stopFollow(); if (rec) stopRec(); return; }
    if (rec) { say("Ruta terminada"); stopRec(); return; }
    // with a route for the stage: follow it (and record, for those who can edit); without one: just record
    const has = routes().some((r) => !r.name.startsWith("⏺") && r.segs.some((sg) => sg.length > 1)); // a recording is not the stage's route
    if (has) startFollow(); else if (canEdit()) startRec(false); else msg("Esta etapa no tiene ninguna ruta que seguir.", true);
  };
  // pause: no points are added and the time stops; going on starts a new stretch of the line
  function pauseRec() { if (!rec || rec.paused) return; rec.paused = Date.now(); idb.put("kv", rec, "rec").catch(() => {}); say("Grabación en pausa"); ui(); }
  function resumeRec() { if (!rec || !rec.paused) return; rec.pausedMs = (rec.pausedMs || 0) + Date.now() - rec.paused; rec.paused = null; rec.segs.push([]); idb.put("kv", rec, "rec").catch(() => {}); say("Sigo grabando"); ui(); }
  // discarding ends the recording too: nothing is kept and the screen may sleep again
  function dropRec() { rec = null; clearInterval(startRec.t); if (wake) { wake.release().catch(() => {}); wake = null; } idb.del("kv", "rec").catch(() => {}); recLayer.clearLayers(); say("Ruta terminada sin guardar"); msg("Grabación terminada y descartada.", true); ui(); }
  $("rcGo").onclick = () => { audioOn(); if (rec && rec.paused) resumeRec(); else if (!rec && !fol) $("recBtn").click(); };
  $("rcPause").onclick = pauseRec;
  $("rcStop").onclick = () => {
    if (!rec) { if (fol) stopFollow(); return; }
    const wasPaused = !!rec.paused; if (!wasPaused) pauseRec();
    $("saveInfo").textContent = `${kmOf(rec.segs).toFixed(2)} km · ${fmtTime(recSecs(rec))} · etapa ${rec.stage}`;
    $("saveWrap").hidden = false;
    const close = () => { $("saveWrap").hidden = true; $("svYes").onclick = $("svNo").onclick = $("svBack").onclick = null; };
    $("svYes").onclick = () => { close(); say("Ruta terminada"); if (fol) stopFollow(); if (rec) stopRec(); };
    $("svNo").onclick = () => { close(); if (fol) { const f = fol; f.ownRec = false; stopFollow(); } dropRec(); };
    $("svBack").onclick = () => { close(); if (!wasPaused) resumeRec(); };
  };
  $("recDrop").onclick = () => {
    const b = $("recDrop");
    if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "¿Descartar la grabación?"; return; }
    delete b.dataset.armed; b.textContent = "Descartar";
    rec = null; clearInterval(startRec.t); idb.del("kv", "rec").catch(() => {}); recLayer.clearLayers(); msg("Grabación descartada.", true); ui();
  };

  /* ---------- working without a connection: only the maps kept on this device, no data spent ---------- */
  const offOn = () => $("offMode").checked;
  const offBadge = document.createElement("div"); offBadge.className = "offbadge"; offBadge.hidden = true;
  offBadge.textContent = "📴 Sin conexión: solo los mapas guardados en este aparato"; map.getContainer().append(offBadge);
  let offLooked = false; // the map of the zone is looked for again with the first position
  async function applyOff(tell) {
    const on = offOn(); offLooked = !!last;
    try { localStorage.setItem("rally.off", on ? "1" : "0"); } catch (e) {}
    if (layers) layers.setOffline(on);
    offBadge.hidden = !on;
    if (!on) { if (tell) msg("Con conexión: el mapa vuelve a cargar de internet y las rutas guardadas en el móvil se suben.", true); sendPending(); return; }
    const at = last ? [last.coords.latitude, last.coords.longitude] : [map.getCenter().lat, map.getCenter().lng];
    const t = layers ? await layers.coverHere(at) : "";
    if (tell || /no tienes/.test(t)) msg(t, true);
  }
  $("offMode").checked = localStorage.getItem("rally.off") === "1";
  $("offMode").onchange = () => applyOff(true);

  // a recording interrupted by a reload carries on
  idb.get("kv", "rec").then((r) => { if (r && r.segs && !rec) { rec = r; startRec(true); msg("He recuperado la grabación que estaba en marcha. Sigue grabando.", true); } }).catch(() => {});
  applyOff(false);
  // on a phone or tablet my position shows as soon as the map opens
  if (CLOSE === 17) {
    const go = () => { if (watch === null) { follow = true; hold = false; zoomIn = true; startWatch(); } };
    try { navigator.permissions.query({ name: "geolocation" }).then((p) => { if (p.state !== "denied") go(); }, go); } catch (e) { go(); }
  }
  sendPending();
  ui();
  // the map is wanted somewhere else (a stage picked): stop following my position
  return {
    lookAway() { hold = true; if (follow) { follow = false; ui(); } },
    here: () => (last ? [last.coords.latitude, last.coords.longitude] : null),
    goTo(w) {
      audioOn(); goTo = w; say(`Te llevo al waypoint ${w.name}`);
      if (watch === null) { follow = true; hold = false; zoomIn = true; startWatch(); }
      else { follow = true; hold = false; if (last) { map.fitBounds([[last.coords.latitude, last.coords.longitude], [w.lat, w.lon]], { padding: [60, 60] }); checkNav(last); } ui(); }
    },
  };
}
