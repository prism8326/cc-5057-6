import { MATERIAL_COLORS } from './types.mjs';
import { polylinePointAt, polylineTangentAt, polylineLength } from './geom2.mjs';
import { mulberry32, derive } from './rng.mjs';

export function makeCamera() {
  return { yaw: 0.65, pitch: 0.85, dist: 62, tx: 0, tz: 0, fov: 0.9 };
}

export function project(cam, W, H, p) {
  const x = p[0] - cam.tx, y = p[1], z = p[2] - cam.tz;
  const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
  const x1 = x * cy - z * sy, z1 = x * sy + z * cy;
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  const y1 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;
  const zc = z2 + cam.dist;
  if (zc < 0.5) return null;
  const f = (H * 0.5) / Math.tan(cam.fov * 0.5);
  return [W * 0.5 + (x1 * f) / zc, H * 0.5 - (y1 * f) / zc, zc];
}

const SUN = (() => { const v = [-0.5, 0.8, -0.35]; const n = Math.hypot(...v); return v.map(c => c / n); })();

// Invert the camera: screen point -> world ray -> terrain heightfield intersection.
export function screenToGround(cam, W, H, sx, sy, heightFn) {
  const f = (H * 0.5) / Math.tan(cam.fov * 0.5);
  const dxv = (sx - W * 0.5) / f, dyv = -(sy - H * 0.5) / f;
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  const cy = Math.cos(cam.yaw), syw = Math.sin(cam.yaw);
  const unX = (v) => [v[0], v[1] * cp + v[2] * sp, -v[1] * sp + v[2] * cp];
  const unY = (v) => [v[0] * cy + v[2] * syw, v[1], -v[0] * syw + v[2] * cy];
  const dirV = unY(unX([dxv, dyv, 1]));
  const dl = Math.hypot(...dirV);
  const dir = dirV.map(c => c / dl);
  const org = unY(unX([0, 0, -cam.dist]));
  const ox = cam.tx + org[0], oy = org[1], oz = cam.tz + org[2];
  let prev = 0;
  for (let t = 0.5; t < 400; t += 0.5) {
    const x = ox + dir[0] * t, y = oy + dir[1] * t, z = oz + dir[2] * t;
    if (y < heightFn(x, z)) {
      let lo = prev, hi = t;
      for (let i = 0; i < 24; i++) {
        const m = (lo + hi) / 2;
        const mx = ox + dir[0] * m, my = oy + dir[1] * m, mz = oz + dir[2] * m;
        if (my < heightFn(mx, mz)) hi = m; else lo = m;
      }
      const m = (lo + hi) / 2;
      return [ox + dir[0] * m, oz + dir[2] * m];
    }
    prev = t;
  }
  return null;
}

function shade(color, normal, alpha = 1) {
  const d = Math.max(0, normal[0] * SUN[0] + normal[1] * SUN[1] + normal[2] * SUN[2]);
  const k = 0.45 + 0.55 * d;
  const c = parseColor(color);
  return `rgba(${Math.min(255, c[0] * k) | 0},${Math.min(255, c[1] * k) | 0},${Math.min(255, c[2] * k) | 0},${alpha})`;
}

const colorCache = new Map();
function parseColor(c) {
  let v = colorCache.get(c);
  if (!v) {
    v = [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
    colorCache.set(c, v);
  }
  return v;
}

function faceNormal(a, b, c) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const l = Math.hypot(...n) || 1;
  return [n[0] / l, n[1] / l, n[2] / l];
}

