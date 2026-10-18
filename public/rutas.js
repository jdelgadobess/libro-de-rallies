// Route planner: builds a road graph from the off-road map (OpenStreetMap roads and tracks in the .pmtiles file),
// measures the driving distance between waypoints and proposes routes through a share of them.
// Points are [lat, lon]; waypoints are {id, name, lat, lon, pts}.

const R = 6371008.8, rad = Math.PI / 180;
export const meters = (a, b) => {
  const h = Math.sin((b[0] - a[0]) * rad / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin((b[1] - a[1]) * rad / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const tile2lat = (y, z) => { const n = Math.PI - 2 * Math.PI * y / 2 ** z; return Math.atan(Math.sinh(n)) / rad; };
const lat2tile = (lat, z) => (1 - Math.asinh(Math.tan(lat * rad)) / Math.PI) / 2 * 2 ** z;
const lon2tile = (lon, z) => (lon + 180) / 360 * 2 ** z;

// cost per metre of each kind of way; null = not used
function costOf(p, paths) {
  const k = p.kind, d = p.kind_detail;
  if (["steps", "pier", "runway", "taxiway", "platform", "corridor", "elevator"].includes(d)) return null;
  if (k === "highway" || k === "major_road") return 1;
  if (k === "minor_road") return 1.02;
  if (d === "track") return 1.1;
  if (k === "path") return paths ? 1.4 : null;
  if (k === "other") return 1.1;
  return null;
}

// clip a polyline to the square [0, S]² so pieces from neighbouring tiles meet at the tile edge
function clip(line, S) {
  const out = []; let cur = null;
  const inside = (p) => p.x >= 0 && p.x <= S && p.y >= 0 && p.y <= S;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i];
    let t0 = 0, t1 = 1; const dx = b.x - a.x, dy = b.y - a.y; let ok = true;
    for (const [p, q] of [[-dx, a.x], [dx, S - a.x], [-dy, a.y], [dy, S - a.y]]) {
      if (p === 0) { if (q < 0) { ok = false; break; } continue; }
      const r = q / p;
      if (p < 0) { if (r > t1) { ok = false; break; } if (r > t0) t0 = r; } else { if (r < t0) { ok = false; break; } if (r < t1) t1 = r; }
    }
    if (!ok) { cur = null; continue; }
    const p0 = { x: a.x + t0 * dx, y: a.y + t0 * dy }, p1 = { x: a.x + t1 * dx, y: a.y + t1 * dy };
    if (!cur || t0 > 0 || !inside(a)) { cur = [p0]; out.push(cur); }
    cur.push(p1);
    if (t1 < 1) cur = null;
  }
  return out.filter((l) => l.length > 1);
}

// graph of the ways inside bbox [s, w, n, e]
export async function buildGraph(pm, bbox, { paths = false, progress = () => {} } = {}) {
  const P = window.protomapsL, src = new P.PmtilesSource(pm, false), S = 4096;
  const [s, w, n, e] = bbox;
  let z = 14, tx0, tx1, ty0, ty1;
  for (; z >= 11; z--) {
    tx0 = Math.floor(lon2tile(w, z)); tx1 = Math.floor(lon2tile(e, z)); ty0 = Math.floor(lat2tile(n, z)); ty1 = Math.floor(lat2tile(s, z));
    if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= 1600) break;
  }
  const lat = [], lon = [], ids = new Map(), edges = [];
  const node = (la, lo) => {
    const k = Math.round(la * 2e5) + ":" + Math.round(lo * 2e5); // ~0.5 m grid
    let id = ids.get(k); if (id === undefined) { id = lat.length; ids.set(k, id); lat.push(la); lon.push(lo); }
    return id;
  };
  const total = (tx1 - tx0 + 1) * (ty1 - ty0 + 1); let done = 0;
  for (let x = tx0; x <= tx1; x++) for (let y = ty0; y <= ty1; y++) {
    let feats = [];
    try { feats = (await src.get({ z, x, y }, S)).get("roads") || []; } catch (er) {}
    for (const f of feats) {
      if (f.geomType !== 2) continue;
      const c = costOf(f.props, paths); if (c === null) continue;
      for (const l of f.geom) for (const piece of clip(l, S)) {
        let prev = null;
        for (const p of piece) {
          const id = node(tile2lat(y + p.y / S, z), (x + p.x / S) / 2 ** z * 360 - 180);
          if (prev !== null && prev !== id) edges.push(prev, id, c);
          prev = id;
        }
      }
    }
    if (++done % 40 === 0) { progress(done / total); await new Promise((r) => setTimeout(r, 0)); }
  }
  const N = lat.length;
  // dead ends within 15 m of another way are joined (tile seams and small gaps in the map)
  const deg = new Uint32Array(N);
  for (let i = 0; i < edges.length; i += 3) { deg[edges[i]]++; deg[edges[i + 1]]++; }
  const grid = new Map(), cell = 0.0003;
  const gk = (a, b) => Math.floor(a / cell) + ":" + Math.floor(b / cell);
  for (let i = 0; i < N; i++) { const k = gk(lat[i], lon[i]); (grid.get(k) || grid.set(k, []).get(k)).push(i); }
  for (let i = 0; i < N; i++) {
    if (deg[i] !== 1) continue;
    const ci = Math.floor(lat[i] / cell), cj = Math.floor(lon[i] / cell); let best = -1, bd = 15;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const j of grid.get((ci + a) + ":" + (cj + b)) || []) {
      if (j === i) continue;
      const d = meters([lat[i], lon[i]], [lat[j], lon[j]]);
      if (d < bd && d > 0.01) { bd = d; best = j; }
    }
    if (best >= 0) edges.push(i, best, 1.2);
  }
  // adjacency in compact arrays
  const off = new Uint32Array(N + 1);
  for (let i = 0; i < edges.length; i += 3) { off[edges[i] + 1]++; off[edges[i + 1] + 1]++; }
  for (let i = 0; i < N; i++) off[i + 1] += off[i];
  const to = new Uint32Array(off[N]), wt = new Float32Array(off[N]), len = new Float32Array(off[N]), fill = off.slice(0, N);
  for (let i = 0; i < edges.length; i += 3) {
    const a = edges[i], b = edges[i + 1], m = meters([lat[a], lon[a]], [lat[b], lon[b]]);
    to[fill[a]] = b; len[fill[a]] = m; wt[fill[a]++] = m * edges[i + 2];
    to[fill[b]] = a; len[fill[b]] = m; wt[fill[b]++] = m * edges[i + 2];
  }
  progress(1);
  return { N, lat: Float64Array.from(lat), lon: Float64Array.from(lon), off, to, wt, len, grid, cell, zoom: z };
}

