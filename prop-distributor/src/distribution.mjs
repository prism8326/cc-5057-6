// Prop-distribution asset format and legacy migration.
//
// v2 (current) is a *stable-instance-identity* asset. Every instance carries:
//   - instanceId            stable identity, preserved across seeds and migrations
//   - surfaceAnchor         {surfaceId,u,v,offset,surfaceVersion}: placement in the
//                           surface's own coordinate frame
//   - world                 {x,y,z}: ground anchor derived from the surface anchor
//   - yaw, scale            positive scale + explicit `mirrored` flag (never a
//                           negative scale, which is ambiguous downstream)
//   - manualOverride        whether the placement came from manual editing
//
// v1 (legacy) only has local surface coordinates OR a baked world position (and may
// use a negative scale for mirroring). Migration must not blindly reuse stale world
// coordinates when the surface model changed.
//
// CLASSIFICATION BOUNDARY (ANCHOR_COINCIDENCE_EPS): a legacy record that carries
// both a local anchor and a baked world position is classified by re-projecting the
// local anchor on the LIVE (target) surface:
//   - coincidence within eps  -> the record was pre-converted to a WORLD ANCHOR.
//   - coincidence beyond eps  -> the record still holds stale LOCAL coordinates;
//                                the world position is not trustworthy and the local
//                                coordinates are re-projected onto the new surface.
// This single boundary is what separates "pre-converted world anchor" from "retained
// old local coordinates that need adaptation".

import { TYPES } from './types.mjs';
import { obbFrom, obbDist, distPolylineObb } from './geom2.mjs';
import { getSurfaces, pickSurface } from './surface.mjs';

export const DISTRIBUTION_FORMAT = 'prop-distribution';
export const DISTRIBUTION_FORMAT_VERSION = 2;
export const LEGACY_FORMAT_VERSION = 1;

// Boundary between a pre-converted world anchor and stale local coordinates (m).
export const ANCHOR_COINCIDENCE_EPS = 1e-3;
// Max distance a world-only record may sit off the current surface and still be
// re-anchored. Beyond this, a surface edit makes it unlocatable.
export const LOCATE_BOUND = 6.0;
// Position deviation (m) above which a migrated placement is flagged for review.
export const DEVIATION_WARN = 0.5;

function surfacesFor(scene) {
  return getSurfaces(scene);
}

function resolveSurface(surfaces, surfaceId) {
  if (!surfaceId) return null;
  return surfaces[surfaceId] || null;
}

// Build an anchor for a world point, choosing a surface whose frame represents the
// point exactly (falls back to ground). Guarantees anchor -> world round-trips.
function makeAnchor(x, z, offset = 0, surfaces) {
  const surface = pickSurface(surfaces, x, z);
  const loc = surface.toLocal(x, z);
  return {
    surfaceId: surface.id,
    u: +loc.u.toFixed(4),
    v: +loc.v.toFixed(4),
    offset: +offset.toFixed(4),
    surfaceVersion: surface.version,
  };
}

function worldFromAnchor(surfaces, anchor) {
  const surface = resolveSurface(surfaces, anchor.surfaceId);
  if (!surface) return null;
  return surface.toWorld(anchor.u, anchor.v, anchor.offset || 0);
}

function normalizeMirror(rec) {
  let scale = rec.scale;
  let mirrored = !!rec.mirrored || !!rec.mirrorX;
  if (scale < 0) { mirrored = true; scale = -scale; }
  return { scale: Math.abs(scale), mirrored };
}

function footprintRadius(type, scale) {
  const t = TYPES[type];
  return Math.hypot(t.hx * scale, t.hz * scale);
}

// OBB for an instance at a given world point. Mirroring is visual-only: a centered
// footprint is identical under reflection, so it never changes the OBB.
function obbAt(type, x, z, yaw, scale, mirrored) {
  const t = TYPES[type];
  return obbFrom(x, z, yaw, t.hx * scale, t.hz * scale);
}

