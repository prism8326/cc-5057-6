import test from 'node:test';
import assert from 'node:assert/strict';
import { getScene } from '../src/terrain.mjs';
import { sampleScene } from '../src/sampler.mjs';
import {
  serializeDistribution, validateDistributionAsset, assetToRenderInstances, assetOverlaps,
  makeInstanceRecord, DISTRIBUTION_FORMAT_VERSION,
} from '../src/distribution.mjs';
import { analyzeCorridor } from '../src/clearance.mjs';
import { geoRejectReason, makeGeoCtx, withObb } from '../src/sampler.mjs';

// Integration path mirroring the level-editor viewport: set density -> generate ->
// migrate into a v2 asset -> place a manual prop -> validate instance distribution
// and clearance, all reading the migrated asset (not raw sampler output).

const HALF_NEED = 1.7 / 2 + 0.25;

test('editor flow: density -> asset -> manual placement -> distribution + clearance checks', () => {
  const scene = getScene('road', 1, 1);

  // 1) Set density (narrow-road high-density scenario) and generate.
  const densityScale = { rock: 1.8, bush: 1.8, decor: 1.8 };
  const run = sampleScene({ scene, layoutSeed: 11, densityScale });
  const asset = serializeDistribution({ scene, layoutSeed: 11, densityScale, run });
  assert.equal(asset.formatVersion, DISTRIBUTION_FORMAT_VERSION);

  // 2) Render/editor instances come from the migrated asset.
  const instances = assetToRenderInstances(asset);
  assert.equal(instances.length, asset.instances.length);
  assert.equal(validateDistributionAsset(asset, { scene }).ok, true);

  // 3) Manual placement goes through the same declared-constraint filter, then is
  // written as a v2 manual-override record and re-read from the asset.
  const ctx = makeGeoCtx(scene, []);
  const manualPos = [0, 0]; // on the road centre-line; should be rejected (corridor/road)
  const cand = withObb({ id: 'manual-1', type: 'bush', x: manualPos[0], z: manualPos[1], yaw: 0, scale: 1 });
  const reason = geoRejectReason(ctx, cand, instances.filter(i => Math.hypot(i.x - manualPos[0], i.z - manualPos[1]) < 9));
  assert.ok(reason, 'placement on the road must be rejected by declared constraints');

  // Place somewhere valid by searching the whole scene.
  let placed = null;
  for (let i = 0; i < 2000 && !placed; i++) {
    const x = scene.bounds.minX + (i * 7.13) % (scene.bounds.maxX - scene.bounds.minX);
    const z = scene.bounds.minZ + (i * 3.71) % (scene.bounds.maxZ - scene.bounds.minZ);
    const c = withObb({ id: 'manual-find', type: 'decor', x, z, yaw: i * 0.3, scale: 1 });
    const rs = geoRejectReason(ctx, c, instances.filter(n => Math.hypot(n.x - x, n.z - z) < 9));
    if (!rs) { placed = { x, z, yaw: i * 0.3 }; }
  }
  assert.ok(placed, 'should find a valid manual placement spot');

  const rec = makeInstanceRecord({
    scene, instanceId: 'manual-1', type: 'decor', x: placed.x, z: placed.z,
    yaw: placed.yaw, scale: 1, manualOverride: true,
  });
  const withManual = {
    ...asset,
    instances: [...asset.instances, rec],
    manualOverrides: [...asset.manualOverrides, 'manual-1'],
  };
  const reread = assetToRenderInstances(withManual);
  assert.equal(reread.length, instances.length + 1);
  assert.equal(reread.at(-1).instanceId, 'manual-1');
  assert.equal(reread.at(-1).x, placed.x, 'render reads the migrated manual record');
  assert.equal(validateDistributionAsset(withManual, { scene }).ok, true);

  // 4) Distribution invariant: spacing/overlap on migrated footprints.
  assert.equal(assetOverlaps(withManual), 0, 'manual placement respects spacing');

  // 5) Clearance range on the migrated + manual layout.
  const corridor = analyzeCorridor(scene.road.pts, HALF_NEED, reread);
  assert.ok(Number.isFinite(corridor.minMargin));
  assert.ok(corridor.pathLength > 50);
});
