import test from 'node:test';
import assert from 'node:assert/strict';
import { getScene } from '../src/terrain.mjs';
import { getSurfaces } from '../src/surface.mjs';
import { sampleScene } from '../src/sampler.mjs';
import {
  serializeDistribution, migrateDistribution, validateDistributionAsset,
  assetToRenderInstances, assetOverlaps, makeInstanceRecord,
  DISTRIBUTION_FORMAT, DISTRIBUTION_FORMAT_VERSION, ANCHOR_COINCIDENCE_EPS, DEVIATION_WARN,
} from '../src/distribution.mjs';
import { makeLegacySample } from '../src/legacy.mjs';

function freshAsset({ sceneId = 'road', seed = 11, terrainSeed = 1, surfaceVersion = 1 } = {}) {
  const scene = getScene(sceneId, terrainSeed, surfaceVersion);
  const run = sampleScene({ scene, layoutSeed: seed });
  const asset = serializeDistribution({ scene, layoutSeed: seed, terrainSeed, densityScale: {}, run });
  return { scene, run, asset };
}

test('serialized v2 asset: unique stable identities, surface+world anchors, no negative scales', () => {
  const { asset } = freshAsset();
  assert.equal(asset.format, DISTRIBUTION_FORMAT);
  assert.equal(asset.formatVersion, DISTRIBUTION_FORMAT_VERSION);

  const ids = new Set(asset.instances.map(i => i.instanceId));
  assert.equal(ids.size, asset.instances.length, 'identities must be unique');

  for (const a of asset.instances) {
    assert.ok(a.surfaceAnchor && typeof a.surfaceAnchor.u === 'number');
    assert.ok(a.world && typeof a.world.x === 'number');
    assert.ok(a.scale >= 0, `scale must be non-negative (${a.instanceId})`);
  }
  assert.equal(validateDistributionAsset(asset).ok, true);
});

test('fresh v2 asset re-projects every anchor to its world point (editor/render read migrated data)', () => {
  const { asset } = freshAsset({ sceneId: 'road' });
  const check = validateDistributionAsset(asset);
  assert.equal(check.ok, true, JSON.stringify(check.problems.slice(0, 3)));

  // Render adapter exposes the migrated asset's world data, not sampler internals.
  const render = assetToRenderInstances(asset);
  assert.equal(render.length, asset.instances.length);
  for (let i = 0; i < render.length; i++) {
    assert.equal(render[i].instanceId, asset.instances[i].instanceId);
    assert.equal(render[i].x, asset.instances[i].world.x);
    assert.equal(render[i].z, asset.instances[i].world.z);
  }
});

test('v1 migration at the same surface version: identity + positions preserved, zero deviation', () => {
  const legacy = makeLegacySample({ surfaceVersion: 1 });
  const scene = getScene('road', 1, 1);
  const { asset, report } = migrateDistribution(legacy, { scene });

  assert.equal(asset.instances.length, legacy.instances.length);
  assert.equal(report.identity.retained, legacy.instances.length, 'every legacy id retained');
  assert.equal(report.identity.remapped, 0);
  assert.equal(report.unresolved.length, 0);
  assert.equal(report.deviations.max, 0, 'no model change -> no positional drift');
  assert.equal(report.counts.localStaleAdapted, 0);
  assert.equal(validateDistributionAsset(asset, { scene }).ok, true);
  assert.equal(assetOverlaps(asset), 0, 'migration must not introduce overlaps');

  // Identity preserved exactly and in order.
  const legacyIds = legacy.instances.map(r => r.id);
  const migratedIds = asset.instances.map(r => r.instanceId);
  assert.deepEqual(migratedIds, legacyIds);
});

test('coincidence boundary separates a pre-converted world anchor from stale local coordinates', () => {
  const scene = getScene('road', 1, 1);
  const surfaces = getSurfaces(scene);
  const surface = surfaces.road;
  const onSurface = surface.toWorld(20, 1.0, 0);

  // (A) World anchor: stored world == re-projected local anchor -> reused verbatim.
  const worldAnchor = {
    formatVersion: 1, sceneId: 'road', surfaceVersion: 1,
    instances: [{
      id: 'w-1', type: 'bush', yaw: 0.3, scale: 1.0, surfaceVersion: 1,
      surfaceId: 'road', u: 20, v: 1.0, x: onSurface.x, z: onSurface.z,
    }],
  };
  const a = migrateDistribution(worldAnchor, { scene }).report;
  assert.equal(a.counts.worldAnchorReused, 1);
  assert.equal(a.counts.localStaleAdapted, 0);
  assert.equal(a.counts.localRebased, 0);

  // (B) Stale local coordinates: world position disagrees with the re-projected
  // anchor beyond the boundary -> treated as local coordinates (not reused).
  const staleLocal = {
    formatVersion: 1, sceneId: 'road', surfaceVersion: 1,
    instances: [{
      id: 'l-1', type: 'bush', yaw: 0.3, scale: 1.0, surfaceVersion: 1,
      surfaceId: 'road', u: 20, v: 1.0,
      x: onSurface.x + 0.5, z: onSurface.z + 0.5,
    }],
  };
  const b = migrateDistribution(staleLocal, { scene }).report;
  assert.equal(b.counts.worldAnchorReused, 0);
  assert.ok(b.counts.localRebased + b.counts.localStaleAdapted === 1,
    `expected local treatment, got ${JSON.stringify(b.counts)}`);
  assert.equal(b.boundary, ANCHOR_COINCIDENCE_EPS);
});

