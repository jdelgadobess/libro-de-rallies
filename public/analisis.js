// Which reference routes (e.g. from Wikiloc) pass by the waypoints, in which order, and how far apart along the route.
// Points are [lat, lon]; waypoints are {id, name, lat, lon}. Distances in metres.

const M_LAT = 110540, M_LON = 111320;

// route with its segments flattened, projected to local metres and with distance along the route
export function prepare(route) {
  const lat0 = route.segs.flat().reduce((s, p) => s + p[0], 0) / Math.max(1, route.segs.flat().length);
  const k = Math.cos(lat0 * Math.PI / 180) * M_LON;
  const pts = [], cum = [];
  let along = 0, minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  route.segs.forEach((seg) => seg.forEach((p, i) => {
    const xy = [p[1] * k, p[0] * M_LAT];
    if (pts.length && i > 0) { const q = pts[pts.length - 1]; along += Math.hypot(xy[0] - q[0], xy[1] - q[1]); }
    pts.push(xy); cum.push(along);
    // a new segment starts a new run: mark the break so we never measure across the gap
    if (i === 0 && pts.length > 1) pts[pts.length - 1].brk = true;
    minLat = Math.min(minLat, p[0]); maxLat = Math.max(maxLat, p[0]); minLon = Math.min(minLon, p[1]); maxLon = Math.max(maxLon, p[1]);
  }));
  return { route, k, pts, cum, length: along, box: [minLat, minLon, maxLat, maxLon], raw: route.segs.flat() };
}

// closest point of the route to a waypoint: distance, and how far along the route it sits
function nearest(pr, w) {
  const x = w.lon * pr.k, y = w.lat * M_LAT;
  let best = { d: Infinity, along: 0, i: 0, t: 0 };
  for (let i = 1; i < pr.pts.length; i++) {
    if (pr.pts[i].brk) continue;
    const a = pr.pts[i - 1], b = pr.pts[i], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2)) : 0;
    const d = Math.hypot(a[0] + t * dx - x, a[1] + t * dy - y);
    if (d < best.d) best = { d, along: pr.cum[i - 1] + t * (pr.cum[i] - pr.cum[i - 1]), i, t };
  }
  if (pr.pts.length === 1) best = { d: Math.hypot(pr.pts[0][0] - x, pr.pts[0][1] - y), along: 0, i: 0, t: 0 };
  return best;
}

// longest run of values that keeps going up (or down), not necessarily contiguous
function longestMonotone(vals, up) {
  const tails = [];
  vals.forEach((v) => {
    const u = up ? v : -v; let lo = 0, hi = tails.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (tails[m] < u) lo = m + 1; else hi = m; }
    tails[lo] = u;
  });
  return tails.length;
}

// wps must already be in roadbook order
export function analyse(prepared, wps, radius) {
  if (!wps.length) return [];
  const pad = radius / M_LAT * 1.5;
  const wb = [Math.min(...wps.map((w) => w.lat)) - pad, Math.min(...wps.map((w) => w.lon)) - pad * 1.3,
    Math.max(...wps.map((w) => w.lat)) + pad, Math.max(...wps.map((w) => w.lon)) + pad * 1.3];
  return prepared.map((pr) => {
    const [a0, o0, a1, o1] = pr.box;
    if (a1 < wb[0] || a0 > wb[2] || o1 < wb[1] || o0 > wb[3]) return { pr, hits: wps.map(() => null), covered: 0, inOrder: 0, reverse: false, mean: null };
    const hits = wps.map((w) => { const n = nearest(pr, w); return n.d <= radius ? n : null; });
    const got = hits.filter(Boolean);
    const alongs = got.map((h) => h.along);
    const fwd = longestMonotone(alongs, true), back = longestMonotone(alongs, false);
    return {
      pr, hits, covered: got.length, inOrder: Math.max(fwd, back), reverse: back > fwd,
      mean: got.length ? got.reduce((s, h) => s + h.d, 0) / got.length : null,
    };
  }).sort((a, b) => b.covered - a.covered || b.inOrder - a.inOrder || (a.mean ?? 1e9) - (b.mean ?? 1e9));
}

// for each pair of consecutive waypoints, the routes that pass by both, shortest first
export function legs(results, wps) {
  const out = [];
  for (let i = 0; i + 1 < wps.length; i++) {
    const opts = [];
    results.forEach((r) => {
      const a = r.hits[i], b = r.hits[i + 1];
      if (a && b) opts.push({ r, from: a.along, to: b.along, km: Math.abs(b.along - a.along) / 1000 });
    });
    opts.sort((x, y) => x.km - y.km);
    out.push({ a: wps[i], b: wps[i + 1], opts });
  }
  return out;
}

// the piece of a route between two distances along it, as [lat, lon] points
export function cut(pr, from, to) {
  const [s, e] = from <= to ? [from, to] : [to, from];
  const back = (xy) => [Math.round(xy[1] / M_LAT * 1e6) / 1e6, Math.round(xy[0] / pr.k * 1e6) / 1e6];
  const at = (d) => {
    for (let i = 1; i < pr.pts.length; i++) if (pr.cum[i] >= d && !pr.pts[i].brk) {
      const a = pr.pts[i - 1], b = pr.pts[i], L = pr.cum[i] - pr.cum[i - 1], t = L ? (d - pr.cum[i - 1]) / L : 0;
      return back([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    }
    return back(pr.pts[pr.pts.length - 1]);
  };
  const out = [at(s)];
  for (let i = 0; i < pr.pts.length; i++) if (pr.cum[i] > s && pr.cum[i] < e) out.push(pr.raw[i]);
  out.push(at(e));
  return from <= to ? out : out.reverse();
}