// ---- mesh builders (verts local, base at y=0) ----
function box(sx, sy, sz) {
  const x = sx / 2, z = sz / 2;
  const v = [[-x, 0, -z], [x, 0, -z], [x, 0, z], [-x, 0, z], [-x, sy, -z], [x, sy, -z], [x, sy, z], [-x, sy, z]];
  const f = [[0, 1, 2, 3], [4, 7, 6, 5], [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0]];
  return { v, f };
}
function cylinder(r, h, n = 6) {
  const v = [], f = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    v.push([r * Math.cos(a), 0, r * Math.sin(a)], [r * Math.cos(a), h, r * Math.sin(a)]);
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    f.push([i * 2, j * 2, j * 2 + 1, i * 2 + 1]);
  }
  f.push([...Array(n).keys()].map(i => i * 2 + 1).reverse());
  return { v, f };
}
function cone(r, h, n = 7) {
  const v = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    v.push([r * Math.cos(a), 0, r * Math.sin(a)]);
  }
  v.push([0, h, 0]);
  const f = [];
  for (let i = 0; i < n; i++) f.push([i, (i + 1) % n, n]);
  return { v, f };
}
function rockMesh(seed) {
  const r = mulberry32(seed);
  const j = () => 0.72 + r() * 0.5;
  const v = [[0, 0.95 * j(), 0], [j(), 0.3, 0], [0, 0.32, j()], [-j(), 0.3, 0], [0, 0.3, -j()], [0, -0.05, 0]];
  const f = [[0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 1], [5, 2, 1], [5, 3, 2], [5, 4, 3], [5, 1, 4]];
  return { v, f };
}

const MESH_CACHE = new Map();
function propParts(inst) {
  const key = inst.id;
  let parts = MESH_CACHE.get(key);
  if (parts) return parts;
  const s = inst.scale;
  switch (inst.type) {
    case 'tree':
      parts = [
        { mesh: cylinder(0.16 * s, 1.5 * s, 6), color: '#6d4c2f', dy: 0 },
        { mesh: cone(1.05 * s, 2.6 * s, 8), color: '#2e7d32', dy: 1.1 * s },
        { mesh: cone(0.7 * s, 1.6 * s, 8), color: '#388e3c', dy: 2.4 * s },
      ];
      break;
    case 'rock': {
      const g = 0.85 + 0.3 * ((derive(inst.id) % 100) / 100);
      const hex = [140 * g, 140 * g, 148 * g].map(v => Math.min(255, Math.round(v)).toString(16).padStart(2, '0')).join('');
      parts = [{ mesh: rockMesh(derive(inst.id)), color: '#' + hex, dy: 0 }];
      break;
    }
    case 'bush':
      parts = [
        { mesh: cone(0.55 * s, 0.75 * s, 7), color: '#558b2f', dy: 0 },
        { mesh: cone(0.34 * s, 0.5 * s, 6), color: '#689f38', dy: 0.4 * s },
      ];
      break;
    case 'decor':
      parts = [{ mesh: box(0.5 * s, 0.42 * s, 0.5 * s), color: '#b08d57', dy: 0 }];
      break;
  }
  MESH_CACHE.set(key, parts);
  return parts;
}

export function clearMeshCache() { MESH_CACHE.clear(); }

// ---- world face collection ----
function emitMesh(out, cam, W, H, mesh, color, xf, alpha = 1) {
  const { v, f } = mesh;
  const w = v.map(p => xf(p));
  for (const face of f) {
    const pts = face.map(i => w[i]);
    const n = faceNormal(pts[0], pts[1], pts[2]);
    if (n[1] < -0.9 && pts[0][1] < 0.01) continue; // skip bottom faces on ground
    let depth = 0;
    const scr = [];
    let ok = true;
    for (const p of pts) {
      const q = project(cam, W, H, p);
      if (!q) { ok = false; break; }
      scr.push(q); depth += q[2];
    }
    if (!ok) continue;
    out.push({ scr, depth: depth / pts.length, fill: shade(color, n, alpha) });
  }
}

function instTransform(inst, groundY) {
  const c = Math.cos(inst.yaw), s = Math.sin(inst.yaw), k = Math.abs(inst.scale);
  const y0 = groundY;
  // Mirroring reflects local X (equivalent to a negative X scale) without letting a
  // negative scale leak into footprint/clearance math.
  const mx = inst.mirrored ? -1 : 1;
  return (p) => [
    inst.x + k * (c * (mx * p[0]) + s * p[2]),
    y0 + k * p[1],
    inst.z + k * (-s * (mx * p[0]) + c * p[2]),
  ];
}