// ---- serialization (fresh sampler run -> v2 asset) ----

// Build a single v2 instance record from a world placement.
export function makeInstanceRecord({
  scene, instanceId, type, x, z, yaw = 0, scale = 1, mirrored = false,
  locked = false, manualOverride = false, signpostId = null,
}) {
  const surfaces = surfacesFor(scene);
  const anchor = makeAnchor(x, z, 0, surfaces);
  const rec = {
    instanceId, type, yaw,
    scale: Math.abs(scale),
    mirrored: !!mirrored || scale < 0,
    surfaceAnchor: anchor,
    world: { x, y: scene.height(x, z), z },
    locked: !!locked,
    manualOverride: !!manualOverride,
  };
  if (signpostId) rec.signpostId = signpostId;
  return rec;
}

export function serializeDistribution({
  scene, layoutSeed, terrainSeed = 1, densityScale = {},
  run, manualOverrides = [], signposts = null, sceneId = scene.id,
}) {
  const surfaces = surfacesFor(scene);
  const manualIds = new Set(manualOverrides);

  const instances = run.instances.map((inst, i) => {
    const anchor = makeAnchor(inst.x, inst.z, 0, surfaces);
    const world = { x: inst.x, y: scene.height(inst.x, inst.z), z: inst.z };
    const { scale, mirrored } = normalizeMirror(inst);
    return {
      instanceId: inst.instanceId || inst.id || `${sceneId}-${inst.type}-${i}`,
      type: inst.type,
      yaw: inst.yaw,
      scale,
      mirrored,
      surfaceAnchor: anchor,
      world,
      locked: !!inst.locked,
      manualOverride: !!inst.manualOverride || manualIds.has(inst.id),
      ...(inst.signpostId ? { signpostId: inst.signpostId } : {}),
    };
  });

  return {
    format: DISTRIBUTION_FORMAT,
    formatVersion: DISTRIBUTION_FORMAT_VERSION,
    sceneId,
    terrainSeed,
    layoutSeed,
    surfaceVersion: scene.surfaceVersion ?? null,
    seed: layoutSeed,
    densityScale,
    instances,
    manualOverrides: instances.filter(i => i.manualOverride).map(i => i.instanceId),
    signposts: signposts ? signposts.list || signposts : [],
  };
}

// Render-layer adapter: expose v2 asset instances in the shape the viewport expects.
// Crucially, world coordinates, yaw, scale and mirror all come from the migrated
// asset, not from the raw sampler output.
export function assetToRenderInstances(asset) {
  return asset.instances.map((a) => {
    const x = a.world.x, z = a.world.z;
    const t = TYPES[a.type];
    return {
      id: a.instanceId,
      instanceId: a.instanceId,
      type: a.type,
      x, z, yaw: a.yaw,
      scale: a.scale,
      mirrored: a.mirrored,
      locked: a.locked,
      manualOverride: a.manualOverride,
      signpostId: a.signpostId,
      surfaceAnchor: a.surfaceAnchor,
      world: a.world,
      obb: obbFrom(x, z, a.yaw, t.hx * a.scale, t.hz * a.scale),
      hx: t.hx * a.scale,
      hz: t.hz * a.scale,
    };
  });
}

// ---- legacy migration ----

function legacyWorld(rec) {
  if (typeof rec.x === 'number' && typeof rec.z === 'number') return { x: rec.x, z: rec.z };
  return null;
}

function legacyAnchor(rec) {
  if (rec.surfaceAnchor) return { ...rec.surfaceAnchor };
  if (typeof rec.u === 'number' && typeof rec.v === 'number') {
    return {
      surfaceId: rec.surfaceId || 'ground',
      u: rec.u,
      v: rec.v,
      offset: rec.offset || 0,
      surfaceVersion: rec.surfaceVersion ?? LEGACY_FORMAT_VERSION,
    };
  }
  return null;
}

