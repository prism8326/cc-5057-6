import { Rng, derive } from './rng.mjs';
import { obbFrom, obbCorners, obbDist, Grid, distPolylineObb, distToPolyline } from './geom2.mjs';
import { TYPES, TYPE_ORDER, declaredSpacing, MATERIAL_MULT } from './types.mjs';
import { densityAt, slopeDegAt } from './terrain.mjs';

export const SMALL_REGION_AREA = 500;   // m²: below this, switch to stratified cell sampling
const MAX_EVENTS = 6000;

export function withObb(inst) {
  const t = TYPES[inst.type];
  // A mirrored instance uses a positive scale; mirroring reflects the rendered mesh
  // only. The centered footprint is identical either way, so the OBB is unchanged.
  const scale = Math.abs(inst.scale);
  const hx = t.hx * scale, hz = t.hz * scale;
  return { ...inst, scale, obb: obbFrom(inst.x, inst.z, inst.yaw, hx, hz), hx, hz };
}

// Geometry filter for one candidate against context. Returns null if OK, else reason string.
export function geoRejectReason(ctx, cand, neighbors) {
  const t = TYPES[cand.type];
  const o = cand.obb;
  for (const [cx, cz] of obbCorners(o)) {
    if (!ctx.scene.contains(cx, cz)) return 'boundary';
  }
  if (slopeDegAt(ctx.scene.height, cand.x, cand.z) > t.slopeMax) return 'slope';
  if (ctx.scene.baseDensity[cand.type] && (ctx.materialMult(cand.type, cand.x, cand.z) ?? 1) <= 0) return 'material';
  const rb1 = Math.hypot(o.hx, o.hz);
  for (const other of neighbors) {
    const need = declaredSpacing(cand.type, other.type);
    const rb2 = Math.hypot(other.obb.hx, other.obb.hz);
    const cd = Math.hypot(other.x - cand.x, other.z - cand.z);
    if (cd - rb1 - rb2 >= need) continue; // bounding circles already far enough
    if (obbDist(o, other.obb) < need - 1e-9) return 'spacing';
  }
  for (const f of ctx.forbid) {
    if (f.kind !== 'corridor') continue;
    if (f.distGrid) {
      const d = lookupDistGrid(f.distGrid, cand.x, cand.z);
      if (d - rb1 >= f.half + 0.6) continue; // grid lookup proves clearance
    }
    if (distPolylineObb(f.pts, o) < f.half) return 'corridor';
  }
  return null;
}

function makeDistGrid(scene, pts, cell = 0.5) {
  const { minX, maxX, minZ, maxZ } = scene.bounds;
  const nx = Math.ceil((maxX - minX) / cell), nz = Math.ceil((maxZ - minZ) / cell);
  const data = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    data[j * nx + i] = distToPolyline(minX + (i + 0.5) * cell, minZ + (j + 0.5) * cell, pts);
  }
  return { data, nx, nz, cell, minX, minZ };
}

function lookupDistGrid(g, x, z) {
  const i = Math.min(g.nx - 1, Math.max(0, Math.floor((x - g.minX) / g.cell)));
  const j = Math.min(g.nz - 1, Math.max(0, Math.floor((z - g.minZ) / g.cell)));
  return g.data[j * g.nx + i];
}

export function makeGeoCtx(scene, forbid) {
  const enriched = (forbid || []).map(f =>
    f.kind === 'corridor' ? { ...f, distGrid: makeDistGrid(scene, f.pts) } : f
  );
  return {
    scene, forbid: enriched,
    materialMult: (type, x, z) => MATERIAL_MULT[type][scene.material(x, z)] ?? 1,
  };
}

function integrateField(scene, type, densityScale, cells = 90) {
  const { minX, maxX, minZ, maxZ } = scene.bounds;
  const dx = (maxX - minX) / cells, dz = (maxZ - minZ) / cells;
  let sum = 0, max = 0, area = 0;
  for (let i = 0; i < cells; i++) for (let j = 0; j < cells; j++) {
    const x = minX + (i + 0.5) * dx, z = minZ + (j + 0.5) * dz;
    if (!scene.contains(x, z)) continue;
    area += dx * dz;
    const d = densityAt(scene, type, TYPES, x, z) * densityScale;
    sum += d * dx * dz;
    if (d > max) max = d;
  }
  return { expected: sum, maxDensity: max, availableArea: area };
}

// Cached density field: evaluated once per type on a grid, then sampled by lookup.
function fieldGrid(scene, type, densityScale, cells = 120) {
  const { minX, maxX, minZ, maxZ } = scene.bounds;
  const dx = (maxX - minX) / cells, dz = (maxZ - minZ) / cells;
  const data = new Float64Array(cells * cells);
  let sum = 0, max = 0;
  for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) {
    const x = minX + (i + 0.5) * dx, z = minZ + (j + 0.5) * dz;
    let d = 0;
    if (scene.contains(x, z)) d = densityAt(scene, type, TYPES, x, z) * densityScale;
    data[j * cells + i] = d;
    sum += d * dx * dz;
    if (d > max) max = d;
  }
  const lookup = (x, z) => {
    const i = Math.min(cells - 1, Math.max(0, Math.floor((x - minX) / dx)));
    const j = Math.min(cells - 1, Math.max(0, Math.floor((z - minZ) / dz)));
    return data[j * cells + i];
  };
  return { lookup, expected: sum, maxDensity: max, cells };
}

