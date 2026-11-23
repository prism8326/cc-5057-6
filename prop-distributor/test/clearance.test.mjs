import test from 'node:test';
import assert from 'node:assert/strict';
import { getScene } from '../src/terrain.mjs';
import { sampleScene, withObb } from '../src/sampler.mjs';
import { analyzeCorridor, relocateBlockers, resampleAvoidingCorridor } from '../src/clearance.mjs';
import { verifySpacing } from '../src/stats.mjs';

const HALF_NEED = 1.7 / 2 + 0.25; // cart 1.7m + safety 0.25m

function roadRun(seed = 11, scale = 1.8) {
  const scene = getScene('road', 1);
  const run = sampleScene({
    scene, layoutSeed: seed,
    densityScale: { rock: scale, bush: scale, decor: scale },
  });
  return { scene, run };
}

test('corridor analysis finds blockers when density is pushed on the narrow road', () => {
  const { scene, run } = roadRun();
  const c = analyzeCorridor(scene.road.pts, HALF_NEED, run.instances);
  assert.ok(Number.isFinite(c.minMargin));
  assert.ok(c.pathLength > 50);
  // With boosted density next to the road we expect at least one blocker somewhere.
  assert.ok(c.blockers.length >= 1, `expected blockers, margin=${c.minMargin}`);
});

test('relocate strategy: keeps scale (no shrinking), restores clearance, keeps spacing valid', () => {
  const { scene, run } = roadRun();
  const c0 = analyzeCorridor(scene.road.pts, HALF_NEED, run.instances);
  const before = new Map(run.instances.map(i => [i.id, i.scale]));
  const rel = relocateBlockers({
    scene, instances: run.instances, blockers: c0.blockers,
    pathPts: scene.road.pts, halfNeed: HALF_NEED, layoutSeed: 11,
  });
  assert.ok(rel.retainedRatio >= 0.9, `retained ${rel.retainedRatio}`);
  assert.ok(rel.clearance.minMargin >= -1e-6, `margin ${rel.clearance.minMargin}`);
  for (const inst of rel.instances) {
    if (before.has(inst.id)) assert.equal(inst.scale, before.get(inst.id), 'scale must not shrink');
  }
  const v = verifySpacing(rel.instances);
  assert.equal(v.violations, 0, 'spacing must still hold after relocation');
});

test('resample strategy: corridor forbidden zone yields full clearance and reports retained ratio', () => {
  const { scene, run } = roadRun();
  const res = resampleAvoidingCorridor({
    scene, layoutSeed: 11, densityScale: { rock: 1.8, bush: 1.8, decor: 1.8 },
    locked: [], pathPts: scene.road.pts, halfNeed: HALF_NEED, previous: run.instances,
  });
  assert.ok(res.clearance.minMargin >= -1e-6, `margin ${res.clearance.minMargin}`);
  assert.ok(res.retainedRatio > 0.3 && res.retainedRatio <= 1, `retained ${res.retainedRatio}`);
  const v = verifySpacing(res.instances);
  assert.equal(v.violations, 0);
});

test('locked signposted trees survive resampling exactly (stable identity + fixed transform)', () => {
  const scene = getScene('road', 1);
  const first = sampleScene({ scene, layoutSeed: 21 });
  const trees = first.instances.filter(i => i.type === 'tree').slice(0, 3);
  const locked = trees.map(t => ({ id: t.id, type: 'tree', x: t.x, z: t.z, yaw: t.yaw, scale: t.scale, signpostId: 'SGN-test' }));
  const second = sampleScene({ scene, layoutSeed: 99, locked });
  for (const L of locked) {
    const found = second.instances.find(i => i.id === L.id);
    assert.ok(found, `locked ${L.id} missing`);
    assert.equal(found.x, L.x);
    assert.equal(found.z, L.z);
    assert.equal(found.yaw, L.yaw);
    assert.equal(found.locked, true);
  }
  const v = verifySpacing(second.instances);
  assert.equal(v.violations, 0, 'new instances must respect locked trees');
});

test('locked trees create explainable density gap: density near locked tree is zero within spacing radius', () => {
  const scene = getScene('road', 1);
  const first = sampleScene({ scene, layoutSeed: 21 });
  const tree = first.instances.find(i => i.type === 'tree');
  const locked = [{ id: tree.id, type: 'tree', x: tree.x, z: tree.z, yaw: tree.yaw, scale: tree.scale }];
  const second = sampleScene({ scene, layoutSeed: 22, locked });
  for (const inst of second.instances) {
    if (inst.id === tree.id) continue;
    const d = Math.hypot(inst.x - tree.x, inst.z - tree.z);
    assert.ok(d > 1.5, `${inst.id} too close to locked tree: ${d}`);
  }
});
