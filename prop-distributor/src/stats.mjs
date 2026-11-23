import { obbDist, Grid } from './geom2.mjs';
import { declaredSpacing, spacingPairs } from './types.mjs';
import { fnv1a } from './rng.mjs';

// Verify every declared spacing against actual oriented footprints.
export function verifySpacing(instances) {
  const grid = new Grid(6);
  for (const i of instances) grid.add(i);
  const minSeen = new Map();
  let violations = 0;
  const details = [];
  for (const i of instances) {
    for (const j of grid.query(i.x, i.z, 10)) {
      if (j.id <= i.id) continue;
      const d = obbDist(i.obb, j.obb);
      const key = [i.type, j.type].sort().join('|');
      if (!minSeen.has(key) || d < minSeen.get(key)) minSeen.set(key, d);
      const need = declaredSpacing(i.type, j.type);
      if (d < need - 1e-6) {
        violations++;
        if (details.length < 8) details.push(`${i.id} <-> ${j.id}: ${d.toFixed(2)}m < 声明 ${need}m`);
      }
    }
  }
  const pairs = spacingPairs().map(({ a, b, gap }) => {
    const key = [a, b].sort().join('|');
    const seen = minSeen.get(key);
    return { pair: key, declared: gap, measured: seen === undefined ? null : +seen.toFixed(3), pass: seen === undefined || seen >= gap - 1e-6 };
  });
  return { violations, pairs, details };
}

export function overlapViolations(instances) {
  const grid = new Grid(6);
  for (const i of instances) grid.add(i);
  let n = 0;
  for (const i of instances) {
    for (const j of grid.query(i.x, i.z, 6)) {
      if (j.id <= i.id) continue;
      if (obbDist(i.obb, j.obb) <= 1e-9) n++;
    }
  }
  return n;
}

// Clark-Evans R: 1 = Poisson random, >1 = regular (expected here due to min spacing).
export function clarkEvans(instances, area) {
  const pts = instances;
  const n = pts.length;
  if (n < 3 || area <= 0) return null;
  let sum = 0;
  for (const p of pts) {
    let m = Infinity;
    for (const q of pts) {
      if (p === q) continue;
      m = Math.min(m, Math.hypot(p.x - q.x, p.z - q.z));
    }
    sum += m;
  }
  const meanNN = sum / n;
  return +(meanNN / (0.5 / Math.sqrt(n / area))).toFixed(3);
}

export function chiSquareUniform(instances, bounds, k = 8) {
  const cells = new Array(k * k).fill(0);
  const { minX, maxX, minZ, maxZ } = bounds;
  for (const p of instances) {
    const ix = Math.min(k - 1, Math.floor((p.x - minX) / (maxX - minX) * k));
    const iz = Math.min(k - 1, Math.floor((p.z - minZ) / (maxZ - minZ) * k));
    cells[iz * k + ix]++;
  }
  const expected = instances.length / (k * k);
  if (expected <= 0) return null;
  let chi = 0;
  for (const c of cells) chi += (c - expected) ** 2 / expected;
  return { chi2: +chi.toFixed(1), df: k * k - 1 };
}

export function nnHistogram(instances, bins = 12) {
  const dists = instances.map(p => {
    let m = Infinity;
    for (const q of instances) {
      if (p === q) continue;
      m = Math.min(m, Math.hypot(p.x - q.x, p.z - q.z));
    }
    return m;
  });
  const max = Math.max(1e-6, ...dists);
  const hist = new Array(bins).fill(0);
  for (const d of dists) hist[Math.min(bins - 1, Math.floor(d / max * bins))]++;
  return { hist, max: +max.toFixed(2) };
}

// Deterministic layout fingerprint: same seed must reproduce it exactly.
export function layoutHash(instances) {
  const s = instances
    .map(i => `${i.type}@${i.x.toFixed(4)},${i.z.toFixed(4)},${i.yaw.toFixed(4)},${i.scale.toFixed(4)}`)
    .sort()
    .join(';');
  return fnv1a(s).toString(16);
}