function ribbonFaces(out, cam, W, H, pts, half, heightFn, color, alpha, yOff = 0.04) {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const L = Math.hypot(dx, dz) || 1;
    const nx = -dz / L * half, nz = dx / L * half;
    const quad = [
      [a[0] + nx, heightFn(a[0] + nx, a[1] + nz) + yOff, a[1] + nz],
      [a[0] - nx, heightFn(a[0] - nx, a[1] - nz) + yOff, a[1] - nz],
      [b[0] - nx, heightFn(b[0] - nx, b[1] - nz) + yOff, b[1] - nz],
      [b[0] + nx, heightFn(b[0] + nx, b[1] + nz) + yOff, b[1] + nz],
    ];
    let depth = 0;
    const scr = [];
    let ok = true;
    for (const p of quad) {
      const q = project(cam, W, H, p);
      if (!q) { ok = false; break; }
      scr.push(q); depth += q[2];
    }
    if (!ok) continue;
    out.push({ scr, depth: depth / 4, fill: color.startsWith('rgba') ? color : shade(color, [0, 1, 0], alpha) });
  }
}

function densify(pts, step = 1.2) {
  const L = polylineLength(pts);
  const out = [];
  for (let s = 0; s <= L; s += step) out.push(polylinePointAt(pts, s));
  out.push(pts[pts.length - 1]);
  return out;
}

