// Stable identity for player-signposted trees. Persisted via injected storage
// (localStorage in the browser, in-memory in tests).
//
// Storage schema is versioned. v1 stored bare local x/z coordinates in
// `signposts:<sceneId>`. v2 stores a surface anchor + world anchor per entry and
// models mirroring explicitly, under a versioned key. Loading a v1 record migrates
// it in memory (and rewrites it under the v2 key) instead of blindly reusing its
// stale coordinates; identity (signpostId / instanceId) is always preserved.

import { pickSurface } from './surface.mjs';

export const STORE_VERSION = 2;
export const LEGACY_STORE_VERSION = 1;

export function storeKey(sceneId) { return `signposts:v${STORE_VERSION}:${sceneId}`; }
export function legacyStoreKey(sceneId) { return `signposts:${sceneId}`; }

export function createStore(persist) {
  const mem = new Map();
  return {
    get(k) {
      const v = persist ? persist.getItem(k) : mem.get(k);
      if (!v) return null;
      try { return JSON.parse(v); } catch { return null; }
    },
    set(k, v) {
      const s = JSON.stringify(v);
      if (persist) persist.setItem(k, s); else mem.set(k, s);
    },
    remove(k) {
      if (persist) persist.removeItem(k); else mem.delete(k);
    },
  };
}

// Migrate one legacy signpost entry ({ tree:{id,x,z,yaw,scale} }) to v2.
function migrateLegacyEntry(e, surfaces, scene) {
  const t = e.tree || e;
  let scale = t.scale, mirrored = false;
  if (scale < 0) { mirrored = true; scale = -scale; }
  const surface = surfaces ? pickSurface(surfaces, t.x, t.z) : null;
  const anchor = surface
    ? (() => { const loc = surface.toLocal(t.x, t.z); return { surfaceId: surface.id, u: +loc.u.toFixed(4), v: +loc.v.toFixed(4), offset: 0, surfaceVersion: surface.version }; })()
    : null;
  return {
    signpostId: e.signpostId,
    instanceId: t.id ?? e.createdFrom ?? e.signpostId,
    type: t.type || 'tree',
    yaw: t.yaw ?? 0,
    scale,
    mirrored,
    surfaceAnchor: anchor,
    world: { x: t.x, y: sceneHeight(scene, t.x, t.z), z: t.z },
    createdFrom: e.createdFrom ?? t.id,
  };
}

function sceneHeight(scene, x, z) {
  return scene ? scene.height(x, z) : 0;
}

// Load a signpost record, migrating v1 -> v2 if needed.
// opts: { scene, surfaces } (surfaces defaults to scene-derived)
export function loadSignposts(store, sceneId, opts = {}) {
  const v2 = store.get(storeKey(sceneId));
  if (v2) {
    if (v2.version !== STORE_VERSION) {
      throw new Error(`signpost store ${sceneId}: unsupported version ${v2.version}`);
    }
    return { record: v2, migrated: false, fromVersion: STORE_VERSION };
  }

  const legacy = store.get(legacyStoreKey(sceneId));
  if (!legacy) return { record: null, migrated: false, fromVersion: null };

  const surfaces = opts.surfaces || {};
  const list = (legacy.list || []).map(e => migrateLegacyEntry(e, surfaces, opts.scene));
  const record = { version: STORE_VERSION, sceneId, surfaceVersion: opts.scene?.surfaceVersion ?? null, list };
  store.set(storeKey(sceneId), record);
  return { record, migrated: true, fromVersion: legacy.version ?? LEGACY_STORE_VERSION };
}

// Assign (once) stable signpost identities to the K trees nearest the surface.
// Later calls return the stored record unchanged -> identity survives reseeds.
export function ensureSignposts(store, sceneId, trees, distToRoad, k = 3, opts = {}) {
  const loaded = loadSignposts(store, sceneId, opts);
  if (loaded.record) return loaded.record;

  const surfaces = opts.surfaces || null;
  const sorted = [...trees].sort((a, b) => distToRoad(a) - distToRoad(b)).slice(0, k);
  const list = sorted.map((t, i) => {
    let scale = t.scale, mirrored = !!t.mirrored;
    if (scale < 0) { mirrored = true; scale = -scale; }
    const surface = surfaces ? pickSurface(surfaces, t.x, t.z) : null;
    const anchor = surface
      ? (() => { const loc = surface.toLocal(t.x, t.z); return { surfaceId: surface.id, u: +loc.u.toFixed(4), v: +loc.v.toFixed(4), offset: 0, surfaceVersion: surface.version }; })()
      : null;
    return {
      signpostId: `SGN-${sceneId}-${String(i + 1).padStart(2, '0')}`,
      instanceId: t.instanceId || t.id,
      type: 'tree',
      yaw: t.yaw,
      scale,
      mirrored,
      surfaceAnchor: anchor,
      world: { x: t.x, y: sceneHeight(opts.scene, t.x, t.z), z: t.z },
      createdFrom: t.id || t.instanceId,
    };
  });
  const record = { version: STORE_VERSION, sceneId, surfaceVersion: opts.scene?.surfaceVersion ?? null, list };
  store.set(storeKey(sceneId), record);
  return record;
}

// Instances injected into the sampler when signposts are locked. World position is
// authoritative; identity is carried through untouched.
export function lockedFromSignposts(rec) {
  return rec.list.map(e => ({
    id: e.instanceId,
    instanceId: e.instanceId,
    type: e.type || 'tree',
    x: e.world.x,
    z: e.world.z,
    yaw: e.yaw,
    scale: e.scale,
    mirrored: e.mirrored,
    signpostId: e.signpostId,
    surfaceAnchor: e.surfaceAnchor,
  }));
}
