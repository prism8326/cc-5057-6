import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, ensureSignposts, lockedFromSignposts } from '../src/identity.mjs';
import { getScene } from '../src/terrain.mjs';
import { sampleScene } from '../src/sampler.mjs';
import { distToPolyline } from '../src/geom2.mjs';

test('signpost identity is stable across reseeds and sessions (persistent store)', () => {
  const persist = new Map();
  const backing = { getItem: k => persist.get(k) ?? null, setItem: (k, v) => persist.set(k, v) };
  const scene = getScene('road', 1);

  const run1 = sampleScene({ scene, layoutSeed: 31 });
  const trees1 = run1.instances.filter(i => i.type === 'tree');
  const store1 = createStore(backing);
  const rec1 = ensureSignposts(store1, 'road', trees1, (t) => distToPolyline(t.x, t.z, scene.road.pts));
  assert.equal(rec1.list.length, 3);
  assert.ok(rec1.list.every(e => e.signpostId.startsWith('SGN-road-')));

  // New "session": new store object, same backing; different layout seed.
  const run2 = sampleScene({ scene, layoutSeed: 777 });
  const trees2 = run2.instances.filter(i => i.type === 'tree');
  const store2 = createStore(backing);
  const rec2 = ensureSignposts(store2, 'road', trees2, (t) => distToPolyline(t.x, t.z, scene.road.pts));

  assert.deepEqual(rec1, rec2, 'identity record must not change once created');

  const locked = lockedFromSignposts(rec2);
  const run3 = sampleScene({ scene, layoutSeed: 12345, locked });
  for (const e of rec2.list) {
    const inst = run3.instances.find(i => i.signpostId === e.signpostId);
    assert.ok(inst, `${e.signpostId} must be present when locked`);
    assert.equal(inst.x, e.tree.x);
    assert.equal(inst.z, e.tree.z);
  }
});