// nearest node of the graph to a point (searching up to ~3 km)
export function snap(g, p) {
  const ci = Math.floor(p[0] / g.cell), cj = Math.floor(p[1] / g.cell);
  let best = -1, bd = Infinity;
  for (let r = 0; r <= 100; r++) {
    for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) {
      if (Math.max(Math.abs(a), Math.abs(b)) !== r) continue;
      for (const j of g.grid.get((ci + a) + ":" + (cj + b)) || []) {
        const d = meters(p, [g.lat[j], g.lon[j]]); if (d < bd) { bd = d; best = j; }
      }
    }
    if (best >= 0 && bd < (r - 1) * g.cell * 90000) break; // nothing closer can be in further rings
  }
  return { node: best, d: bd };
}

class Heap {
  constructor() { this.k = []; this.v = []; }
  push(key, val) {
    const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v, top = v[0], lk = k.pop(), lv = v.pop(), n = k.length;
    if (n) {
      let i = 0;
      for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && k[c + 1] < k[c]) c++; if (k[c] >= lk) break; k[i] = k[c]; v[i] = v[c]; i = c; }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
  get size() { return this.k.length; }
}
// shortest paths from one node until every target is settled
export function dijkstra(g, from, targets, avoid = null) {
  const dist = new Float64Array(g.N).fill(Infinity), prev = new Int32Array(g.N).fill(-1), done = new Uint8Array(g.N);
  const left = new Set(targets); dist[from] = 0; const h = new Heap(); h.push(0, from);
  while (h.size && left.size) {
    const u = h.pop(); if (done[u]) continue; done[u] = 1; left.delete(u);
    for (let e = g.off[u]; e < g.off[u + 1]; e++) {
      const v = g.to[e], nd = dist[u] + (avoid && avoid[e] ? g.wt[e] * 1.8 : g.wt[e]);
      if (nd < dist[v]) { dist[v] = nd; prev[v] = u; h.push(nd, v); }
    }
  }
  return { dist, prev };
}

/* ---------- choosing and ordering the waypoints ---------- */
const OFF = 2.5; // a metre off the map's ways counts like 2.5 metres of track (reaching a waypoint from the nearest way)
// crossing open country between two waypoints is a last resort: only when the ways are more than this many times longer
const NOWAY = 12;