// Classify a legacy record per the boundary above. The check is performed on the
// LIVE (target) surface: project the record's local anchor there and compare with
// its stored world position. A v1 world position baked before a surface edit will
// therefore fail coincidence and be treated as stale local coordinates - exactly
// the "do not blindly reuse old coordinates when the model changed" rule.
function classify(rec, surfaces) {
  const world = legacyWorld(rec);
  const anchor = legacyAnchor(rec);
  const version = rec.surfaceVersion ?? anchor?.surfaceVersion ?? LEGACY_FORMAT_VERSION;

  if (anchor && world) {
    const surface = resolveSurface(surfaces, anchor.surfaceId);
    if (!surface) return { kind: 'unresolved', reason: `unknown-surface:${anchor.surfaceId}`, world, anchor, version };
    const projected = surface.toWorld(anchor.u, anchor.v, anchor.offset || 0);
    const coincide = Math.hypot(projected.x - world.x, projected.z - world.z);
    if (coincide <= ANCHOR_COINCIDENCE_EPS) {
      return { kind: 'world', world, anchor, coincide, version };
    }
    return { kind: 'local-stale', world, anchor, coincide, version };
  }
  if (anchor) return { kind: 'local', world: null, anchor, version };
  if (world) return { kind: 'world-only', world, anchor: null, version };
  return { kind: 'unresolved', reason: 'no-coordinates', world: null, anchor: null, version };
}

