// Keeps the page, its libraries and the map tiles already seen, so the program opens without internet.
const APP = "libro-app-v100", LIBS = "libro-libs-v1", TILES = "libro-tiles-v1", ZONES = "libro-zonas", MAX_TILES = 20000; // about 500 MB of satellite seen before the trip
const SHELL = ["./", "index.html", "app.js", "mapas.js", "rutas.js", "mecanica.js", "coches.js", "gps.js", "style.css", "config.js", "manifest.webmanifest", "img/icono-192.png", "img/fondo.jpg"];
const LIB_HOSTS = ["cdn.jsdelivr.net", "unpkg.com", "fonts.googleapis.com", "fonts.gstatic.com"];
const TILE_HOSTS = /(^|\.)(arcgisonline\.com|tile\.openstreetmap\.org|tile\.opentopomap\.org|tiles\.maps\.eox\.at|www\.ign\.es)$/;

self.addEventListener("install", (e) => { self.skipWaiting(); e.waitUntil(caches.open(APP).then((c) => c.addAll(SHELL)).catch(() => {})); });
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (![APP, LIBS, TILES, ZONES].includes(k)) await caches.delete(k);
  await self.clients.claim();
})()));

async function networkFirst(req, name, trim) {
  const c = await caches.open(name);
  try {
    const res = await fetch(req);
    if (res.ok) { c.put(req, res.clone()); if (trim) trimSoon(c); }
    return res;
  } catch (e) {
    const hit = await c.match(req, { ignoreSearch: name === APP });
    if (hit) return hit;
    throw e;
  }
}
async function cacheFirst(req) {
  const c = await caches.open(LIBS), hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") c.put(req, res.clone());
  return res;
}
// «Trabajar sin conexión»: only the tiles already kept, without trying the network
async function cacheOnly(u) {
  const href = u.href.replace(/[?&]lr_off=1$/, ""); // as written, so the address matches the one kept
  const hit = (await (await caches.open(ZONES)).match(href)) || (await (await caches.open(TILES)).match(href));
  return hit || new Response("", { status: 504 });
}
// satellite downloaded for a zone first, then the tiles seen before / the network
async function zoneFirst(req) {
  const hit = await (await caches.open(ZONES)).match(req.url);
  return hit || networkFirst(req, TILES, true);
}
let trimming = false;
function trimSoon(c) {
  if (trimming) return; trimming = true;
  setTimeout(async () => {
    const keys = await c.keys();
    for (let i = 0; i < keys.length - MAX_TILES; i++) await c.delete(keys[i]);
    trimming = false;
  }, 5000);
}

self.addEventListener("fetch", (e) => {
  const req = e.request; if (req.method !== "GET") return;
  const u = new URL(req.url);
  if (u.origin === self.location.origin) e.respondWith(networkFirst(req, APP));
  else if (LIB_HOSTS.includes(u.hostname)) e.respondWith(cacheFirst(req));
  // tiles drawn by the map (images); the satellite download (a plain fetch) goes straight to the network
  else if (TILE_HOSTS.test(u.hostname) && req.destination === "image") e.respondWith(u.searchParams.has("lr_off") ? cacheOnly(u) : zoneFirst(req));
});