// cost matrix between waypoints, with the snapped nodes
export async function matrix(g, wps, progress = () => {}) {
  const sn = wps.map((w) => snap(g, [w.lat, w.lon]));
  const n = wps.length, D = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    const targets = sn.map((s) => s.node).filter((x) => x >= 0);
    const { dist } = sn[i].node >= 0 ? dijkstra(g, sn[i].node, targets) : { dist: null };
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const straight = meters([wps[i].lat, wps[i].lon], [wps[j].lat, wps[j].lon]) * NOWAY;
      const road = dist && sn[j].node >= 0 ? sn[i].d * OFF + dist[sn[j].node] + sn[j].d * OFF : Infinity;
      D[i][j] = Math.min(road, straight);
    }
    progress((i + 1) / n);
    if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0));
  }
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) D[i][j] = D[j][i] = Math.min(D[i][j], D[j][i]);
  return { D, sn };
}

const tourCost = (D, seq) => { let c = 0; for (let i = 1; i < seq.length; i++) c += D[seq[i - 1]][seq[i]]; return c; };
// best order for an open path with fixed first and last
// 2-opt and or-opt until nothing improves
function improve(D, out) {
  for (let improved = true, guard = 0; improved && guard < 200; guard++) {
    improved = false;
    for (let i = 1; i < out.length - 2; i++) for (let j = i + 1; j < out.length - 1; j++) {
      const d = D[out[i - 1]][out[j]] + D[out[i]][out[j + 1]] - D[out[i - 1]][out[i]] - D[out[j]][out[j + 1]];
      if (d < -1e-6) { out.splice(i, j - i + 1, ...out.slice(i, j + 1).reverse()); improved = true; }
    }
    for (let i = 1; i < out.length - 1; i++) {
      const v = out[i], rem = D[out[i - 1]][v] + D[v][out[i + 1]] - D[out[i - 1]][out[i + 1]];
      let bj = -1, bd = rem - 1e-6;
      for (let j = 0; j < out.length - 1; j++) {
        if (j === i || j === i - 1) continue;
        const ins = D[out[j]][v] + D[v][out[j + 1]] - D[out[j]][out[j + 1]];
        if (ins < bd) { bd = ins; bj = j; }
      }
      if (bj >= 0) { out.splice(i, 1); out.splice(bj < i ? bj + 1 : bj, 0, v); improved = true; }
    }
  }
  return out;
}
// best order found from the current one and from a nearest-neighbour start
function optimise(D, seq) {
  const first = seq[0], last = seq[seq.length - 1], rest = new Set(seq.slice(1, -1)), nn = [first];
  while (rest.size) { const u = nn[nn.length - 1]; let b = null; for (const v of rest) if (b === null || D[u][v] < D[u][b]) b = v; nn.push(b); rest.delete(b); }
  nn.push(last);
  const a = improve(D, nn), b = improve(D, seq.slice());
  return tourCost(D, a) <= tourCost(D, b) ? a : b;
}
// drop waypoints until `keep` remain: each time the one whose detour (divided by its value) is largest
function prune(D, seq, keep, value, reorder) {
  seq = seq.slice();
  while (seq.length > keep) {
    let bi = -1, bs = -Infinity;
    for (let i = 1; i < seq.length - 1; i++) {
      const save = D[seq[i - 1]][seq[i]] + D[seq[i]][seq[i + 1]] - D[seq[i - 1]][seq[i + 1]];
      const s = save / value(seq[i]);
      if (s > bs) { bs = s; bi = i; }
    }
    if (bi < 0) break;
    seq.splice(bi, 1);
    if (reorder) seq = optimise(D, seq);
  }
  return seq;
}