export function migrateDistribution(legacy, { scene, sceneId = scene.id } = {}) {
  if (!legacy || typeof legacy !== 'object') throw new Error('migrateDistribution: missing asset');
  const surfaces = surfacesFor(scene);
  const currentSurfaceVersion = scene.surfaceVersion ?? null;

  if (legacy.format && legacy.format !== DISTRIBUTION_FORMAT) {
    throw new Error(`migrateDistribution: unexpected format ${legacy.format}`);
  }
  if ((legacy.formatVersion ?? LEGACY_FORMAT_VERSION) >= DISTRIBUTION_FORMAT_VERSION) {
    return {
      asset: { ...legacy, sceneId: legacy.sceneId ?? sceneId },
      report: emptyReport(legacy.formatVersion ?? DISTRIBUTION_FORMAT_VERSION, currentSurfaceVersion),
    };
  }

  const records = legacy.instances || [];
  const instances = [];
  const unresolved = [];
  const identity = { total: records.length, retained: 0, remapped: 0, ids: [] };
  const deviations = [];
  const mirrored = { count: 0, checks: [] };
  const counts = { worldAnchorReused: 0, localRebased: 0, worldRelocated: 0, localStaleAdapted: 0 };
  const legacyManual = new Set(legacy.manualOverrides || []);

  records.forEach((rec, i) => {
    const cls = classify(rec, surfaces);
    if (cls.kind === 'unresolved') {
      unresolved.push({
        id: rec.id ?? rec.instanceId ?? `#${i}`,
        reason: cls.reason,
        surfaceVersion: cls.version,
      });
      return;
    }

    const sourceId = rec.instanceId || rec.id || null;
    const instanceId = sourceId || `${sceneId}-${rec.type || 'prop'}-${i}`;

    const { scale, mirrored: isMirror } = normalizeMirror(rec);
    const yaw = rec.yaw ?? 0;
    const modelChanged = currentSurfaceVersion !== null && cls.version !== currentSurfaceVersion;
    let anchor, world, how;

    if (cls.kind === 'world') {
      // Baked world position coincides with the local anchor on the LIVE surface, so
      // the record was already converted to a world anchor: keep it verbatim.
      world = { x: cls.world.x, y: scene.height(cls.world.x, cls.world.z), z: cls.world.z };
      anchor = makeAnchor(world.x, world.z, cls.anchor.offset || 0, surfaces);
      how = 'worldAnchorReused';
    } else if (cls.kind === 'local-stale' || cls.kind === 'local') {
      // Stored local coordinates are authoritative; the baked world position (if any)
      // disagrees because the surface model changed under the record. Adapt by
      // re-projecting the retained local coordinates onto the current surface.
      const w = worldFromAnchor(surfaces, cls.anchor);
      world = w;
      anchor = makeAnchor(w.x, w.z, cls.anchor.offset || 0, surfaces);
      how = cls.kind === 'local-stale' ? 'localStaleAdapted' : 'localRebased';
    } else {
      // world-only: try to locate on the surface the record was authored against (or
      // the nearest named surface). If the surface model changed and the baked world
      // point now falls off that surface, the record cannot be located.
      const hinted = resolveSurface(surfaces, rec.surfaceId);
      const surface = hinted || pickSurface(surfaces, cls.world.x, cls.world.z);
      const loc = surface.toLocal(cls.world.x, cls.world.z);
      if (modelChanged && surface.influence !== undefined && loc.d > LOCATE_BOUND) {
        unresolved.push({
          id: instanceId,
          reason: `off-surface:${loc.d.toFixed(2)}m>${LOCATE_BOUND}m (${surface.id} v${cls.version}->v${surface.version})`,
          surfaceVersion: cls.version,
        });
        return;
      }
      world = { x: cls.world.x, y: scene.height(cls.world.x, cls.world.z), z: cls.world.z };
      anchor = makeAnchor(cls.world.x, cls.world.z, 0, surfaces);
      how = 'worldRelocated';
    }

    counts[how]++;

    if (sourceId) identity.retained++; else identity.remapped++;
    identity.ids.push(instanceId);

    const oldWorld = legacyWorld(rec) || cls.world || null;
    const dev = oldWorld ? Math.hypot(world.x - oldWorld.x, world.z - oldWorld.z) : 0;
    deviations.push({ instanceId, deviation: +dev.toFixed(4), aboveThreshold: dev > DEVIATION_WARN });

    if (isMirror) {
      mirrored.count++;
      // Legacy negative scale had no effect on the centered footprint (it only flipped
      // the winding). Migrated mirroring is visual-only, so clearance radius and the
      // resulting traversability must match the legacy footprint exactly.
      const legacyObb = obbFrom(world.x, world.z, yaw, TYPES[rec.type].hx * rec.scale, TYPES[rec.type].hz * rec.scale);
      const newObb = obbAt(rec.type, world.x, world.z, yaw, scale, true);
      const radius = footprintRadius(rec.type, scale);
      const clearanceRadiusPreserved = Math.abs(footprintRadius(rec.type, rec.scale) - radius) <= 1e-9;

      let traversabilityRestored = true;
      if (scene.road) {
        traversabilityRestored = Math.abs(
          distPolylineObb(scene.road.pts, legacyObb) - distPolylineObb(scene.road.pts, newObb)
        ) <= 1e-6;
      } else {
        traversabilityRestored = obbDist(legacyObb, newObb) <= 1e-9;
      }
      mirrored.checks.push({
        instanceId,
        fromNegativeScale: rec.scale < 0,
        clearanceRadius: +radius.toFixed(4),
        clearanceRadiusPreserved,
        traversabilityRestored,
      });
    }

    instances.push({
      instanceId,
      type: rec.type,
      yaw,
      scale,
      mirrored: isMirror,
      surfaceAnchor: anchor,
      world,
      locked: !!rec.locked,
      manualOverride: !!rec.manualOverride || legacyManual.has(sourceId),
      ...(rec.signpostId ? { signpostId: rec.signpostId } : {}),
      migratedFrom: { kind: cls.kind, how },
    });
  });

  const asset = {
    format: DISTRIBUTION_FORMAT,
    formatVersion: DISTRIBUTION_FORMAT_VERSION,
    sceneId,
    terrainSeed: legacy.terrainSeed ?? 1,
    layoutSeed: legacy.layoutSeed ?? legacy.seed ?? null,
    seed: legacy.seed ?? legacy.layoutSeed ?? null,
    surfaceVersion: currentSurfaceVersion,
    densityScale: legacy.densityScale || {},
    instances,
    manualOverrides: (legacy.manualOverrides || []).filter(id => identity.ids.includes(id)),
    signposts: legacy.signposts || [],
  };

  const report = {
    ...emptyReport(legacy.formatVersion ?? LEGACY_FORMAT_VERSION, currentSurfaceVersion),
    sourceSurfaceVersion: legacy.surfaceVersion ?? null,
    identity,
    boundary: ANCHOR_COINCIDENCE_EPS,
    deviations: {
      max: deviations.length ? Math.max(...deviations.map(d => d.deviation)) : 0,
      mean: deviations.length ? +(deviations.reduce((s, d) => s + d.deviation, 0) / deviations.length).toFixed(4) : 0,
      overThreshold: deviations.filter(d => d.aboveThreshold),
      perInstance: deviations,
    },
    mirrored,
    unresolved,
    counts,
  };
  report.ok = unresolved.length === 0
    && mirrored.checks.every(c => c.clearanceRadiusPreserved && c.traversabilityRestored);
  return { asset, report };
}

