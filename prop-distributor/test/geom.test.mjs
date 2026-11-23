import test from 'node:test';
import assert from 'node:assert/strict';
import { obbFrom, obbDist, obbCorners, distPointObb } from '../src/geom2.mjs';

// Brute-force reference: dense sampling of both rectangles' boundaries.
function bruteDist(a, b) {
  const pts = (o) => {
    const cs = obbCorners(o), out = [];
    for (let i = 0; i < 4; i++) {
      const A = cs[i], B = cs[(i + 1) % 4];
      for (let t = 0; t <= 40; t++) {
        out.push([A[0] + (B[0] - A[0]) * t / 40, A[1] + (B[1] - A[1]) * t / 40]);
      }
    }
    return out;
  };
  const pa = pts(a), pb = pts(b);
  let m = Infinity;
  for (const p of pa) m = Math.min(m, distPointObb(p[0], p[1], b));
  for (const p of pb) m = Math.min(m, distPointObb(p[0], p[1], a));
  return m;
}

test('obbDist matches brute force for random oriented boxes', () => {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 60; i++) {
    const a = obbFrom(rnd() * 20 - 10, rnd() * 20 - 10, rnd() * Math.PI, 0.3 + rnd(), 0.3 + rnd());
    const b = obbFrom(rnd() * 20 - 10, rnd() * 20 - 10, rnd() * Math.PI, 0.3 + rnd(), 0.3 + rnd());
    const exact = obbDist(a, b);
    const brute = bruteDist(a, b);
    assert.ok(Math.abs(exact - brute) < 0.03, `case ${i}: exact=${exact} brute=${brute}`);
  }
});

test('orientation changes footprint clearance (center distance is not enough)', () => {
  // Two 2.0 x 0.2 boxes, centers 1.2 apart on x. Axis-aligned: gap = 1.2 - 1.0 - 1.0 <0 overlap...
  // Use long boxes rotated 45deg: center distance stays, edge distance changes.
  const a = obbFrom(0, 0, 0, 1.0, 0.1);
  const bAxis = obbFrom(2.2, 0, 0, 1.0, 0.1);
  const bRot = obbFrom(2.2, 0, Math.PI / 4, 1.0, 0.1);
  const dAxis = obbDist(a, bAxis);
  const dRot = obbDist(a, bRot);
  assert.ok(Math.abs(dAxis - 0.2) < 1e-9, `axis gap ${dAxis}`);
  assert.ok(dRot > dAxis + 0.2, `rotated gap ${dRot} should exceed axis gap ${dAxis}`);
});

test('overlapping boxes have zero distance', () => {
  const a = obbFrom(0, 0, 0.3, 1, 1);
  const b = obbFrom(0.5, 0.2, 1.1, 1, 1);
  assert.equal(obbDist(a, b), 0);
});
