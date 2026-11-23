// 2D geometry: oriented boxes (footprints depend on size AND yaw), polylines, spatial hash.

export function obbFrom(cx, cz, yaw, hx, hz) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return { cx, cz, ax: [c, s], az: [-s, c], hx, hz };
}

export function obbCorners(o) {
  const { cx, cz, ax, az, hx, hz } = o;
  return [
    [cx + ax[0] * hx + az[0] * hz, cz + ax[1] * hx + az[1] * hz],
    [cx + ax[0] * hx - az[0] * hz, cz + ax[1] * hx - az[1] * hz],
    [cx - ax[0] * hx - az[0] * hz, cz - ax[1] * hx - az[1] * hz],
    [cx - ax[0] * hx + az[0] * hz, cz - ax[1] * hx + az[1] * hz],
  ];
}

function projRadius(o, d) {
  return o.hx * Math.abs(o.ax[0] * d[0] + o.ax[1] * d[1]) +
         o.hz * Math.abs(o.az[0] * d[0] + o.az[1] * d[1]);
}

export function obbOverlap(a, b) {
  const d = [b.cx - a.cx, b.cz - a.cz];
  for (const ax of [a.ax, a.az, b.ax, b.az]) {
    const dist = Math.abs(d[0] * ax[0] + d[1] * ax[1]);
    if (dist > projRadius(a, ax) + projRadius(b, ax) + 1e-9) return false;
  }
  return true;
}

export function pointInObb(px, pz, o) {
  const dx = px - o.cx, dz = pz - o.cz;
  const lx = dx * o.ax[0] + dz * o.ax[1];
  const lz = dx * o.az[0] + dz * o.az[1];
  return Math.abs(lx) <= o.hx + 1e-9 && Math.abs(lz) <= o.hz + 1e-9;
}

export function segPointDist(px, pz, ax, az, bx, bz) {
  const abx = bx - ax, abz = bz - az;
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (pz - az) * abz) / (abx * abx + abz * abz || 1e-12)));
  const dx = px - (ax + t * abx), dz = pz - (az + t * abz);
  return Math.hypot(dx, dz);
}

export function distPointObb(px, pz, o) {
  if (pointInObb(px, pz, o)) return 0;
  const cs = obbCorners(o);
  let m = Infinity;
  for (let i = 0; i < 4; i++) {
    const a = cs[i], b = cs[(i + 1) % 4];
    m = Math.min(m, segPointDist(px, pz, a[0], a[1], b[0], b[1]));
  }
  return m;
}

// Min edge-to-edge distance between two oriented boxes (0 when overlapping).
export function obbDist(a, b) {
  if (obbOverlap(a, b)) return 0;
  let m = Infinity;
  for (const p of obbCorners(a)) m = Math.min(m, distPointObb(p[0], p[1], b));
  for (const p of obbCorners(b)) m = Math.min(m, distPointObb(p[0], p[1], a));
  return m;
}

export function polylineLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

export function polylinePointAt(pts, s) {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (s <= acc + seg || i === pts.length - 1) {
      const t = seg > 0 ? Math.min(1, Math.max(0, (s - acc) / seg)) : 0;
      return [
        pts[i - 1][0] + t * (pts[i][0] - pts[i - 1][0]),
        pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1]),
      ];
    }
    acc += seg;
  }
  return pts[pts.length - 1].slice();
}

export function polylineTangentAt(pts, s) {
  const a = polylinePointAt(pts, Math.max(0, s - 0.05));
  const b = polylinePointAt(pts, s + 0.05);
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const n = Math.hypot(dx, dz) || 1;
  return [dx / n, dz / n];
}

export function distToPolyline(px, pz, pts) {
  let m = Infinity;
  for (let i = 1; i < pts.length; i++) {
    m = Math.min(m, segPointDist(px, pz, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
  }
  return m;
}

// Min distance from a polyline to an OBB (sampled along the line, exact to obb per sample).
export function distPolylineObb(pts, o, ds = 0.25) {
  const L = polylineLength(pts);
  let m = Infinity;
  for (let s = 0; s <= L; s += ds) {
    const p = polylinePointAt(pts, s);
    m = Math.min(m, distPointObb(p[0], p[1], o));
  }
  const end = polylinePointAt(pts, L);
  m = Math.min(m, distPointObb(end[0], end[1], o));
  return m;
}

export class Grid {
  constructor(cell) { this.cell = cell; this.map = new Map(); }
  key(x, z) { return Math.floor(x / this.cell) + ':' + Math.floor(z / this.cell); }
  add(item) {
    const k = this.key(item.x, item.z);
    let arr = this.map.get(k);
    if (!arr) this.map.set(k, arr = []);
    arr.push(item);
  }
  query(x, z, r) {
    const c = this.cell, out = [];
    const x0 = Math.floor((x - r) / c), x1 = Math.floor((x + r) / c);
    const z0 = Math.floor((z - r) / c), z1 = Math.floor((z + r) / c);
    for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) {
      const arr = this.map.get(ix + ':' + iz);
      if (arr) out.push(...arr);
    }
    return out;
  }
}