function emptyReport(from, to) {
  return {
    sourceVersion: from,
    targetVersion: DISTRIBUTION_FORMAT_VERSION,
    sourceSurfaceVersion: null,
    targetSurfaceVersion: to,
    identity: { total: 0, retained: 0, remapped: 0, ids: [] },
    boundary: ANCHOR_COINCIDENCE_EPS,
    deviations: { max: 0, mean: 0, overThreshold: [], perInstance: [] },
    mirrored: { count: 0, checks: [] },
    unresolved: [],
    counts: { worldAnchorReused: 0, localRebased: 0, worldRelocated: 0, localStaleAdapted: 0 },
    ok: true,
  };
}

// ---- validation of a migrated asset against the live scene ----

export function validateDistributionAsset(asset, { scene } = {}) {
  const surfaces = scene ? surfacesFor(scene) : null;
  const problems = [];
  const seen = new Set();
  for (const a of asset.instances) {
    if (seen.has(a.instanceId)) problems.push({ id: a.instanceId, problem: 'duplicate-identity' });
    seen.add(a.instanceId);

    if (a.scale < 0) problems.push({ id: a.instanceId, problem: 'negative-scale' });
    if (Math.abs(a.scale) === 0) problems.push({ id: a.instanceId, problem: 'zero-scale' });

    if (surfaces) {
      const surface = resolveSurface(surfaces, a.surfaceAnchor?.surfaceId);
      if (a.surfaceAnchor && !surface) {
        problems.push({ id: a.instanceId, problem: `unknown-surface:${a.surfaceAnchor.surfaceId}` });
      } else if (surface) {
        const w = worldFromAnchor(surfaces, a.surfaceAnchor);
        const d = Math.hypot(w.x - a.world.x, w.z - a.world.z);
        if (d > ANCHOR_COINCIDENCE_EPS) {
          problems.push({ id: a.instanceId, problem: `anchor-world-mismatch:${d.toFixed(4)}m` });
        }
      }
    }
    if (scene) {
      const [minX, maxX, minZ, maxZ] = [scene.bounds.minX, scene.bounds.maxX, scene.bounds.minZ, scene.bounds.maxZ];
      if (a.world.x < minX || a.world.x > maxX || a.world.z < minZ || a.world.z > maxZ) {
        problems.push({ id: a.instanceId, problem: 'outside-bounds' });
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

// Count overlapping footprints in the migrated asset (identity-preserving check).
export function assetOverlaps(asset) {
  const render = assetToRenderInstances(asset);
  let n = 0;
  for (let i = 0; i < render.length; i++) {
    for (let j = i + 1; j < render.length; j++) {
      if (obbDist(render[i].obb, render[j].obb) <= 1e-9) n++;
    }
  }
  return n;
}
