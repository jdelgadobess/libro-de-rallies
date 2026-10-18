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
function beep(times, ms, hz) {
  if (!actx) return;
  for (let i = 0; i < times; i++) {
    const t = actx.currentTime + i * (ms + 120) / 1000, o = actx.createOscillator(), g = actx.createGain();
    o.type = "square"; o.frequency.value = hz; g.gain.setValueAtTime(0.25, t); g.gain.setValueAtTime(0, t + ms / 1000);
    o.connect(g).connect(actx.destination); o.start(t); o.stop(t + ms / 1000 + 0.02);
  }
}
const say = (t) => { try { if (!("speechSynthesis" in window)) return; speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(t); u.lang = "es-ES"; u.rate = 1; speechSynthesis.speak(u); } catch (e) {} };

export function setupGps({ map, sb, canEdit, rallyId, stage, user, writeErr, onSaved, onMeasure, onMove, routes, waypoints }) {
  const layer = L.layerGroup().addTo(map), recLayer = L.layerGroup().addTo(map);
  let watch = null, follow = true, last = null, rec = null, wake = null, dot = null, ring = null, head = null, recLine = null, pendingTry = false;
  let keepUntil = 0; // an important message stays a few seconds before the accuracy readout replaces it
  const msg = (t, sticky) => { if (!sticky && Date.now() < keepUntil) return; $("gpsMsg").textContent = t || ""; if (sticky) keepUntil = Date.now() + 10000; };

  function ui() {
    $("gpsBtn").textContent = watch === null ? "📍 Mi posición (GPS)" : follow ? "📍 GPS activo · siguiendo" : "📍 GPS activo · centrar";
    $("gpsBtn").className = watch === null ? "ghost" : "hl";
    $("recBtn").textContent = rec ? "⏹ Terminar ruta" : "⏺ Grabar ruta";
    $("recBtn").className = rec ? "warn" : "ghost";
    $("recBtn").hidden = !canEdit() || !!(fol && rec); // while following a route its own button ends it
    $("recDrop").hidden = !rec;
    $("gpsMeasure").hidden = watch === null;
    $("recStage").hidden = !canEdit(); $("recStage").disabled = !!rec;
    if (rec) $("recStage").value = rec.stage;
    if (rec) {
      const secs = ((rec.end || Date.now()) - rec.start) / 1000;
      $("recInfo").textContent = `Grabando · ${kmOf(rec.segs).toFixed(2)} km · ${fmtTime(secs)}`;
    } else $("recInfo").textContent = "";
  }

  function draw(p) {
    const ll = [p.coords.latitude, p.coords.longitude], acc = p.coords.accuracy || 0;
    if (!dot) {
      ring = L.circle(ll, { radius: acc, color: "#1a73e8", weight: 1, fillColor: "#1a73e8", fillOpacity: .12, interactive: false }).addTo(layer);
      dot = L.circleMarker(ll, { radius: 8, color: "#fff", weight: 3, fillColor: "#1a73e8", fillOpacity: 1 }).bindTooltip("Estás aquí · tócame para medir desde aquí").addTo(layer);
      dot.on("click", (e) => { L.DomEvent.stopPropagation(e); measureHere(); });
    } else { dot.setLatLng(ll); ring.setLatLng(ll).setRadius(acc); }
    const hd = p.coords.heading;
    if (hd !== null && hd !== undefined && !Number.isNaN(hd) && (p.coords.speed || 0) > 1) {
      const icon = L.divIcon({ className: "gps-head", iconSize: [34, 34], iconAnchor: [17, 17],
        html: `<svg viewBox="0 0 34 34" style="transform:rotate(${Math.round(hd)}deg)"><path d="M17 2 L23 14 L17 11 L11 14 Z" fill="#1a73e8" stroke="#fff" stroke-width="1.5"/></svg>` });
      if (!head) head = L.marker(ll, { icon, interactive: false, keyboard: false }).addTo(layer); else head.setLatLng(ll).setIcon(icon);
    } else if (head) { layer.removeLayer(head); head = null; }
    if (follow) map.setView(ll, Math.max(map.getZoom(), 14), { animate: true });
  }

  function onPos(p) {
    last = p; draw(p); onMove(p.coords.latitude, p.coords.longitude); checkRoute(p); checkNav(p);
    const speed = p.coords.speed ? ` · ${Math.round(p.coords.speed * 3.6)} km/h` : "";
    msg(`Precisión ±${Math.round(p.coords.accuracy)} m${speed}`);
    if (rec && p.coords.accuracy <= MAX_ACC) {
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
    msg("Buscando señal de GPS…"); ui(); return true;
  }
  function stopWatch() {
    if (watch !== null) navigator.geolocation.clearWatch(watch);
    watch = null; layer.clearLayers(); dot = ring = head = null; ui();
  }

  function drawRec() {
    recLayer.clearLayers();
    if (!rec) return;
    rec.segs.forEach((s) => { if (s.length > 1) { L.polyline(s, { color: "#000", weight: 7, opacity: .35, interactive: false }).addTo(recLayer); L.polyline(s, { color: "#e91e63", weight: 4, interactive: false }).addTo(recLayer); } });
  }

  // keeps the screen on while recording: with the screen off the phone stops giving the browser positions
  async function keepAwake() {
    try { if (rec && "wakeLock" in navigator && document.visibilityState === "visible") wake = await navigator.wakeLock.request("screen"); } catch (e) { wake = null; }
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") keepAwake(); });

  async function startRec(resumed) {
    if (!rallyId()) { msg("Elige primero el año en el paso 1.", true); return; }
    if (!resumed && !stage()) { msg("Este año no tiene etapas con waypoints: importa primero los waypoints de la etapa y graba sobre ella.", true); return; }
    if (!startWatch()) return;
    if (!resumed) rec = { start: Date.now(), segs: [], rally: rallyId(), stage: stage() };
    idb.put("kv", rec, "rec").catch(() => {});
    follow = true; keepAwake(); drawRec(); ui();
    clearInterval(startRec.t); startRec.t = setInterval(ui, 1000);
  }

  async function upload(r) {
    const segs = r.segs.filter((s) => s.length > 1);
    const d = new Date(r.start);
    const name = `Grabada ${d.toLocaleDateString("es", { day: "2-digit", month: "2-digit" })} ${d.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })}`;
    const row = { rally_id: r.rally, stage: r.stage || "", name, points: segs, kind: "grabada", meta: { start: new Date(r.start).toISOString(), end: new Date(r.end).toISOString(), secs: Math.round((r.end - r.start) / 1000), km: Math.round(kmOf(segs) * 100) / 100 }, created_by: user().email };
    const { error } = await sb.from("tracks").insert(row);
    if (error) throw error;
    return row;
  }
  async function stopRec() {
    rec.end = Date.now();
    const r = rec; rec = null; clearInterval(startRec.t);
    if (wake) { wake.release().catch(() => {}); wake = null; }
    idb.del("kv", "rec").catch(() => {});
    recLayer.clearLayers(); ui();
    if (!r.segs.some((s) => s.length > 1)) { msg("La grabación no tenía recorrido: no se ha guardado.", true); return; }
    try { const row = await upload(r); msg(`Ruta guardada en la etapa ${r.stage} («Rutas grabadas»): ${row.meta.km.toFixed(2)} km en ${fmtTime(row.meta.secs)}.`, true); onSaved(); }
    catch (e) {
      // no connection: kept on the phone and sent as soon as there is internet
      let pend = []; try { pend = (await idb.get("kv", "recPending")) || []; } catch (er) {}
      pend.push(r); idb.put("kv", pend, "recPending").catch(() => {});
      msg(navigator.onLine ? "No se pudo guardar: " + writeErr(e) + " Queda en el móvil y lo intento de nuevo luego." : "Sin conexión: la ruta queda guardada en el móvil y se subirá cuando haya internet.", true);
    }
  }
  async function sendPending() {
    if (pendingTry || !navigator.onLine) return; pendingTry = true;
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
    if (watch === null) { follow = true; startWatch(); }
    else if (!follow) { follow = true; if (last) draw(last); ui(); }
    else if (!rec) stopWatch();
    else { follow = false; ui(); }
  };
  map.on("dragstart", () => { if (watch !== null && follow) { follow = false; ui(); } });
  /* ---------- following a route: a warning when I leave it by more than the metres chosen ---------- */
  let fol = null; // { route, thr, off, quiet, lastWarn, ownRec }
  const folLayer = L.layerGroup().addTo(map);
  const banner = document.createElement("div"); banner.className = "offroute"; banner.hidden = true;
  banner.innerHTML = '<span id="offTxt"></span><button type="button" id="offOk">OK, no pasa nada</button>';
  L.DomEvent.disableClickPropagation(banner); map.getContainer().append(banner);
  banner.querySelector("#offOk").onclick = () => { if (fol) { fol.quiet = true; showOff(fol.lastD); say("De acuerdo"); } };
  function showOff(d) {
    banner.hidden = !fol || !fol.off;
    banner.classList.toggle("quiet", !!(fol && fol.quiet));
    banner.querySelector("#offTxt").textContent = fol && fol.quiet ? `Fuera de la ruta: ${Math.round(d)} m (sin avisos hasta que vuelvas)` : `⚠ Te estás desviando: ${Math.round(d)} m de la ruta`;
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
      if (!fol.off) { fol.off = true; fol.quiet = false; fol.lastWarn = 0; }
      if (!fol.quiet && Date.now() - fol.lastWarn > 45000) {
        fol.lastWarn = Date.now(); say(`Te estás desviando. ${Math.round(n.d)} metros de la ruta`);
        try { navigator.vibrate && navigator.vibrate([300, 150, 300]); } catch (e) {}
      }
      showOff(n.d);
    } else if (fol.off && n.d <= fol.thr * 0.7) {
      fol.off = false; fol.quiet = false; showOff(0); say("De nuevo en la ruta");
    } else if (fol.off) showOff(n.d);
  }
  /* ---------- while following: the course in a box, and each waypoint announced at 50 m and taken at 5 m ---------- */
  const NEAR = 50, TAKEN = 5;
  const hdg = document.createElement("div"); hdg.className = "navbox hdg"; hdg.hidden = true;
  const wpb = document.createElement("div"); wpb.className = "navbox wpnav"; wpb.hidden = true;
  [hdg, wpb].forEach((d) => { L.DomEvent.disableClickPropagation(d); map.getContainer().append(d); });
  const arrowSvg = (deg, color) => `<svg viewBox="0 0 40 40" style="transform:rotate(${Math.round(deg)}deg)"><path d="M20 3 L31 33 L20 26 L9 33 Z" fill="${color}" stroke="#fff" stroke-width="2"/></svg>`;
  function checkNav(p) {
    if (!fol || p.coords.accuracy > MAX_ACC) return;
    const here = [p.coords.latitude, p.coords.longitude], spd = p.coords.speed || 0;
    // course: the GPS's own when moving, else from the last few metres driven
    if (!fol.prev) fol.prev = here;
    else if (meters(fol.prev, here) >= 5) { fol.course = brg(fol.prev, here); fol.prev = here; }
    const hd = p.coords.heading;
    if (hd !== null && hd !== undefined && !Number.isNaN(hd) && spd > 1) fol.course = hd;
    hdg.hidden = false;
    hdg.innerHTML = fol.course === undefined ? `<b>Rumbo</b><span class="big">—</span><small>muévete unos metros</small>`
      : `<b>Rumbo</b>${arrowSvg(fol.course, "#1a73e8")}<span class="big">${String(Math.round(fol.course) % 360).padStart(3, "0")}°</span><small>${card(fol.course)}${spd ? " · " + Math.round(spd * 3.6) + " km/h" : ""}</small>`;
    // the nearest waypoint of the stage not taken yet
    let best = null;
    for (const w of waypoints()) {
      if (fol.taken.has(w.id)) continue;
      const d = meters(here, [w.lat, w.lon]);
      if (!best || d < best.d) best = { w, d };
    }
    if (!best || best.d > NEAR) { wpb.hidden = !fol.lastTaken || Date.now() - fol.lastTaken.at > 8000; if (!wpb.hidden) wpb.innerHTML = `<span class="ok">✓ WP ${fol.lastTaken.name} cogido</span>`; return; }
    const w = best.w, b = brg(here, [w.lat, w.lon]);
    if (best.d <= TAKEN) {
      fol.taken.add(w.id); fol.lastTaken = { name: w.name, at: Date.now() };
      beep(1, 900, 1320); try { navigator.vibrate && navigator.vibrate(600); } catch (e) {}
      wpb.hidden = false; wpb.innerHTML = `<span class="ok">✓ WP ${w.name} cogido${w.pts ? " · " + w.pts + " pts" : ""}</span>`;
      return;
    }
    if (fol.warned !== w.id) { fol.warned = w.id; beep(3, 140, 880); try { navigator.vibrate && navigator.vibrate([150, 80, 150]); } catch (e) {} }
    // the map is north up, so the arrow points straight at the waypoint on screen
    wpb.hidden = false;
    wpb.innerHTML = `${arrowSvg(b, "#c62828")}<div><b>WP ${w.name}${w.pts ? " · " + w.pts + " pts" : ""}</b><span class="big">${Math.round(best.d)} m</span><small>rumbo ${String(Math.round(b) % 360).padStart(3, "0")}° ${card(b)}</small></div>`;
  }
  function startFollow() {
    const r = routes().find((x) => x.key === $("followSel").value);
    if (!r) { msg("Esta etapa no tiene ninguna ruta que seguir: dibuja una, haz una propuesta o importa un track.", true); return; }
    const thr = Math.max(10, parseInt($("followM").value, 10) || 50);
    audioOn();
    fol = { route: { name: r.name, segs: r.segs.filter((s) => s.length) }, thr, off: false, quiet: false, lastWarn: 0, ownRec: false, taken: new Set(), warned: null, prev: null, course: undefined, lastTaken: null };
    say(`Iniciando ruta. Te aviso si te desvías más de ${thr} metros`);
    follow = true; startWatch();
    if (!rec && canEdit() && stage()) { fol.ownRec = true; startRec(false); }
    const all = fol.route.segs.flat(); if (all.length > 1) map.fitBounds(all, { padding: [30, 30] });
    followUi(); if (last) checkRoute(last);
  }
  function stopFollow() {
    const own = fol && fol.ownRec; fol = null; folLayer.clearLayers(); showOff(0); hdg.hidden = wpb.hidden = true; followUi(); say("Ruta terminada");
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
  $("recBtn").onclick = () => { if (rec) { say("Ruta terminada"); stopRec(); } else startRec(false); };
  $("recDrop").onclick = () => {
    const b = $("recDrop");
    if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "¿Descartar la grabación?"; return; }
    delete b.dataset.armed; b.textContent = "Descartar";
    rec = null; clearInterval(startRec.t); idb.del("kv", "rec").catch(() => {}); recLayer.clearLayers(); msg("Grabación descartada.", true); ui();
  };

  // a recording interrupted by a reload carries on
  idb.get("kv", "rec").then((r) => { if (r && r.segs && !rec) { rec = r; startRec(true); msg("He recuperado la grabación que estaba en marcha. Sigue grabando.", true); } }).catch(() => {});
  sendPending();
  ui();
}