test('surface model change: stale world positions are not blindly reused (deviation is measured)', () => {
  // Legacy authored against surface v1; migrate onto surface v2 where the road moved.
  const legacy = makeLegacySample({ surfaceVersion: 1 });
  const sceneV1 = getScene('road', 1, 1);
  const sceneV2 = getScene('road', 1, 2);

  const reportV1 = migrateDistribution(legacy, { scene: sceneV1 }).report;
  const reportV2 = migrateDistribution(legacy, { scene: sceneV2 }).report;

  assert.equal(reportV1.deviations.max, 0);
  // Records that kept local coordinates adapt to the moved surface; their world
  // position shifts, so deviation is non-zero and measurable.
  assert.ok(reportV2.counts.localStaleAdapted > 0, 'some local records must be adapted');
  assert.ok(reportV2.deviations.max > 0, 'adaptation must register a positional deviation');
  assert.ok(reportV2.deviations.perInstance.length === legacy.instances.length);
  for (const d of reportV2.deviations.perInstance) {
    assert.ok(d.deviation >= 0);
    assert.equal(d.aboveThreshold, d.deviation > DEVIATION_WARN);
  }
});

test('mirrored legacy instances (negative scale) migrate with clearance radius + traversability restored', () => {
  const legacy = makeLegacySample({ surfaceVersion: 1 });
  const mirroredLegacy = legacy.instances.filter(r => r.scale < 0);
  assert.ok(mirroredLegacy.length > 0, 'sample must contain negative-scale legacy records');

  const scene = getScene('road', 1, 1);
  const { asset, report } = migrateDistribution(legacy, { scene });

  assert.equal(report.mirrored.count, mirroredLegacy.length);
  for (const c of report.mirrored.checks) {
    assert.equal(c.fromNegativeScale, true);
    assert.equal(c.clearanceRadiusPreserved, true, `${c.instanceId}: radius changed`);
    assert.equal(c.traversabilityRestored, true, `${c.instanceId}: traversability changed`);
  }
  // Migrated records never carry a negative scale; the mirror is explicit.
  for (const a of asset.instances) {
    assert.ok(a.scale >= 0, `${a.instanceId} negative scale leaked`);
  }
  const migratedMirror = asset.instances.filter(a => a.mirrored);
  assert.equal(migratedMirror.length, mirroredLegacy.length);
});

test('records that cannot be located on the new surface are reported, not silently dropped', () => {
  const scene = getScene('road', 1, 2);
  const surfaces = getSurfaces(scene);
  // A world-only coordinate authored on v1 but far from the v2 road.
  const legacy = {
    formatVersion: 1, sceneId: 'road', surfaceVersion: 1,
    instances: [
      { id: 'far-1', type: 'rock', yaw: 0, scale: 1.0, surfaceVersion: 1, surfaceId: 'road', x: 25, z: 25 },
      { id: 'near-1', type: 'rock', yaw: 0, scale: 1.0, surfaceVersion: 1, surfaceId: 'road', x: 0, z: 0 },
    ],
  };
  const { asset, report } = migrateDistribution(legacy, { scene });
  assert.equal(report.unresolved.length, 1, JSON.stringify(report.unresolved));
  assert.equal(report.unresolved[0].id, 'far-1');
  assert.ok(report.unresolved[0].reason.includes('off-surface'));
  // The unlocatable record is excluded from the asset, but the locatable one survives.
  assert.equal(asset.instances.length, 1);
  assert.equal(asset.instances[0].instanceId, 'near-1');
});

test('manual overrides survive migration and are flagged manualOverride', () => {
  const scene = getScene('road', 1, 1);
  const legacy = {
    formatVersion: 1, sceneId: 'road', surfaceVersion: 1,
    manualOverrides: ['manual-1'],
    instances: [
      { id: 'manual-1', type: 'decor', yaw: 0, scale: 1.0, x: 4, z: 6 },
      { id: 'auto-1', type: 'decor', yaw: 0, scale: 1.0, x: -4, z: -6 },
    ],
  };
  const { asset } = migrateDistribution(legacy, { scene });
  const byId = Object.fromEntries(asset.instances.map(i => [i.instanceId, i]));
  assert.equal(byId['manual-1'].manualOverride, true);
  assert.equal(byId['auto-1'].manualOverride, false);
  assert.deepEqual(asset.manualOverrides, ['manual-1']);
});

test('makeInstanceRecord + validate: a manual v2 record round-trips its anchor', () => {
  const scene = getScene('plane', 1);
  const rec = makeInstanceRecord({
    scene, instanceId: 'manual-test', type: 'bush', x: 3.5, z: -2.25, yaw: 0.8, scale: 1.2,
    manualOverride: true,
  });
  const asset = {
    format: DISTRIBUTION_FORMAT, formatVersion: DISTRIBUTION_FORMAT_VERSION, sceneId: 'plane',
    instances: [rec], manualOverrides: ['manual-test'],
  };
  assert.equal(assetToRenderInstances(asset)[0].x, 3.5);
  assert.equal(validateDistributionAsset(asset, { scene }).ok, true);
  assert.equal(rec.manualOverride, true);
});

test('migrating an already-current v2 asset is a no-op', () => {
  const { scene, asset } = freshAsset();
  const { asset: out, report } = migrateDistribution(asset, { scene });
  assert.equal(out.instances.length, asset.instances.length);
  assert.equal(report.unresolved.length, 0);
  assert.deepEqual(out.instances.map(i => i.instanceId), asset.instances.map(i => i.instanceId));
});
