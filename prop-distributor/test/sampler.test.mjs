import test from 'node:test';
import assert from 'node:assert/strict';
import { getScene } from '../src/terrain.mjs';
import { sampleScene, withObb, geoRejectReason, makeGeoCtx } from '../src/sampler.mjs';
import { verifySpacing, overlapViolations, layoutHash, clarkEvans } from '../src/stats.mjs';
import { obbCorners, obbFrom } from '../src/geom2.mjs';
import { declaredSpacing } from '../src/types.mjs';

test('same layout seed reproduces identical layout; different seed differs', () => {
  const scene = getScene('plane', 1);
  const a = sampleScene({ scene, layoutSeed: 7 });
  const b = sampleScene({ scene, layoutSeed: 7 });
  const c = sampleScene({ scene, layoutSeed: 8 });
  assert.equal(layoutHash(a.instances), layoutHash(b.instances));
  assert.notEqual(layoutHash(a.instances), layoutHash(c.instances));
});

test('declared spacing holds on every scene (oriented footprints, not center distance)', () => {
  for (const id of ['plane', 'slope', 'strip', 'road']) {
    const scene = getScene(id, 1);
    const { instances } = sampleScene({ scene, layoutSeed: 3 });
    const v = verifySpacing(instances);
    assert.equal(v.violations, 0, `${id}: ${v.details.join('; ')}`);
    assert.equal(overlapViolations(instances), 0, `${id}: overlaps`);
  }
});

test('boundary policy: every footprint corner lies inside the region', () => {
  for (const id of ['plane', 'strip', 'road']) {
    const scene = getScene(id, 1);
    const { instances } = sampleScene({ scene, layoutSeed: 5 });
    for (const inst of instances) {
      for (const [x, z] of obbCorners(inst.obb)) {
        assert.ok(scene.contains(x, z), `${id}: ${inst.id} corner outside at ${x.toFixed(1)},${z.toFixed(1)}`);
      }
    }
  }
});

test('density accounting: plane scene achieves target within tolerance, phases counted separately', () => {
  const scene = getScene('plane', 1);
  const { accounting } = sampleScene({ scene, layoutSeed: 2 });
  for (const [type, a] of Object.entries(accounting.types)) {
    if (a.target === 0) continue;
    assert.ok(a.achieved >= a.target * 0.85, `${type}: ${a.achieved}/${a.target}`);
    assert.ok(a.phaseA.uniformDraws >= a.phaseA.densityAccepted);
    assert.ok(a.phaseA.densityAccepted >= a.phaseB.accepted);
  }
});

test('small-region policy triggers on the narrow strip', () => {
  const scene = getScene('strip', 1);
  const { accounting } = sampleScene({ scene, layoutSeed: 2 });
  assert.equal(accounting.policy.smallRegion, true);
  assert.ok(accounting.warnings.some(w => w.includes('小区域')));
});

test('geometry filter rejects candidate that passes center-distance but fails oriented-edge spacing', () => {
  const scene = getScene('plane', 1);
  const ctx = makeGeoCtx(scene, []);
  // Locked long rock rotated 45deg at origin.
  const locked = withObb({ id: 'L', type: 'rock', x: 0, z: 0, yaw: Math.PI / 4, scale: 1.7 });
  // Candidate center 2.3m away on x: center distance fine for many pairs, but
  // oriented corners of the long rotated rock reach into the declared gap.
  const cand = withObb({ id: 'C', type: 'rock', x: 1.9, z: 0, yaw: Math.PI / 4, scale: 1.7 });
  const centerDist = 1.9;
  assert.ok(centerDist > declaredSpacing('rock', 'rock'), 'center distance alone would pass');
  const reason = geoRejectReason(ctx, cand, [locked]);
  assert.equal(reason, 'spacing');
});

test('spacing check uses actual size: scaled-up prop needs more room', () => {
  const scene = getScene('plane', 1);
  const ctx = makeGeoCtx(scene, []);
  const big = withObb({ id: 'B', type: 'decor', x: 0, z: 0, yaw: 0, scale: 1.45 });
  const near = withObb({ id: 'N', type: 'decor', x: 0.9, z: 0, yaw: 0, scale: 1.45 });
  const reason = geoRejectReason(ctx, near, [big]);
  assert.equal(reason, 'spacing'); // 0.9 - 0.34*1.45*2 = -0.086 edge gap < 0.4 declared
});

test('Clark-Evans R exceeds 1 (regularity from enforced spacing), not just uniform RNG', () => {
  const scene = getScene('plane', 1);
  const { instances, accounting } = sampleScene({ scene, layoutSeed: 4 });
  const R = clarkEvans(instances, accounting.policy.availableArea);
  assert.ok(R > 1.05, `R=${R} should show regularity`);
});
