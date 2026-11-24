// Named placement surfaces. A surface maps stable local coordinates (u = arclength,
// v = signed lateral offset, offset = height above the surface) onto a world anchor.
// Bumping a surface's version models an edit to the underlying geometry: legacy
// local coordinates must then be re-projected and their deviation measured instead
// of reusing world positions that were baked against the old surface.
//
// toLocal() and toWorld() share one segment-normal helper so the round trip is exact
// for points whose nearest projection lies in a segment's interior. That exactness is
// what lets the migration boundary distinguish a pre-converted world anchor from
// stale local coordinates.

import { polylineLength } from './geom2.mjs';

export const SURFACE_VERSION = 1;

export function makePolylineSurface({ id, version = SURFACE_VERSION, pts, heightAt = () => 0 }) {
  const length = polylineLength(pts);
  const segs = [];
  {
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const seg = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-12;
      segs.push({ a, b, seg, acc });
      acc += seg;
    }
  }

  // Locate the segment containing arclength u and return its point + left normal.
  function pointNormalAt(u) {
    const cu = Math.max(0, Math.min(length, u));
    let s = segs[segs.length - 1];
    for (const seg of segs) {
      if (cu <= seg.acc + seg.seg) { s = seg; break; }
    }
    const t = Math.max(0, Math.min(1, (cu - s.acc) / s.seg));
    const tx = (s.b[0] - s.a[0]) / s.seg, tz = (s.b[1] - s.a[1]) / s.seg;
    const px = s.a[0] + tx * t * s.seg, pz = s.a[1] + tz * t * s.seg;
    return { px, pz, nx: -tz, nz: tx };
  }

  return {
    id, version, kind: 'polyline', pts, length, heightAt,

    toWorld(u, v = 0, offset = 0) {
      const { px, pz, nx, nz } = pointNormalAt(u);
      const x = px + nx * v, z = pz + nz * v;
      return { x, y: heightAt(x, z) + offset, z, u: Math.max(0, Math.min(length, u)), v, offset };
    },

    // Inverse of toWorld: nearest arclength + signed lateral offset, using the same
    // segment normal as toWorld.
    toLocal(x, z) {
      let best = { d: Infinity, u: 0 };
      for (const s of segs) {
        const abx = s.b[0] - s.a[0], abz = s.b[1] - s.a[1];
        const t = Math.max(0, Math.min(1, ((x - s.a[0]) * abx + (z - s.a[1]) * abz) / (s.seg * s.seg)));
        const px = s.a[0] + t * abx, pz = s.a[1] + t * abz;
        const d = Math.hypot(x - px, z - pz);
        if (d < best.d) best = { d, u: s.acc + t * s.seg };
      }
      const { px, pz, nx, nz } = pointNormalAt(best.u);
      const v = (x - px) * nx + (z - pz) * nz;
      return { d: best.d, u: best.u, v };
    },
  };
}

// A plane surface: local coordinates are world XZ, so anchoring is identity apart
// from the ground height. Used by scenes with no named placement surface.
export function makeGroundSurface({ version = SURFACE_VERSION, heightAt = () => 0 } = {}) {
  return {
    id: 'ground', version, kind: 'plane',
    toWorld(u, v = 0, offset = 0) {
      return { x: u, y: heightAt(u, v) + offset, z: v, u, v, offset };
    },
    toLocal(x, z) {
      return { d: 0, u: x, v: z };
    },
  };
}

// Surfaces exposed by a scene, keyed by id. A named surface owns placements within
// its influence band; props further away anchor to the ground plane, where local
// coordinates are world-identity and the round trip is always exact.
export const ROAD_INFLUENCE = 6.0;

export function getSurfaces(scene) {
  const out = {};
  const version = scene.surfaceVersion ?? SURFACE_VERSION;
  const heightAt = (x, z) => scene.height(x, z);
  out.ground = makeGroundSurface({ version, heightAt });
  if (scene.road) {
    out.road = makePolylineSurface({ id: 'road', version, pts: scene.road.pts, heightAt });
    out.road.influence = scene.road.influence ?? ROAD_INFLUENCE;
  }
  if (scene.strip) {
    out.strip = makePolylineSurface({ id: 'strip', version, pts: scene.strip.pts, heightAt });
    out.strip.influence = scene.strip.influence ?? scene.strip.half + 4;
  }
  return out;
}

// The surface a fresh or migrated placement should be anchored to. A named surface is
// only chosen when it can represent the point exactly (round trip within ROUNDTRIP_EPS);
// otherwise the point is anchored to the ground plane, whose local coordinates are
// world-identity. This guarantees every stored anchor re-projects to its world point.
export const ROUNDTRIP_EPS = 1e-3;

export function pickSurface(surfaces, x, z) {
  for (const id of ['road', 'strip']) {
    const s = surfaces[id];
    if (!s || s.influence === undefined) continue;
    const loc = s.toLocal(x, z);
    if (loc.d > s.influence) continue;
    const w = s.toWorld(loc.u, loc.v, loc.offset || 0);
    if (Math.hypot(w.x - x, w.z - z) <= ROUNDTRIP_EPS) return s;
  }
  return surfaces.ground;
}