// cheapest place to slot waypoint v into seq (only between roadbook neighbours when `ordered`)
function bestInsert(D, seq, v, ordered) {
  let bj = -1, bd = Infinity;
  for (let j = 0; j < seq.length - 1; j++) {
    if (ordered && !(seq[j] < v && v < seq[j + 1])) continue;
    const d = D[seq[j]][v] + D[v][seq[j + 1]] - D[seq[j]][seq[j + 1]];
    if (d < bd) { bd = d; bj = j; }
  }
  return { at: bj + 1, cost: bd };
}
// swap a chosen waypoint for a left-out one whenever that makes the route shorter (same number of waypoints)
function swaps(D, seq, n, ordered) {
  for (let pass = 0, better = true; better && pass < 20; pass++) {
    better = false;
    const inSeq = new Set(seq);
    for (let v = 0; v < n; v++) {
      if (inSeq.has(v)) continue;
      for (let i = 1; i < seq.length - 1; i++) {
        const u = seq[i], save = D[seq[i - 1]][u] + D[u][seq[i + 1]] - D[seq[i - 1]][seq[i + 1]];
        const without = seq.slice(0, i).concat(seq.slice(i + 1)), ins = bestInsert(D, without, v, ordered);
        if (ins.at > 0 && ins.cost < save - 1) {
          without.splice(ins.at, 0, v); seq = without; inSeq.delete(u); inSeq.add(v); better = true; break;
        }
      }
    }
  }
  return seq;
}
// waypoints left out that lie within `r` metres of the drawn route (to add them and draw again)
export function nearRoute(pts, wps, seq, r = 300) {
  const inSeq = new Set(seq), out = [];
  wps.forEach((w, v) => {
    if (inSeq.has(v)) return;
    const k = Math.cos(w.lat * rad) * 111320, M = 110540;
    for (let i = 1; i < pts.length; i++) {
      const ax = (pts[i - 1][1] - w.lon) * k, ay = (pts[i - 1][0] - w.lat) * M, bx = (pts[i][1] - w.lon) * k, by = (pts[i][0] - w.lat) * M;
      const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy, t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
      if (Math.hypot(ax + t * dx, ay + t * dy) <= r) { out.push(v); return; }
    }
  });
  return out;
}
// slot extra waypoints into a route at their cheapest place
export function addTo(D, seq, extra, ordered = false) {
  seq = seq.slice();
  for (const v of extra) { const ins = bestInsert(D, seq, v, ordered); if (ins.at > 0) seq.splice(ins.at, 0, v); }
  return ordered ? seq : optimise(D, seq);
}
// waypoints the route passes close to are taken too, even beyond the share asked for
// `limit`: extra cost (≈ metres of track) a waypoint may add and still be "on the way"
function pickup(D, seq, n, ordered, limit) {
  for (;;) {
    const inSeq = new Set(seq); let bv = -1, best = { cost: limit };
    for (let v = 0; v < n; v++) {
      if (inSeq.has(v)) continue;
      const ins = bestInsert(D, seq, v, ordered);
      if (ins.at > 0 && ins.cost <= best.cost) { best = ins; bv = v; }
    }
    if (bv < 0) return seq;
    seq = seq.slice(); seq.splice(best.at, 0, bv);
  }
}
const polish = (D, seq, n, ordered, limit) => {
  seq = swaps(D, seq, n, ordered); if (!ordered) seq = optimise(D, seq);
  seq = pickup(D, seq, n, ordered, limit); return ordered ? seq : optimise(D, seq);
};

// several proposals through `share` of the waypoints (first and last always in)
// `detour`: metres a waypoint may be off the route and still be picked up on the way
export function proposals(D, wps, share, detour = 1000) {
  const limit = detour * 2;
  const n = wps.length, keep = Math.max(2, Math.min(n, Math.round(n * share)));
  const all = wps.map((_, i) => i), one = () => 1, byPts = (i) => Math.max(5, wps[i].pts || 0);
  const out = [
    { key: "corta", name: "La más corta", seq: polish(D, optimise(D, prune(D, optimise(D, all), keep, one, true)), n, false, limit) },
    { key: "roadbook", name: "En el orden del roadbook", seq: polish(D, prune(D, all, keep, one, false), n, true, limit) },
  ];
  if (wps.some((w) => w.pts)) out.push({ key: "puntos", name: "Más puntos por km", seq: pickup(D, optimise(D, prune(D, optimise(D, all), keep, byPts, true)), n, false, limit) });
  const seen = new Set();
  return out.filter((p) => { const k = p.seq.join(","); if (seen.has(k)) return false; seen.add(k); return true; })
    .map((p) => ({ ...p, cost: tourCost(D, p.seq) }));
}

