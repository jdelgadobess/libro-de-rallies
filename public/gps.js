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

export function setupGps({ map, sb, canEdit, rallyId, stage, user, writeErr, onSaved }) {
  const layer = L.layerGroup().addTo(map), recLayer = L.layerGroup().addTo(map);
  let watch = null, follow = true, last = null, rec = null, wake = null, dot = null, ring = null, head = null, recLine = null, pendingTry = false;
  let keepUntil = 0; // an important message stays a few seconds before the accuracy readout replaces it
  const msg = (t, sticky) => { if (!sticky && Date.now() < keepUntil) return; $("gpsMsg").textContent = t || ""; if (sticky) keepUntil = Date.now() + 10000; };

  function ui() {
    $("gpsBtn").textContent = watch === null ? "📍 Mi posición (GPS)" : follow ? "📍 GPS activo · siguiendo" : "📍 GPS activo · centrar";
    $("gpsBtn").className = watch === null ? "ghost" : "hl";
    $("recBtn").textContent = rec ? "⏹ Parar y guardar" : "⏺ Grabar ruta";
    $("recBtn").className = rec ? "warn" : "ghost";
    $("recBtn").hidden = !canEdit();
    $("recDrop").hidden = !rec;
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
      dot = L.circleMarker(ll, { radius: 8, color: "#fff", weight: 3, fillColor: "#1a73e8", fillOpacity: 1 }).bindTooltip("Estás aquí").addTo(layer);
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
    last = p; draw(p);
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
  $("recBtn").onclick = () => { if (rec) stopRec(); else startRec(false); };
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
