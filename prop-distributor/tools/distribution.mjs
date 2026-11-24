#!/usr/bin/env node
// Prop-distribution asset CLI. Primary tooling for the distribution format; the
// level-editor viewport is the graphical entry point (see README).
//
//   node tools/distribution.mjs sample --scene road --layout-seed 11 --out asset.json
//   node tools/distribution.mjs migrate --in legacy.json --scene road \
//       --surface-version 2 --out migrated.json [--report report.json]
//   node tools/distribution.mjs verify --in asset.json --scene road
//
// Exit codes: 0 success, 1 invalid input / verification failure, 2 usage error.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { getScene, CURRENT_SURFACE_VERSION } from '../src/terrain.mjs';
import { sampleScene } from '../src/sampler.mjs';
import {
  serializeDistribution, migrateDistribution, validateDistributionAsset, assetOverlaps,
  DISTRIBUTION_FORMAT_VERSION, DEVIATION_WARN,
} from '../src/distribution.mjs';

function usage() {
  return `prop-distribution CLI

  sample   --scene <id> [--layout-seed N] [--terrain-seed N] [--surface-version N]
           [--density tree=1,rock=1] --out <file>
  migrate  --in <legacy.json> --scene <id> [--terrain-seed N] [--surface-version N]
           --out <file> [--report <file>]
  verify   --in <asset.json> --scene <id> [--terrain-seed N] [--surface-version N]

  --surface-version defaults to ${CURRENT_SURFACE_VERSION}; --terrain-seed defaults to 1.
  Exit 0 on success, 1 on invalid input / failed verification, 2 on usage error.`;
}

function die(msg, code = 2) {
  console.error(msg);
  process.exit(code);
}

function sceneFrom(opts, sceneId) {
  const terrainSeed = Number(opts['terrain-seed'] ?? 1);
  const surfaceVersion = Number(opts['surface-version'] ?? CURRENT_SURFACE_VERSION);
  return getScene(sceneId, terrainSeed, surfaceVersion);
}

function parseDensity(s) {
  const out = {};
  if (!s) return out;
  for (const part of s.split(',')) {
    const [k, v] = part.split('=');
    if (k && v !== undefined) out[k.trim()] = Number(v);
  }
  return out;
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(resolve(file), 'utf8'));
  } catch (e) {
    die(`cannot read ${file}: ${e.message}`, 1);
  }
}

