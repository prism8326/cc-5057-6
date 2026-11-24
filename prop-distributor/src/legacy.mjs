// A deterministic v1 (legacy) prop-distribution sample, used to prove the migrator
// runs an old asset "to completion" and to exercise every legacy representation.
//
// Legacy records deliberately mix representation kinds, because real v1 files did:
//   'both'   local anchor (u,v) + baked world (x,z)  -> classified by the coincidence boundary
//   'local'  local anchor only
//   'world'  baked world position only
// Some records use a negative scale for mirroring (v1 had no explicit flag).

import { sampleScene } from './sampler.mjs';
import { getScene } from './terrain.mjs';
import { getSurfaces, pickSurface } from './surface.mjs';

const KINDS = ['both', 'local', 'world', 'both', 'local', 'world'];

export function makeLegacySample({
  sceneId = 'road', terrainSeed = 1, layoutSeed = 11, surfaceVersion = 1,
} = {}) {
  const scene = getScene(sceneId, terrainSeed, surfaceVersion);
  const surfaces = getSurfaces(scene);
  const run = sampleScene({ scene, layoutSeed });

  const instances = run.instances.map((inst, i) => {
    const kind = KINDS[i % KINDS.length];
    // Each instance lives on the surface that can represent it faithfully; legacy
    // files anchored local-only records the same way.
    const surface = pickSurface(surfaces, inst.x, inst.z);
    const loc = surface.toLocal(inst.x, inst.z);
    const mirrored = i % 5 === 2;
    const scale = mirrored ? -inst.scale : inst.scale;

    const rec = {
      id: inst.id,
      type: inst.type,
      yaw: inst.yaw,
      scale,
      surfaceVersion,
      ...(mirrored ? { mirrored: true } : {}),
    };
    if (kind !== 'world') {
      rec.surfaceId = surface.id;
      rec.u = +loc.u.toFixed(4);
      rec.v = +loc.v.toFixed(4);
    }
    if (kind !== 'local') {
      rec.x = inst.x;
      rec.z = inst.z;
    }
    return rec;
  });

  return {
    format: 'prop-distribution',
    formatVersion: 1,
    sceneId,
    terrainSeed,
    layoutSeed,
    seed: layoutSeed,
    surfaceVersion,
    instances,
  };
}
