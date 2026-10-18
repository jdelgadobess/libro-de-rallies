// Keeps the page, its libraries and the map tiles already seen, so the program opens without internet.
const APP = "libro-app-v35", LIBS = "libro-libs-v1", TILES = "libro-tiles-v1", MAX_TILES = 4000;
const SHELL = ["./", "index.html", "app.js", "mapas.js", "rutas.js", "mecanica.js", "coches.js", "gps.js", "style.css", "config.js", "manifest.webmanifest", "img/icono-192.png", "img/fondo.jpg"];
const LIB_HOSTS = ["cdn.jsdelivr.net", "unpkg.com", "fonts.googleapis.com", "fonts.gstatic.com"];
const TILE_HOSTS = /(^|\.)(arcgisonline\.com|tile\.openstreetmap\.org|tile\.opentopomap\.org)$/;

self.addEventListener("install", (e) => { self.skipWaiting(); e.waitUntil(caches.open(APP).then((c) => c.addAll(SHELL)).catch(() => {})); });
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (![APP, LIBS, TILES].includes(k)) await caches.delete(k);
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
  else if (TILE_HOSTS.test(u.hostname)) e.respondWith(networkFirst(req, TILES, true));
});