// opts: { corridor:{pts,half}, cart:{s, width}, signposts:[], selectedSignpost, sources:{accepted,rejected}, highlight:Set<instId>, showSources }
export function renderWorld(ctx2d, cam, scene, instances, opts = {}) {
  const W = ctx2d.canvas.width, H = ctx2d.canvas.height;
  ctx2d.fillStyle = '#10151d';
  ctx2d.fillRect(0, 0, W, H);
  const faces = [];

  // terrain
  const N = 54;
  const { minX, maxX, minZ, maxZ } = scene.bounds;
  const dx = (maxX - minX) / N, dz = (maxZ - minZ) / N;
  const hAt = (i, j) => scene.height(minX + i * dx, minZ + j * dz);
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const cx = minX + (i + 0.5) * dx, cz = minZ + (j + 0.5) * dz;
    const onRoad = scene.road && distToRoad(scene, cx, cz) < scene.road.half + dx;
    if (!scene.contains(cx, cz) && !onRoad) continue;
    const quad = [
      [minX + i * dx, hAt(i, j), minZ + j * dz],
      [minX + (i + 1) * dx, hAt(i + 1, j), minZ + j * dz],
      [minX + (i + 1) * dx, hAt(i + 1, j + 1), minZ + (j + 1) * dz],
      [minX + i * dx, hAt(i, j + 1), minZ + (j + 1) * dz],
    ];
    const n = faceNormal(quad[0], quad[1], quad[2]);
    let depth = 0;
    const scr = [];
    let ok = true;
    for (const p of quad) {
      const q = project(cam, W, H, p);
      if (!q) { ok = false; break; }
      scr.push(q); depth += q[2];
    }
    if (!ok) continue;
    const mat = scene.material(cx, cz);
    faces.push({ scr, depth: depth / 4, fill: shade(MATERIAL_COLORS[mat] || '#4a7c3a', n) });
  }

  // road ribbon
  if (scene.road) {
    ribbonFaces(faces, cam, W, H, densify(scene.road.pts), scene.road.half, scene.height, '#3c3f45', 1, 0.05);
  }
  // clearance corridor overlay
  if (opts.corridor) {
    ribbonFaces(faces, cam, W, H, densify(opts.corridor.pts), opts.corridor.half, scene.height, 'rgba(255,70,60,0.20)', 1, 0.09);
  }

  // props
  for (const inst of instances) {
    const y0 = scene.height(inst.x, inst.z);
    const xf = instTransform(inst, y0);
    const hl = opts.highlight && opts.highlight.has(inst.id);
    for (const part of propParts(inst)) {
      const m = { v: part.mesh.v.map(p => [p[0], p[1] + part.dy, p[2]]), f: part.mesh.f };
      emitMesh(faces, cam, W, H, m, hl ? '#ff5252' : part.color, xf);
    }
    if (inst.locked) {
      const ring = cylinder(inst.hx + 0.25, 0.06, 12);
      emitMesh(faces, cam, W, H, ring, '#ffd54f', (p) => [inst.x + p[0], y0 + 0.02, inst.z + p[2]]);
    }
  }

  // signposts
  const signpostScreen = [];
  for (const sp of opts.signposts || []) {
    const y0 = scene.height(sp.x, sp.z);
    const sel = opts.selectedSignpost === sp.signpostId;
    const col = sel ? '#ffeb3b' : '#c17900';
    emitMesh(faces, cam, W, H, box(0.09, 1.5, 0.09), '#7a5a33', (p) => [sp.x + p[0], y0 + p[1], sp.z + p[2]]);
    emitMesh(faces, cam, W, H, box(0.7, 0.4, 0.06), col, (p) => [sp.x + p[0], y0 + 1.05 + p[1], sp.z + p[2]]);
    const q = project(cam, W, H, [sp.x, y0 + 1.3, sp.z]);
    if (q) signpostScreen.push({ id: sp.signpostId, sx: q[0], sy: q[1], data: sp });
  }

  // character + wide cart on the road
  if (opts.cart && scene.road) {
    const s = opts.cart.s;
    const p = polylinePointAt(scene.road.pts, s);
    const t = polylineTangentAt(scene.road.pts, s);
    const yaw = Math.atan2(t[0], t[1]);
    const y0 = scene.height(p[0], p[1]) + 0.06;
    const half = opts.cart.width / 2;
    const c = Math.cos(yaw), sn = Math.sin(yaw);
    const xf = (off) => (v) => [
      p[0] + (c * (v[0] + off[0]) + sn * (v[2] + off[2])),
      y0 + v[1],
      p[1] + (-sn * (v[0] + off[0]) + c * (v[2] + off[2])),
    ];
    emitMesh(faces, cam, W, H, box(half * 2, 0.5, 1.5), '#8d6e63', xf([0, 0, 0]));
    emitMesh(faces, cam, W, H, cylinder(0.3, 0.12, 8), '#4e342e', xf([-half - 0.06, 0, 0]));
    emitMesh(faces, cam, W, H, cylinder(0.3, 0.12, 8), '#4e342e', xf([half + 0.06, 0, 0]));
    emitMesh(faces, cam, W, H, cylinder(0.16, 1.0, 6), '#29559f', xf([0, 0, 1.6]));
    emitMesh(faces, cam, W, H, box(0.3, 0.3, 0.3), '#d7a06a', xf([0, 1.0, 1.6]));
  }

  faces.sort((a, b) => b.depth - a.depth);
  for (const f of faces) {
    ctx2d.beginPath();
    ctx2d.moveTo(f.scr[0][0], f.scr[0][1]);
    for (let i = 1; i < f.scr.length; i++) ctx2d.lineTo(f.scr[i][0], f.scr[i][1]);
    ctx2d.closePath();
    ctx2d.fillStyle = f.fill;
    ctx2d.fill();
  }

  // sampling source points (accepted / rejected candidates)
  if (opts.sources) {
    const draw = (list, color, r) => {
      ctx2d.fillStyle = color;
      for (const e of list) {
        const q = project(cam, W, H, [e.x, scene.height(e.x, e.z) + 0.12, e.z]);
        if (!q) continue;
        ctx2d.beginPath();
        ctx2d.arc(q[0], q[1], r, 0, Math.PI * 2);
        ctx2d.fill();
      }
    };
    draw(opts.sources.rejected || [], 'rgba(255,82,82,0.55)', 1.6);
    draw(opts.sources.accepted || [], 'rgba(105,240,174,0.9)', 2.2);
  }

  return { signpostScreen };
}

function distToRoad(scene, x, z) {
  let m = Infinity;
  const pts = scene.road.pts;
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1][0], az = pts[i - 1][1], bx = pts[i][0], bz = pts[i][1];
    const abx = bx - ax, abz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * abx + (z - az) * abz) / (abx * abx + abz * abz)));
    m = Math.min(m, Math.hypot(x - (ax + t * abx), z - (az + t * abz)));
  }
  return m;
}
