import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeLegacySample } from '../src/legacy.mjs';

const CLI = fileURLToPath(new URL('../tools/distribution.mjs', import.meta.url));

function cleanDir() { return mkdtempSync(join(tmpdir(), 'propdist-')); }

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

// Legacy input is generated programmatically (makeLegacySample), never hand-edited:
// the conversion evidence does not depend on hand-crafted data.
function writeLegacy(dir, opts = {}) {
  const file = join(dir, 'legacy.json');
  writeFileSync(file, JSON.stringify(makeLegacySample(opts)));
  return file;
}

test('CLI sample + verify in a clean directory', () => {
  const dir = cleanDir();
  const out = join(dir, 'asset.json');
  const s = run(['sample', '--scene', 'road', '--layout-seed', '11', '--out', out]);
  assert.equal(s.status, 0, s.stderr);
  assert.ok(existsSync(out));
  const asset = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(asset.formatVersion, 2);
  assert.equal(new Set(asset.instances.map(i => i.instanceId)).size, asset.instances.length);

  const v = run(['verify', '--in', out, '--scene', 'road']);
  assert.equal(v.status, 0, v.stdout + v.stderr);
  assert.match(v.stdout, /identity: OK/);
  assert.match(v.stdout, /anchors:\s+OK/);
  assert.match(v.stdout, /overlaps: 0/);
});

test('CLI migrate at unchanged surface: zero deviation, full identity retention (execution evidence)', () => {
  const dir = cleanDir();
  const legacy = writeLegacy(dir, { surfaceVersion: 1 });
  const out = join(dir, 'migrated.json');
  const reportFile = join(dir, 'report.json');

  const m = run(['migrate', '--in', legacy, '--scene', 'road', '--surface-version', '1',
    '--out', out, '--report', reportFile]);
  assert.equal(m.status, 0, m.stderr);

  const report = JSON.parse(readFileSync(reportFile, 'utf8'));
  assert.equal(report.deviations.max, 0, 'no model change -> zero positional deviation');
  assert.equal(report.identity.remapped, 0, 'every legacy identity retained');
  assert.equal(report.unresolved.length, 0);
  assert.equal(report.mirrored.count > 0, true);
  assert.ok(report.mirrored.checks.every(c => c.clearanceRadiusPreserved && c.traversabilityRestored));

  const v = run(['verify', '--in', out, '--scene', 'road', '--surface-version', '1']);
  assert.equal(v.status, 0, v.stdout + v.stderr);
});

test('CLI migrate after a surface edit reports measured deviation without blind reuse', () => {
  const dir = cleanDir();
  const legacy = writeLegacy(dir, { surfaceVersion: 1 });
  const out = join(dir, 'migrated-v2.json');
  const reportFile = join(dir, 'report-v2.json');

  const m = run(['migrate', '--in', legacy, '--scene', 'road', '--surface-version', '2',
    '--out', out, '--report', reportFile]);
  assert.equal(m.status, 0, m.stderr);

  const report = JSON.parse(readFileSync(reportFile, 'utf8'));
  assert.equal(report.sourceSurfaceVersion, 1);
  assert.equal(report.targetSurfaceVersion, 2);
  assert.ok(report.counts.localStaleAdapted > 0, 'stale local coordinates adapted');
  assert.ok(report.deviations.max > 0, 'adaptation registers positional deviation');
  assert.equal(report.identity.remapped, 0);
});

test('CLI reports unlocatable records and exits non-zero (no silent drop / no false pass)', () => {
  const dir = cleanDir();
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, JSON.stringify({
    formatVersion: 1, sceneId: 'road', surfaceVersion: 1,
    instances: [
      { id: 'far', type: 'rock', yaw: 0, scale: 1, surfaceVersion: 1, surfaceId: 'road', x: 29, z: 29 },
      { id: 'ok', type: 'rock', yaw: 0, scale: 1, surfaceVersion: 1, surfaceId: 'road', x: 1, z: -4 },
    ],
  }));
  const out = join(dir, 'out.json');
  const m = run(['migrate', '--in', bad, '--scene', 'road', '--surface-version', '2', '--out', out]);
  assert.equal(m.status, 1, 'unlocatable record must fail the migration');
  assert.match(m.stdout, /UNRESOLVED far/);
});

test('CLI verify rejects a malformed asset with negative scale (exit 1)', () => {
  const dir = cleanDir();
  const bad = join(dir, 'mal.json');
  writeFileSync(bad, JSON.stringify({
    format: 'prop-distribution', formatVersion: 2, sceneId: 'road',
    instances: [{ instanceId: 'x', type: 'rock', yaw: 0, scale: -1, world: { x: 0, z: 0 }, surfaceAnchor: null }],
  }));
  const v = run(['verify', '--in', bad, '--scene', 'road']);
  assert.equal(v.status, 1);
  assert.match(v.stdout + v.stderr, /negative-scale/);
});
