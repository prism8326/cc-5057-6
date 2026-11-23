import { polylineLength, polylinePointAt, distPointObb, Grid } from './geom2.mjs';
import { withObb, geoRejectReason, sampleScene, makeGeoCtx } from './sampler.mjs';
import { Rng, derive } from './rng.mjs';

// Swept-corridor clearance for a cart of given half-width plus safety margin.
export function analyzeCorridor(pathPts, halfNeed, instances) {
  const L = polylineLength(pathPts);
  const ds = 0.25;
  let minMargin = Infinity, minAt = 0;
  const blockerIds = new Set();
  for (let s = 0; s <= L + 1e-6; s += ds) {
    const p = polylinePointAt(pathPts, Math.min(s, L));
    for (const inst of instances) {
      const margin = distPointObb(p[0], p[1], inst.obb) - halfNeed;
      if (margin < minMargin) { minMargin = margin; minAt = Math.min(s, L); }
      if (margin < 0) blockerIds.add(inst.id);
    }
  }
  return { minMargin, minAt, blockers: [...blockerIds], pathLength: L };
}

// Strategy 1: relocate blocking props to the nearest valid spot (never shrink them).
export function relocateBlockers({ scene, instances, blockers, pathPts, halfNeed, layoutSeed }) {
  const rng = new Rng(derive('relocate', String(layoutSeed)));
  const blockerSet = new Set(blockers);
  const kept = instances.filter(i => !blockerSet.has(i.id));
  const moved = [], deleted = [];
  const ctx = makeGeoCtx(scene, [{ kind: 'corridor', pts: pathPts, half: halfNeed }]);

  const rebuildGrid = () => {
    const g = new Grid(6);
    for (const i of [...kept, ...moved]) g.add(i);
    return g;
  };

  for (const b of instances.filter(i => blockerSet.has(i.id))) {
    let placed = null;
    outer:
    for (let r = 0.6; r <= 9; r += 0.3) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2 + rng.range(-0.1, 0.1);
        const nx = b.x + r * Math.cos(a), nz = b.z + r * Math.sin(a);
        const cand = withObb({ ...b, x: nx, z: nz }); // scale & yaw preserved: no shrinking
        const grid = rebuildGrid();
        const reason = geoRejectReason(ctx, cand, grid.query(nx, nz, 9));
        if (!reason) { placed = cand; break outer; }
      }
    }
    if (placed) moved.push(placed); else deleted.push(b);
  }

  const result = [...kept, ...moved];
  const total = instances.length;
  return {
    instances: result,
    moved: moved.length,
    deleted: deleted.length,
    retainedRatio: total ? (total - deleted.length) / total : 1,
    clearance: analyzeCorridor(pathPts, halfNeed, result),
  };
}

// Strategy 2: resample the whole layout with the corridor as a forbidden zone.
export function resampleAvoidingCorridor({ scene, layoutSeed, densityScale, locked, pathPts, halfNeed, previous }) {
  const run = sampleScene({
    scene, layoutSeed, densityScale, locked,
    forbid: [{ kind: 'corridor', pts: pathPts, half: halfNeed }],
  });
  const key = i => `${i.type}@${i.x.toFixed(2)},${i.z.toFixed(2)}`;
  const prevKeys = new Set(previous.map(key));
  const retained = run.instances.filter(i => prevKeys.has(key(i))).length;
  return {
    ...run,
    retainedRatio: previous.length ? retained / previous.length : 1,
    clearance: analyzeCorridor(pathPts, halfNeed, run.instances),
  };
}
