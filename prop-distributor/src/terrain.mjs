import { distToPolyline } from './geom2.mjs';
import { MATERIAL_MULT } from './types.mjs';
import { derive, mulberry32 } from './rng.mjs';

// Deterministic value noise driven by the terrain seed.
function makeNoise(seed) {
  const r = mulberry32(derive('terrain', seed));
  const ox = r() * 512, oz = r() * 512;
  const h = (a, b) => {
    const n = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return n - Math.floor(n);
  };
  const single = (x, z) => {
    const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi;
    const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
    return h(xi, zi) * (1 - u) * (1 - v) + h(xi + 1, zi) * u * (1 - v) +
           h(xi, zi + 1) * (1 - u) * v + h(xi + 1, zi + 1) * u * v;
  };
  return (x, z, oct = 3, freq = 0.08) => {
    let amp = 1, sum = 0, norm = 0, f = freq;
    for (let i = 0; i < oct; i++) {
      sum += amp * single((x + ox) * f, (z + oz) * f);
      norm += amp; amp *= 0.5; f *= 2.1;
    }
    return sum / norm;
  };
}

const ROAD_PTS = [[-29, -7], [-16, -3], [-3, 2], [9, -1], [20, 4], [29, 9]];
const STRIP_PTS = [[-29, 0], [-18, 3], [-7, -2], [4, 2], [15, -3], [29, 1]];

export const CURRENT_SURFACE_VERSION = 1;

// A surface edit (version bump) nudges the control polyline. Legacy placements kept
// only local coordinates must be re-projected; baked world anchors would silently
// drift off the new surface.
function shiftPts(pts, version) {
  if (!version || version <= 1) return pts;
  const d = 0.9 * (version - 1);
  return pts.map((p, i) => [p[0] + d * Math.sin(i * 1.7 + version), p[1] + d * 0.6 * Math.cos(i * 1.1)]);
}

export const SCENE_DEFS = {
  plane: { name: '均匀平面（分布验证）' },
  slope: { name: '斜坡 + 材质区（坡度/朝向验证）' },
  strip: { name: '狭长可用区域（小区域策略验证）' },
  road:  { name: '窄路情景（路标锁定 / 推车净空）' },
};

export function getScene(id, terrainSeed = 1, surfaceVersion = CURRENT_SURFACE_VERSION) {
  const noise = makeNoise(terrainSeed);
  const B = { minX: -30, maxX: 30, minZ: -30, maxZ: 30 };
  const rectContains = (x, z) => x >= B.minX && x <= B.maxX && z >= B.minZ && z <= B.maxZ;

  if (id === 'plane') {
    return {
      id, name: SCENE_DEFS.plane.name, bounds: B, surfaceVersion,
      height: () => 0,
      material: () => 'meadow',
      contains: rectContains,
      road: null,
      baseDensity: { tree: 0.004, rock: 0.02, bush: 0.05, decor: 0.03 },
      densityBoost: () => 1,
    };
  }

  if (id === 'slope') {
    const height = (x, z) => 0.16 * x + 1.4 * (noise(x, z, 3, 0.06) - 0.5);
    return {
      id, name: SCENE_DEFS.slope.name, bounds: B, surfaceVersion,
      height,
      material: (x, z) => {
        const n = noise(x + 40, z - 17, 2, 0.05);
        const g = slopeDegAt(height, x, z);
        if (g > 26 || n > 0.68) return 'rock';
        if (n < 0.3) return 'sand';
        return n > 0.52 ? 'forest' : 'meadow';
      },
      contains: rectContains,
      road: null,
      baseDensity: { tree: 0.004, rock: 0.02, bush: 0.05, decor: 0.03 },
      densityBoost: () => 1,
    };
  }

  if (id === 'strip') {
    const half = 2.0;
    const stripPts = shiftPts(STRIP_PTS, surfaceVersion);
    return {
      id, name: SCENE_DEFS.strip.name, bounds: B, surfaceVersion,
      height: (x, z) => 0.5 * (noise(x, z, 2, 0.09) - 0.5),
      material: () => 'meadow',
      strip: { pts: stripPts, half },
      contains: (x, z) => rectContains(x, z) && distToPolyline(x, z, stripPts) <= half,
      road: null,
      baseDensity: { tree: 0, rock: 0.03, bush: 0.08, decor: 0.05 },
      densityBoost: () => 1,
    };
  }

  // road scenario
  const roadHalf = 1.0; // 2.0 m wide road
  const roadPts = shiftPts(ROAD_PTS, surfaceVersion);
  const height = (x, z) => 0.9 * (noise(x, z, 3, 0.05) - 0.5);
  return {
    id: 'road', name: SCENE_DEFS.road.name, bounds: B, surfaceVersion,
    height,
    material: (x, z) => {
      const n = noise(x - 23, z + 51, 2, 0.045);
      if (n > 0.62) return 'forest';
      if (n < 0.3) return 'rock';
      return 'meadow';
    },
    contains: (x, z) => rectContains(x, z) && distToPolyline(x, z, roadPts) > roadHalf,
    road: { pts: roadPts, half: roadHalf },
    baseDensity: { tree: 0.005, rock: 0.025, bush: 0.06, decor: 0.04 },
    // 窄路情景：沿路密度抬升
    densityBoost: (x, z, type) => {
      const d = distToPolyline(x, z, roadPts);
      const s = type === 'tree' ? 0.8 : 1.5;
      const w = type === 'tree' ? 8 : 6;
      return 1 + s * Math.exp(-(d * d) / (w * w));
    },
  };
}

export function slopeDegAt(heightFn, x, z, eps = 0.35) {
  const dx = (heightFn(x + eps, z) - heightFn(x - eps, z)) / (2 * eps);
  const dz = (heightFn(x, z + eps) - heightFn(x, z - eps)) / (2 * eps);
  return Math.atan(Math.hypot(dx, dz)) * 180 / Math.PI;
}

// Density field for a type at a point (0 where the type is excluded by slope/material).
export function densityAt(scene, type, types, x, z) {
  const base = scene.baseDensity[type];
  if (!base) return 0;
  const mat = scene.material(x, z);
  const mult = MATERIAL_MULT[type][mat] ?? 1;
  if (mult <= 0) return 0;
  if (slopeDegAt(scene.height, x, z) > types[type].slopeMax) return 0;
  return base * mult * scene.densityBoost(x, z, type);
}