// opts: { scene, layoutSeed, densityScale:{type:mult}, locked:[], forbid:[], recordEvents }
export function sampleScene(opts) {
  const { scene } = opts;
  const densityScale = opts.densityScale || {};
  const forbid = opts.forbid || [];
  const rng = new Rng(derive('layout', String(opts.layoutSeed ?? 1), scene.id));
  const ctx = makeGeoCtx(scene, forbid);
  const instances = [];
  const events = [];
  const accounting = { types: {}, policy: {}, warnings: [] };

  // Available area estimate (grid) drives the explicit small-region policy.
  const probe = integrateField(scene, 'rock', 1, 60);
  const smallRegion = probe.availableArea < SMALL_REGION_AREA;
  accounting.policy.smallRegion = smallRegion;
  accounting.policy.availableArea = +probe.availableArea.toFixed(1);
  accounting.policy.boundary = 'footprint-fully-inside';
  if (smallRegion) {
    accounting.warnings.push(`可用面积 ${probe.availableArea.toFixed(0)} m² < ${SMALL_REGION_AREA} m²：启用小区域分层网格采样策略`);
  }

  // Locked instances (e.g. signposted trees) are injected as fixed constraints.
  const grid = new Grid(6);
  for (const L of opts.locked || []) {
    const inst = withObb({ ...L, locked: true, instanceId: L.instanceId || L.id });
    instances.push(inst);
    grid.add(inst);
  }

  for (const type of TYPE_ORDER) {
    const scale = densityScale[type] ?? 1;
    const field = fieldGrid(scene, type, scale);
    const target = Math.round(field.expected);
    const acc = {
      target, achieved: 0,
      phaseA: { uniformDraws: 0, densityAccepted: 0 },
      phaseB: { accepted: 0, rejected: { boundary: 0, slope: 0, material: 0, spacing: 0, corridor: 0 } },
      saturated: false, maxDensity: +field.maxDensity.toFixed(5),
    };
    accounting.types[type] = acc;
    if (target === 0 || field.maxDensity <= 0) continue;

    const tryCandidate = (x, z) => {
      const t = TYPES[type];
      const sc = rng.range(t.scale[0], t.scale[1]);
      const yaw = rng.range(0, Math.PI * 2);
      const cand = withObb({ id: null, type, x, z, yaw, scale: sc });
      const needMax = 6;
      const neighbors = grid.query(x, z, needMax + 3);
      const reason = geoRejectReason(ctx, cand, neighbors);
      if (reason) {
        acc.phaseB.rejected[reason]++;
        if (events.length < MAX_EVENTS) events.push({ x, z, type, accepted: false, reason });
        return false;
      }
      cand.id = `${scene.id}-${type}-${instances.length}`;
      cand.instanceId = cand.id;
      instances.push(cand);
      grid.add(cand);
      acc.phaseB.accepted++;
      acc.achieved++;
      if (events.length < MAX_EVENTS) events.push({ x, z, type, accepted: true });
      return true;
    };

    let stall = 0;
    const maxStall = Math.max(3000, target * 40);

    if (smallRegion) {
      // Stratified: one jittered candidate per cell, Poisson accept by d*cellArea.
      const cell = Math.max(0.8, Math.sqrt(probe.availableArea / Math.max(40, target * 6)));
      const { minX, maxX, minZ, maxZ } = scene.bounds;
      outer:
      for (let x = minX; x < maxX; x += cell) {
        for (let z = minZ; z < maxZ; z += cell) {
          if (acc.achieved >= target) break outer;
          const jx = x + rng.range(0.1, 0.9) * cell;
          const jz = z + rng.range(0.1, 0.9) * cell;
          if (!scene.contains(jx, jz)) continue;
          acc.phaseA.uniformDraws++;
          const d = field.lookup(jx, jz);
          let expected = d * cell * cell;
          let n = Math.floor(expected);
          if (rng.next() < expected - n) n++;
          if (n === 0) continue;
          acc.phaseA.densityAccepted++;
          if (!tryCandidate(jx, jz)) { stall++; if (stall > maxStall) { acc.saturated = true; break outer; } }
          else stall = 0;
        }
      }
      if (acc.achieved < target && !acc.saturated) acc.saturated = true; // grid exhausted
    } else {
      const { minX, maxX, minZ, maxZ } = scene.bounds;
      const dMax = field.maxDensity;
      while (acc.achieved < target && stall < maxStall) {
        acc.phaseA.uniformDraws++;
        const x = rng.range(minX, maxX), z = rng.range(minZ, maxZ);
        if (!scene.contains(x, z)) continue;
        const d = field.lookup(x, z);
        if (rng.next() > d / dMax) continue; // phase A density rejection
        acc.phaseA.densityAccepted++;
        if (tryCandidate(x, z)) stall = 0;
        else stall++;
      }
      if (stall >= maxStall) acc.saturated = true;
    }

    if (acc.achieved < acc.target) {
      const r = acc.phaseB.rejected;
      const top = Object.entries(r).sort((a, b) => b[1] - a[1])[0];
      const ratio = ((acc.achieved / acc.target) * 100).toFixed(0);
      accounting.warnings.push(
        `${TYPES[type].label}: 密度达成 ${acc.achieved}/${acc.target} (${ratio}%)，几何过滤主因=${top[0]}(${top[1]}次)。` +
        ` 概率采样与几何过滤已分开计数，未将大量拒绝候选计入"符合密度"。`
      );
    }
  }

  if (forbid.some(f => f.kind === 'corridor')) {
    const lost = probe.availableArea; // report constrained range explicitly
    accounting.warnings.push(
      `净空走廊作为禁布区生效：密度与净空冲突时以净空优先，受限范围见净空报告。`
    );
  }

  return { instances, accounting, events };
}