// the drawn route of a proposal: along the ways, straight where the map has none.
// `avoid` (one flag per edge) makes the ways of another route cost more, to find a different one
export function geometry(g, wps, sn, seq, avoid = null) {
  const used = new Uint8Array(g.to.length);
  const mark = (u, v) => {
    for (let e = g.off[u]; e < g.off[u + 1]; e++) if (g.to[e] === v) used[e] = 1;
    for (let e = g.off[v]; e < g.off[v + 1]; e++) if (g.to[e] === u) used[e] = 1;
  };
  const pts = [], add = (p) => { const q = pts[pts.length - 1]; if (!q || q[0] !== p[0] || q[1] !== p[1]) pts.push(p); };
  let road = 0, off = 0; const gaps = [];
  for (let k = 1; k < seq.length; k++) {
    const a = seq[k - 1], b = seq[k], A = [wps[a].lat, wps[a].lon], B = [wps[b].lat, wps[b].lon];
    const sa = sn[a], sb = sn[b];
    const straight = meters(A, B);
    let path = null;
    if (sa.node >= 0 && sb.node >= 0) {
      const { dist, prev } = dijkstra(g, sa.node, [sb.node], avoid);
      if (dist[sb.node] < Infinity && sa.d * OFF + dist[sb.node] + sb.d * OFF <= straight * NOWAY * (avoid ? 1.8 : 1)) {
        path = []; for (let u = sb.node; u !== -1; u = prev[u]) path.push(u); path.reverse();
        for (let i = 1; i < path.length; i++) mark(path[i - 1], path[i]);
      }
    }
    add(A);
    if (path) {
      off += sa.d + sb.d;
      for (let i = 0; i < path.length; i++) { const p = [Math.round(g.lat[path[i]] * 1e6) / 1e6, Math.round(g.lon[path[i]] * 1e6) / 1e6]; if (i) road += meters(pts[pts.length - 1], p); add(p); }
    } else { off += straight; gaps.push({ A, B, a, b }); }
    add(B);
  }
  return { pts, km: (road + off) / 1000, offKm: off / 1000, gapKm: gaps.reduce((t, x) => t + meters(x.A, x.B), 0) / 1000, gaps, used };
}

/* ---------- satellite image between two points, for looking for a track the map lacks ---------- */
const SAT = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/";
const tileImg = (z, x, y) => new Promise((ok) => {
  const im = new Image(); im.crossOrigin = "anonymous";
  im.onload = () => ok(im); im.onerror = () => ok(null);
  im.src = `${SAT}${z}/${y}/${x}`;
});
// JPEG of the area around A–B, with A (green) and B (red) marked, and a function from image pixels back to [lat, lon]
export async function satImage(A, B, maxPx = 1400) {
  const len = meters(A, B), m = Math.max(300, len * 0.25);
  const dLat = m / 111320, dLon = m / (111320 * Math.cos(A[0] * rad));
  const n = Math.max(A[0], B[0]) + dLat, s = Math.min(A[0], B[0]) - dLat, w = Math.min(A[1], B[1]) - dLon, e = Math.max(A[1], B[1]) + dLon;
  let z = 17, x0, y0, x1, y1;
  for (; z > 12; z--) {
    x0 = lon2tile(w, z) * 256; x1 = lon2tile(e, z) * 256; y0 = lat2tile(n, z) * 256; y1 = lat2tile(s, z) * 256;
    if (Math.max(x1 - x0, y1 - y0) <= maxPx) break;
  }
  const W = Math.round(x1 - x0), H = Math.round(y1 - y0);
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const ctx = c.getContext("2d"); ctx.fillStyle = "#777"; ctx.fillRect(0, 0, W, H);
  const jobs = [];
  for (let tx = Math.floor(x0 / 256); tx <= Math.floor(x1 / 256); tx++) for (let ty = Math.floor(y0 / 256); ty <= Math.floor(y1 / 256); ty++)
    jobs.push(tileImg(z, tx, ty).then((im) => { if (im) ctx.drawImage(im, tx * 256 - x0, ty * 256 - y0); }));
  await Promise.all(jobs);
  const px = (p) => [lon2tile(p[1], z) * 256 - x0, lat2tile(p[0], z) * 256 - y0];
  const a = px(A), b = px(B);
  [[a, "#00c853"], [b, "#ff1744"]].forEach(([p, col]) => { ctx.beginPath(); ctx.arc(p[0], p[1], 9, 0, 7); ctx.lineWidth = 3; ctx.strokeStyle = col; ctx.stroke(); });
  let url;
  try { url = c.toDataURL("image/jpeg", 0.85); } catch (er) { throw new Error("El navegador no deja leer la imagen de satélite."); }
  const toLL = (x, y) => {
    const X = (x + x0) / 256, Y = (y + y0) / 256, N = Math.PI - 2 * Math.PI * Y / 2 ** z;
    return [Math.round(Math.atan(Math.sinh(N)) / rad * 1e6) / 1e6, Math.round((X / 2 ** z * 360 - 180) * 1e6) / 1e6];
  };
  return { image: { mediaType: "image/jpeg", data: url.slice(url.indexOf(",") + 1) }, width: W, height: H, a, b, mpp: 156543.03 * Math.cos(A[0] * rad) / 2 ** z, toLL };
}
