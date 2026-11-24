import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createStore, ensureSignposts, lockedFromSignposts, loadSignposts,
  storeKey, legacyStoreKey, STORE_VERSION,
} from '../src/identity.mjs';
import { getScene } from '../src/terrain.mjs';
import { getSurfaces } from '../src/surface.mjs';
import { sampleScene } from '../src/sampler.mjs';
import { distToPolyline } from '../src/geom2.mjs';

function backingFrom(map) {
  return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) };
}

test('signpost identity is stable across reseeds and sessions (v2 store, persistent backing)', () => {
  const backingMap = new Map();
  const backing = backingFrom(backingMap);
  const scene = getScene('road', 1);
  const surfaces = getSurfaces(scene);

  const run1 = sampleScene({ scene, layoutSeed: 31 });
  const trees1 = run1.instances.filter(i => i.type === 'tree');
  const store1 = createStore(backing);
  const rec1 = ensureSignposts(store1, 'road', trees1, (t) => distToPolyline(t.x, t.z, scene.road.pts), 3,
    { scene, surfaces });
  assert.equal(rec1.list.length, 3);
  assert.equal(rec1.version, STORE_VERSION);
  assert.ok(rec1.list.every(e => e.signpostId.startsWith('SGN-road-')));
  // v2 records keep a surface anchor + world anchor, not bare x/z.
  assert.ok(rec1.list.every(e => e.surfaceAnchor && e.world && e.instanceId));

  // New "session": new store object, same backing; different layout seed.
  const run2 = sampleScene({ scene, layoutSeed: 777 });
  const trees2 = run2.instances.filter(i => i.type === 'tree');
  const store2 = createStore(backing);
  const rec2 = ensureSignposts(store2, 'road', trees2, (t) => distToPolyline(t.x, t.z, scene.road.pts), 3,
    { scene, surfaces });

  assert.deepEqual(rec1, rec2, 'identity record must not change once created');
  assert.ok(backingMap.has(storeKey('road')), 'record is written under the versioned key');

  const locked = lockedFromSignposts(rec2);
  const run3 = sampleScene({ scene, layoutSeed: 12345, locked });
  for (const e of rec2.list) {
    const inst = run3.instances.find(i => i.signpostId === e.signpostId);
    assert.ok(inst, `${e.signpostId} must be present when locked`);
    assert.equal(inst.x, e.world.x);
    assert.equal(inst.z, e.world.z);
    assert.equal(inst.instanceId, e.instanceId, 'stable identity preserved');
  }
});

test('legacy v1 signpost record is migrated to v2 in place, identity preserved', () => {
  const backingMap = new Map();
  const scene = getScene('road', 1);
  const surfaces = getSurfaces(scene);

  // Craft a v1-shaped record under the legacy (unversioned) key.
  const legacy = {
    list: [
      { signpostId: 'SGN-road-01', tree: { id: 'road-tree-1', type: 'tree', x: 3.2, z: -5.1, yaw: 0.4, scale: 1.1 }, createdFrom: 'road-tree-1' },
      { signpostId: 'SGN-road-02', tree: { id: 'road-tree-2', type: 'tree', x: -7.5, z: 2.0, yaw: 1.2, scale: -0.9 }, createdFrom: 'road-tree-2' },
    ],
  };
  backingMap.set(legacyStoreKey('road'), JSON.stringify(legacy));

  const store = createStore(backingFrom(backingMap));
  const loaded = loadSignposts(store, 'road', { scene, surfaces });
  assert.equal(loaded.migrated, true);
  assert.equal(loaded.fromVersion, 1);
  assert.equal(loaded.record.version, STORE_VERSION);
  assert.equal(loaded.record.list.length, 2);

  const [a, b] = loaded.record.list;
  assert.equal(a.instanceId, 'road-tree-1');
  assert.equal(a.world.x, 3.2);
  assert.equal(a.world.z, -5.1);
  assert.ok(a.surfaceAnchor, 'v2 entry gains a surface anchor');
  // Negative legacy scale becomes positive scale + explicit mirror flag.
  assert.equal(b.scale, 0.9);
  assert.equal(b.mirrored, true);
  assert.ok(backingMap.has(storeKey('road')), 'migrated record written under v2 key');

  // A second load is now served from v2 and does not re-migrate.
  const again = loadSignposts(store, 'road', { scene, surfaces });
  assert.equal(again.migrated, false);
  assert.deepEqual(again.record, loaded.record);
});
