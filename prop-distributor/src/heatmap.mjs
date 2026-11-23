import { TYPES, MATERIAL_MULT, declaredSpacing } from './types.mjs';
import { densityAt, slopeDegAt } from './terrain.mjs';
import { obbFrom, obbCorners, distToPolyline } from './geom2.mjs';

// Top-down map: density field layer, constraint (exclusion) layer, instance footprints,
// road/corridor overlay, and sampling-process dots.
export function drawHeatmap(canvas, scene, opts = {}) {
  const {
    layer = 'constraint', selType = 'bush', instances = [], corridor = null,
    events = null, eventCount = 0, signposts = [], densityScale = 1,
  } = opts;
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext('2d');
  const { minX, maxX, minZ, maxZ } = scene.bounds;
  const sx = (x) => ((x - minX) / (maxX - minX)) * W;
  const sz = (z) => ((z - minZ) / (maxZ - minZ)) * H;
  const toWorld = (px, py) => [minX + (px / W) * (maxX - minX), minZ + (py / H) * (maxZ - minZ)];

  const img = ctx.createImageData(W, H);
  const placed = instances;
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const [x, z] = toWorld(px + 0.5, py + 0.5);
      let r = 16, g = 20, b = 28;
      if (scene.contains(x, z)) {
        if (layer === 'density') {
          const d = densityAt(scene, selType, TYPES, x, z) * densityScale;
          const k = Math.min(1, d / 0.25);
          r = 20 + 40 * (1 - k); g = 30 + 160 * k; b = 40;
        } else {
          // constraint map: first blocking reason wins
          let code = 0;
          if (slopeDegAt(scene.height, x, z) > TYPES[selType].slopeMax) code = 2;
          else if ((MATERIAL_MULT[selType][scene.material(x, z)] ?? 1) <= 0.05) code = 3;
          else {
            const probe = obbFrom(x, z, 0, TYPES[selType].hx, TYPES[selType].hz);
            for (const inst of placed) {
              const dx = inst.x - x, dz = inst.z - z;
              if (dx * dx + dz * dz > 81) continue;
              const need = declaredSpacing(selType, inst.type);
              // cheap center pre-check then exact-ish: corner distance to instance obb
              let dmin = Infinity;
              for (const [cx2, cz2] of obbCorners(probe)) {
                const dd = pointObbDist(cx2, cz2, inst.obb);
                if (dd < dmin) dmin = dd;
              }
              const dc = pointObbDist(x, z, inst.obb);
              dmin = Math.min(dmin, dc);
              if (dmin < need) { code = 4; break; }
            }
            if (!code && corridor && distToPolyline(x, z, corridor.pts) < corridor.half) code = 5;
          }
          if (code === 0) { r = 26; g = 46; b = 34; }
          else if (code === 2) { r = 70; g = 50; b = 90; }   // slope
          else if (code === 3) { r = 90; g = 70; b = 40; }   // material
          else if (code === 4) { r = 96; g = 34; b = 34; }   // spacing exclusion
          else { r = 120; g = 40; b = 60; }                  // corridor
        }
      } else if (scene.road && distToPolyline(x, z, scene.road.pts) <= scene.road.half) {
        r = 50; g = 52; b = 58; // road surface
      }
      const idx = (py * W + px) * 4;
      img.data[idx] = r; img.data[idx + 1] = g; img.data[idx + 2] = b; img.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // corridor outline
  if (corridor) {
    ctx.strokeStyle = 'rgba(255,80,70,0.8)';
    ctx.setLineDash([4, 3]);
    for (const side of [-1, 1]) {
      ctx.beginPath();
      for (let i = 0; i < corridor.pts.length; i++) {
        const p = corridor.pts[i];
        const q = corridor.pts[Math.min(corridor.pts.length - 1, i + 1)];
        const dx = q[0] - p[0], dz = q[1] - p[1];
        const L = Math.hypot(dx, dz) || 1;
        const ox = -dz / L * corridor.half * side, oz = dx / L * corridor.half * side;
        const X = sx(p[0] + ox), Y = sz(p[1] + oz);
        i === 0 ? ctx.moveTo(X, Y) : ctx.lineTo(X, Y);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // instance footprints (actual oriented boxes)
  for (const inst of instances) {
    const cs = obbCorners(inst.obb);
    ctx.beginPath();
    ctx.moveTo(sx(cs[0][0]), sz(cs[0][1]));
    for (let i = 1; i < 4; i++) ctx.lineTo(sx(cs[i][0]), sz(cs[i][1]));
    ctx.closePath();
    ctx.fillStyle = inst.locked ? 'rgba(255,213,79,0.9)' : footprintColor(inst.type);
    ctx.fill();
  }

  // sampling process dots
  if (events) {
    const n = Math.min(eventCount, events.length);
    for (let i = 0; i < n; i++) {
      const e = events[i];
      ctx.fillStyle = e.accepted ? 'rgba(105,240,174,0.95)' : 'rgba(255,82,82,0.5)';
      ctx.fillRect(sx(e.x) - 1, sz(e.z) - 1, e.accepted ? 3 : 2, e.accepted ? 3 : 2);
    }
  }

  // signposts
  ctx.font = '10px sans-serif';
  for (const sp of signposts) {
    ctx.fillStyle = '#ffd54f';
    ctx.fillRect(sx(sp.x) - 1, sz(sp.z) - 6, 2, 7);
    ctx.beginPath();
    ctx.moveTo(sx(sp.x), sz(sp.z) - 6);
    ctx.lineTo(sx(sp.x) + 6, sz(sp.z) - 4);
    ctx.lineTo(sx(sp.x), sz(sp.z) - 2);
    ctx.fill();
  }
}

function footprintColor(type) {
  return { tree: 'rgba(46,125,50,0.85)', rock: 'rgba(150,150,160,0.85)', bush: 'rgba(104,159,56,0.85)', decor: 'rgba(176,141,87,0.85)' }[type] || '#888';
}

function pointObbDist(px, pz, o) {
  const dx = px - o.cx, dz = pz - o.cz;
  const lx = dx * o.ax[0] + dz * o.ax[1];
  const lz = dx * o.az[0] + dz * o.az[1];
  const ax = Math.max(Math.abs(lx) - o.hx, 0);
  const az = Math.max(Math.abs(lz) - o.hz, 0);
  return Math.hypot(ax, az);
}