async function writeJson(file, obj) {
  const path = resolve(file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

async function cmdSample(opts) {
  if (!opts.scene) return die('sample: --scene required');
  if (!opts.out) return die('sample: --out required');
  const scene = sceneFrom(opts, opts.scene);
  if (!scene.road && !scene.strip) {
    // Ground-surface scenes are valid; nothing special needed.
  }
  const densityScale = parseDensity(opts.density);
  const layoutSeed = opts['layout-seed'] ?? 1;
  const run = sampleScene({ scene, layoutSeed, densityScale });
  const asset = serializeDistribution({
    scene, layoutSeed, terrainSeed: Number(opts['terrain-seed'] ?? 1), densityScale, run,
  });
  const check = validateDistributionAsset(asset, { scene });
  if (!check.ok) {
    console.error('sample: produced invalid asset:');
    for (const p of check.problems.slice(0, 10)) console.error(`  ${p.id}: ${p.problem}`);
    process.exit(1);
  }
  await writeJson(opts.out, asset);
  console.log(`sampled ${asset.instances.length} instances -> ${opts.out} ` +
    `(format v${DISTRIBUTION_FORMAT_VERSION}, surface v${scene.surfaceVersion})`);
}

async function cmdMigrate(opts) {
  if (!opts.in) return die('migrate: --in required');
  if (!opts.scene) return die('migrate: --scene required');
  if (!opts.out) return die('migrate: --out required');
  const scene = sceneFrom(opts, opts.scene);
  const legacy = await readJson(opts.in);
  const { asset, report } = migrateDistribution(legacy, { scene, sceneId: opts.scene });

  const check = validateDistributionAsset(asset, { scene });
  if (!check.ok) {
    console.error('migrate: migrated asset failed validation:');
    for (const p of check.problems.slice(0, 10)) console.error(`  ${p.id}: ${p.problem}`);
    if (!report.unresolved.length) process.exit(1);
  }

  await writeJson(opts.out, asset);
  if (opts.report) await writeJson(opts.report, report);

  const id = report.identity, dev = report.deviations;
  console.log(`migrated ${asset.instances.length}/${id.total} instances -> ${opts.out}`);
  console.log(`  format v${report.sourceVersion} -> v${report.targetVersion}; ` +
    `surface v${report.sourceSurfaceVersion ?? '?'} -> v${report.targetSurfaceVersion ?? '?'}`);
  console.log(`  identity retained ${id.retained}, remapped ${id.remapped}` +
    (report.unresolved.length ? `, unresolved ${report.unresolved.length}` : ''));
  console.log(`  position deviation: max ${dev.max}m, mean ${dev.mean}m, ` +
    `over ${DEVIATION_WARN}m: ${dev.overThreshold.length}`);
  console.log(`  anchors: world-reused ${report.counts.worldAnchorReused}, ` +
    `local-rebased ${report.counts.localRebased}, local-stale-adapted ${report.counts.localStaleAdapted}, ` +
    `world-relocated ${report.counts.worldRelocated}`);
  if (report.mirrored.count) {
    const ok = report.mirrored.checks.every(c => c.clearanceRadiusPreserved && c.traversabilityRestored);
    console.log(`  mirrored instances ${report.mirrored.count}: clearance radius + traversability ` +
      (ok ? 'restored' : 'VIOLATED'));
  }
  const overlaps = assetOverlaps(asset);
  console.log(`  overlaps after migration: ${overlaps}` +
    (overlaps > 0 ? ' (surface-edit adaptation can crowd instances; review before shipping)' : ''));
  for (const u of report.unresolved) console.log(`  UNRESOLVED ${u.id}: ${u.reason}`);

  if (report.unresolved.length) {
    console.error(`migrate: ${report.unresolved.length} record(s) could not be located on the new surface`);
    process.exit(1);
  }
}

async function cmdVerify(opts) {
  if (!opts.in) return die('verify: --in required');
  if (!opts.scene) return die('verify: --scene required');
  const scene = sceneFrom(opts, opts.scene);
  const asset = await readJson(opts.in);
  if (asset.format !== 'prop-distribution' || asset.formatVersion !== DISTRIBUTION_FORMAT_VERSION) {
    console.error(`verify: ${opts.in} is not a v${DISTRIBUTION_FORMAT_VERSION} distribution asset`);
    process.exit(1);
  }
  const check = validateDistributionAsset(asset, { scene });
  const overlaps = assetOverlaps(asset);
  const ids = new Set(asset.instances.map(i => i.instanceId));
  console.log(`asset: ${asset.instances.length} instances, ${ids.size} unique identities`);
  console.log(`  identity: ${ids.size === asset.instances.length ? 'OK' : 'DUPLICATES'}`);
  console.log(`  anchors:  ${check.ok ? 'OK' : 'FAIL'}`);
  console.log(`  overlaps: ${overlaps}`);
  if (!check.ok) for (const p of check.problems.slice(0, 10)) console.log(`  ${p.id}: ${p.problem}`);
  const ok = check.ok && ids.size === asset.instances.length && overlaps === 0;
  if (!ok) {
    console.error('verify: FAILED');
    process.exit(1);
  }
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    console.log(usage());
    process.exit(cmd ? 0 : 2);
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        scene: { type: 'string' },
        out: { type: 'string' },
        in: { type: 'string' },
        report: { type: 'string' },
        'layout-seed': { type: 'string' },
        'terrain-seed': { type: 'string' },
        'surface-version': { type: 'string' },
        density: { type: 'string' },
      },
      allowPositionals: false,
    });
  } catch (e) {
    return die(`usage error: ${e.message}\n\n${usage()}`, 2);
  }
  const opts = parsed.values;
  if (cmd === 'sample') return cmdSample(opts);
  if (cmd === 'migrate') return cmdMigrate(opts);
  if (cmd === 'verify') return cmdVerify(opts);
  return die(`unknown command: ${cmd}\n\n${usage()}`, 2);
}

main().catch((e) => { console.error(e); process.exit(1); });
