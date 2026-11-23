// Stable identity for player-signposted trees. Persisted via injected storage
// (localStorage in the browser, in-memory in tests).

export function createStore(persist) {
  const mem = new Map();
  return {
    get(k) {
      const v = persist ? persist.getItem(k) : mem.get(k);
      return v ? JSON.parse(v) : null;
    },
    set(k, v) {
      const s = JSON.stringify(v);
      if (persist) persist.setItem(k, s); else mem.set(k, s);
    },
  };
}

// Assign (once) stable signpost identities to the K trees nearest the road.
// Later calls return the stored record unchanged -> identity survives reseeds.
export function ensureSignposts(store, sceneId, trees, distToRoad, k = 3) {
  const key = 'signposts:' + sceneId;
  const existing = store.get(key);
  if (existing) return existing;
  const sorted = [...trees].sort((a, b) => distToRoad(a) - distToRoad(b)).slice(0, k);
  const list = sorted.map((t, i) => ({
    signpostId: `SGN-${sceneId}-${String(i + 1).padStart(2, '0')}`,
    tree: { id: t.id, type: 'tree', x: t.x, z: t.z, yaw: t.yaw, scale: t.scale },
    createdFrom: t.id,
  }));
  const rec = { list };
  store.set(key, rec);
  return rec;
}

// Locked instances injected into the sampler when signposts are locked.
export function lockedFromSignposts(rec) {
  return rec.list.map(e => ({ ...e.tree, signpostId: e.signpostId }));
}
