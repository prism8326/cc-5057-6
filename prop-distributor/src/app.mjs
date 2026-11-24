import { getScene, SCENE_DEFS } from './terrain.mjs';
import { TYPES, TYPE_ORDER } from './types.mjs';
import { sampleScene, withObb, geoRejectReason, makeGeoCtx } from './sampler.mjs';
import { createStore, ensureSignposts, lockedFromSignposts, loadSignposts, STORE_VERSION } from './identity.mjs';
import { getSurfaces } from './surface.mjs';
import {
  serializeDistribution, validateDistributionAsset, makeInstanceRecord,
  assetToRenderInstances, assetOverlaps, DISTRIBUTION_FORMAT_VERSION,
} from './distribution.mjs';
import { analyzeCorridor, relocateBlockers, resampleAvoidingCorridor } from './clearance.mjs';
import { verifySpacing, overlapViolations, clarkEvans, chiSquareUniform, nnHistogram, layoutHash } from './stats.mjs';
import { makeCamera, renderWorld, clearMeshCache, screenToGround } from './render3d.mjs';
import { drawHeatmap } from './heatmap.mjs';
import { distToPolyline, polylineLength, polylinePointAt, distPointObb } from './geom2.mjs';

const $ = (id) => document.getElementById(id);
const view = $('view3d');
const vctx = view.getContext('2d');
const store = createStore(window.localStorage);

const state = {
  sceneId: 'road', scene: null,
  run: null, asset: null, signRec: null, signposts: [],
  cam: makeCamera(),
  cart: null, cartMargins: null,
  highlight: new Set(),
  selectedSignpost: null,
  heatLayer: 'constraint', heatType: 'bush',
  replay: null,
  lastPick: [],
  showSources: false,
  compare: {},
  status: null,
};

function densityScaleFromUI() {
  const o = {};
  for (const t of TYPE_ORDER) o[t] = parseFloat($('dens-' + t).value);
  return o;
}

function halfNeed() {
  return parseFloat($('cartWidth').value) / 2 + parseFloat($('safety').value);
}

function mode() {
  return document.querySelector('input[name=mode]:checked').value;
}

function log(msg) {
  const el = $('log');
  const line = document.createElement('div');
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.prepend(line);
  while (el.children.length > 60) el.lastChild.remove();
}

function warn(msg) {
  const div = document.createElement('div');
  div.className = 'warn';
  div.textContent = '⚠ ' + msg;
  $('warnings').appendChild(div);
}

function init() {
  const sel = $('sceneSel');
  for (const [id, def] of Object.entries(SCENE_DEFS)) {
    const o = document.createElement('option');
    o.value = id; o.textContent = def.name;
    sel.appendChild(o);
  }
  sel.value = state.sceneId;

  const dens = $('densities');
  for (const t of TYPE_ORDER) {
    const row = document.createElement('label');
    row.innerHTML = `${TYPES[t].label} <input id="dens-${t}" type="range" min="0" max="3" step="0.1" value="1"><span id="densv-${t}">1.0×</span>`;
    dens.appendChild(row);
    row.querySelector('input').addEventListener('input', (e) => {
      $('densv-' + t).textContent = parseFloat(e.target.value).toFixed(1) + '×';
    });
  }

  $('runBtn').onclick = () => regenerate();
  $('replayBtn').onclick = () => startReplay();
  $('reproBtn').onclick = () => reproCheck();
  $('cartBtn').onclick = () => startCart();
  $('compareBtn').onclick = () => compareStrategies();
  $('boostBtn').onclick = () => {
    for (const t of ['rock', 'bush', 'decor']) { $('dens-' + t).value = 1.8; $('densv-' + t).textContent = '1.8×'; }
    log('窄路高密度情景：岩石/灌木/装饰密度 ×1.8');
    regenerate();
  };
  sel.onchange = () => { state.sceneId = sel.value; switchScene(); };
  for (const r of document.querySelectorAll('input[name=mode]')) {
    r.addEventListener('change', () => regenerate());
  }
  $('terrainSeed').onchange = () => switchScene();
  $('showSources').onchange = (e) => { state.showSources = e.target.checked; draw(); };
  $('showCorridor').onchange = () => draw();
  for (const b of document.querySelectorAll('[data-layer]')) {
    b.onclick = () => { state.heatLayer = b.dataset.layer; drawHeat(); };
  }
  $('heatType').onchange = (e) => { state.heatType = e.target.value; drawHeat(); };

  bindCamera();
  switchScene();
}

function switchScene() {
  clearMeshCache();
  state.scene = getScene(state.sceneId, $('terrainSeed').value);
  state.cart = null; state.compare = {}; state.highlight = new Set();
  state.selectedSignpost = null;
  $('signpostInfo').classList.add('hidden');
  $('modeWrap').style.display = state.scene.road ? '' : 'none';
  $('cartPanel').style.display = state.scene.road ? '' : 'none';
  const loaded = loadSignposts(store, state.sceneId, { scene: state.scene, surfaces: getSurfaces(state.scene) });
  state.signRec = loaded.record;
  if (loaded.migrated) {
    log(`实例存储换版：路标记录 v${loaded.fromVersion} → v${STORE_VERSION} 已迁移（键 signposts:v${STORE_VERSION}:${state.sceneId}）`);
  }
  regenerate();
}

function regenerate() {
  const scene = state.scene;
  const layoutSeed = $('layoutSeed').value;
  const densityScale = densityScaleFromUI();

  let locked = [];
  if (scene.road && mode() === 'lock' && state.signRec) {
    locked = lockedFromSignposts(state.signRec);
    log(`锁住路标模式：注入 ${locked.length} 棵挂牌树作为固定约束（${locked.map(l => l.signpostId).join(', ')}）`);
  } else if (scene.road) {
    log('只固定地形种子模式：不锁定任何实例，布局可完全重排以填满可用区域');
  }

  const run = sampleScene({ scene, layoutSeed, densityScale, locked });
  state.cart = null; state.compare = {}; state.highlight = new Set();

  if (scene.road && !state.signRec) {
    const trees = run.instances.filter(i => i.type === 'tree' && !i.locked);
    if (trees.length) {
      state.signRec = ensureSignposts(store, scene.id, trees, (t) => distToPolyline(t.x, t.z, scene.road.pts), 3,
        { scene, surfaces: getSurfaces(scene) });
      log(`已为 ${state.signRec.list.length} 棵靠近道路的树挂上路标并保存稳定身份（存储 v${STORE_VERSION}）`);
    }
  }

  state.asset = serializeDistribution({
    scene, layoutSeed, terrainSeed: Number($('terrainSeed').value), densityScale, run,
    signposts: state.signRec, sceneId: scene.id,
  });

  if (scene.road) {
    state.signposts = (state.signRec?.list || []).map(e => ({
      signpostId: e.signpostId, instanceId: e.instanceId,
      world: e.world, x: e.world.x + 1.1, z: e.world.z + 0.4,
    }));
    if (mode() === 'lock') explainGaps();
  } else {
    state.signposts = [];
  }

  syncAssetToRun(run);
  reportAll();
  log(`生成完成：${state.asset.instances.length} 个实例（分布资产 v${DISTRIBUTION_FORMAT_VERSION}，存储 v${STORE_VERSION}，布局种子 ${layoutSeed}，地形种子 ${$('terrainSeed').value}）`);
}

// Derive the render/editor view of instances from the current asset and carry the
// sampler accounting/events along so stats and replay still work.
function syncAssetToRun(run) {
  const instances = assetToRenderInstances(state.asset);
  state.run = {
    instances,
    accounting: run ? run.accounting : (state.run?.accounting ?? { types: {}, policy: {}, warnings: [] }),
    events: run ? run.events : (state.run?.events ?? []),
  };
  state.status = distributionStatus();
}

// Live validation of the current distribution asset, surfaced in the UI.
function distributionStatus() {
  const check = validateDistributionAsset(state.asset, { scene: state.scene });
  const overlaps = assetOverlaps(state.asset);
  const ids = new Set(state.asset.instances.map(i => i.instanceId));
  return {
    formatVersion: state.asset.formatVersion,
    storeVersion: STORE_VERSION,
    surfaceVersion: state.scene.surfaceVersion,
    count: state.asset.instances.length,
    uniqueIdentity: ids.size === state.asset.instances.length,
    overlaps,
    validation: check,
    assetOk: check.ok && ids.size === state.asset.instances.length && overlaps === 0,
  };
}

// Explainable density gaps around locked trees.
function explainGaps() {
  const scene = state.scene;
  let gapArea = 0, total = 0;
  const cell = 0.5;
  for (let x = scene.bounds.minX; x < scene.bounds.maxX; x += cell) {
    for (let z = scene.bounds.minZ; z < scene.bounds.maxZ; z += cell) {
      if (!scene.contains(x, z)) continue;
      total += cell * cell;
      for (const L of state.signRec.list) {
        if (Math.hypot(L.world.x - x, L.world.z - z) < 2.0 + 0.9) { gapArea += cell * cell; break; }
      }
    }
  }
  log(`可解释密度缺口：${state.signRec.list.length} 棵锁定树的排斥区约 ${gapArea.toFixed(0)} m²（占可用 ${(100 * gapArea / total).toFixed(1)}%），` +
      `位置：${state.signRec.list.map(e => `(${e.world.x.toFixed(0)},${e.world.z.toFixed(0)})`).join(' ')}`);
}

function reportAll() {
  $('warnings').innerHTML = '';
  const { accounting, instances } = state.run;
  for (const w of accounting.warnings) warn(w);

  // Distribution asset status: what the editor and render layer are actually reading.
  const st = state.status || distributionStatus();
  const statusHtml =
    `分布资产 <b>v${st.formatVersion}</b> · 实例存储 <b>v${st.storeVersion}</b> · 表面 <b>v${st.surfaceVersion}</b><br>` +
    `实例 ${st.count} 个，身份唯一 <b class="${st.uniqueIdentity ? 'ok' : 'bad'}">${st.uniqueIdentity ? '是' : '否'}</b>` +
    `，锚点校验 <b class="${st.validation.ok ? 'ok' : 'bad'}">${st.validation.ok ? 'PASS' : 'FAIL'}</b>` +
    `，重叠 <b class="${st.overlaps === 0 ? 'ok' : 'bad'}">${st.overlaps}</b>`;
  $('distStatus').innerHTML = statusHtml;
  if (!st.uniqueIdentity) warn('分布资产存在重复 instanceId：身份保留失败');
  if (!st.validation.ok) warn(`分布资产锚点校验失败 ${st.validation.problems.length} 处：${st.validation.problems[0]?.problem || ''}`);
  if (st.overlaps > 0) warn(`分布资产重叠 ${st.overlaps} 处`);

  // spacing & overlap verification on actual oriented footprints (from migrated asset)
  const sp = verifySpacing(instances);
  const ov = overlapViolations(instances);
  if (sp.violations > 0) warn(`间距违规 ${sp.violations} 处：${sp.details[0] || ''}`);
  if (ov > 0) warn(`重叠违规 ${ov} 处`);

  // clearance
  let clearHtml = '<em>非道路场景：无净空要求</em>';
  if (state.scene.road) {
    const c = analyzeCorridor(state.scene.road.pts, halfNeed(), instances);
    state.clearance = c;
    const corridorArea = c.pathLength * 2 * halfNeed();
    const avail = accounting.policy.availableArea;
    clearHtml = `需求走廊半宽 <b>${halfNeed().toFixed(2)}m</b>（车宽 ${$('cartWidth').value}m + 安全 ${$('safety').value}m）<br>` +
      `路长 ${c.pathLength.toFixed(1)}m，最小净空余量 <b class="${c.minMargin < 0 ? 'bad' : 'ok'}">${c.minMargin.toFixed(2)}m</b> @ ${c.minAt.toFixed(1)}m<br>` +
      `阻挡实例：<b class="${c.blockers.length ? 'bad' : 'ok'}">${c.blockers.length}</b> 个<br>` +
      `受限范围：走廊面积 ${corridorArea.toFixed(0)} m² ≈ 可用面积的 ${(100 * corridorArea / avail).toFixed(1)}%`;
    if (c.minMargin < 0) warn(`局部密度达标但堵住窄路：最小净空 ${c.minMargin.toFixed(2)}m < 0，请用"对比策略"处理`);
  }
  $('clearance').innerHTML = clearHtml;

  // stats panel
  const area = accounting.policy.availableArea;
  const R = clarkEvans(instances, area);
  const chi = chiSquareUniform(instances.filter(i => !i.locked), state.scene.bounds);
  let html = `<table><tr><th>类型</th><th>目标</th><th>达成</th><th>概率采样<br>抽取/通过</th><th>几何过滤<br>接受/拒绝</th><th>主拒因</th></tr>`;
  for (const t of TYPE_ORDER) {
    const a = accounting.types[t];
    if (!a) continue;
    const rej = Object.entries(a.phaseB.rejected).filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1]);
    const rejTotal = Object.values(a.phaseB.rejected).reduce((s, v) => s + v, 0);
    html += `<tr><td>${TYPES[t].label}</td><td>${a.target}</td>` +
      `<td class="${a.achieved < a.target * 0.9 ? 'bad' : 'ok'}">${a.achieved}</td>` +
      `<td>${a.phaseA.uniformDraws}/${a.phaseA.densityAccepted}</td>` +
      `<td>${a.phaseB.accepted}/${rejTotal}</td>` +
      `<td>${rej.length ? rej[0][0] + '×' + rej[0][1] : '—'}</td></tr>`;
  }
  html += `</table>`;
  html += `<div class="note">边界策略：占地完整位于区域内；小区域策略：${accounting.policy.smallRegion ? '已触发（分层网格）' : '未触发（可用面积 ' + area.toFixed(0) + ' m²）'}</div>`;
  html += `<table><tr><th>类型对</th><th>声明间距</th><th>实测最小边距</th><th>判定</th></tr>`;
  for (const p of sp.pairs) {
    html += `<tr><td>${p.pair}</td><td>${p.declared}m</td><td>${p.measured === null ? '—' : p.measured + 'm'}</td>` +
      `<td class="${p.pass ? 'ok' : 'bad'}">${p.pass ? 'PASS' : 'FAIL'}</td></tr>`;
  }
  html += `</table>`;
  html += `<div>重叠检查（有向占地）：<b class="${ov === 0 ? 'ok' : 'bad'}">${ov} 处违规</b></div>`;
  html += `<div>Clark-Evans R = <b>${R ?? '—'}</b>（1=纯随机，&gt;1 表明最小间距生效）` +
    (chi ? `，均匀性 χ² = ${chi.chi2} (df=${chi.df})` : '') + `</div>`;
  html += `<div>布局哈希 <code>${layoutHash(instances)}</code></div>`;
  html += `<div class="note">注：均匀随机数本身不作为空间分布正确的证据；上表间距与统计量均由实际实例的有向占地计算。</div>`;
  $('stats').innerHTML = html;

  drawNNHist();
  drawHeat();
  draw();
}

function drawNNHist() {
  const c = $('nnhist');
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#141a24';
  ctx.fillRect(0, 0, c.width, c.height);
  const { hist, max } = nnHistogram(state.run.instances);
  const peak = Math.max(...hist, 1);
  const bw = c.width / hist.length;
  ctx.fillStyle = '#4f8fcf';
  hist.forEach((v, i) => {
    const h = (v / peak) * (c.height - 14);
    ctx.fillRect(i * bw + 1, c.height - h, bw - 2, h);
  });
  ctx.fillStyle = '#9ab';
  ctx.font = '10px sans-serif';
  ctx.fillText(`最近邻距离分布 (max ${max}m)`, 4, 10);
}

function drawHeat() {
  drawHeatmap($('heatmap'), state.scene, {
    layer: state.heatLayer, selType: state.heatType,
    instances: state.run.instances,
    corridor: state.scene.road && $('showCorridor').checked ? { pts: state.scene.road.pts, half: halfNeed() } : null,
    events: state.replay ? state.run.events : null,
    eventCount: state.replay ? state.replay.i : 0,
    signposts: state.signposts,
    densityScale: parseFloat($('dens-' + state.heatType).value),
  });
}

function visibleInstances() {
  if (!state.replay) return state.run.instances;
  const locked = state.run.instances.filter(i => i.locked);
  const rest = state.run.instances.filter(i => !i.locked);
  let accepts = 0;
  for (let i = 0; i < state.replay.i && i < state.run.events.length; i++) {
    if (state.run.events[i].accepted) accepts++;
  }
  return [...locked, ...rest.slice(0, accepts)];
}

function draw() {
  const opts = {
    signposts: state.signposts,
    selectedSignpost: state.selectedSignpost,
    highlight: state.highlight,
    corridor: state.scene.road && $('showCorridor').checked ? { pts: state.scene.road.pts, half: halfNeed() } : null,
    cart: state.cart ? { s: state.cart.s, width: parseFloat($('cartWidth').value) } : null,
    sources: null,
  };
  if (state.showSources && state.run.events.length) {
    opts.sources = {
      accepted: state.run.events.filter(e => e.accepted),
      rejected: state.run.events.filter(e => !e.accepted),
    };
  }
  const res = renderWorld(vctx, state.cam, state.scene, visibleInstances(), opts);
  state.lastPick = res.signpostScreen;
}

function startReplay() {
  if (!state.run.events.length) return log('没有可回放的采样事件');
  if (state.replay) { state.replay = null; $('replayBtn').textContent = '回放采样过程'; draw(); drawHeat(); return; }
  state.replay = { i: 0 };
  $('replayBtn').textContent = '停止回放';
  const step = Math.max(1, Math.floor(state.run.events.length / 400));
  const timer = setInterval(() => {
    if (!state.replay) { clearInterval(timer); return; }
    state.replay.i += step;
    if (state.replay.i >= state.run.events.length) {
      state.replay = null;
      clearInterval(timer);
      $('replayBtn').textContent = '回放采样过程';
      log(`采样回放结束：概率采样→几何过滤共 ${state.run.events.length} 个几何阶段候选（绿=接受，红=拒绝）`);
    }
    draw(); drawHeat();
  }, 30);
  log('回放采样过程：热力图逐点显示候选（绿=接受，红=被几何过滤拒绝）');
}

function reproCheck() {
  const opts = {
    scene: state.scene, layoutSeed: $('layoutSeed').value,
    densityScale: densityScaleFromUI(),
    locked: state.scene.road && mode() === 'lock' && state.signRec ? lockedFromSignposts(state.signRec) : [],
  };
  const a = sampleScene(opts), b = sampleScene(opts);
  const ha = layoutHash(a.instances), hb = layoutHash(b.instances);
  const same = ha === hb;
  log(`复现校验：两次运行布局哈希 ${ha} / ${hb} → ${same ? '一致 ✓（种子决定可重复结果）' : '不一致 ✗'}`);
  warn(`复现校验：${same ? '通过' : '失败'}`);
}

function startCart() {
  if (!state.scene.road) return;
  if (state.cart) { state.cart = null; return; }
  const L = polylineLength(state.scene.road.pts);
  state.cart = { s: 0, L };
  state.highlight = new Set();
  log(`推车通行开始：车宽 ${$('cartWidth').value}m，需求走廊半宽 ${halfNeed().toFixed(2)}m`);
  const tick = () => {
    if (!state.cart) return;
    state.cart.s += 0.35;
    const s = Math.min(state.cart.s, state.cart.L);
    const p = polylinePointAt(state.scene.road.pts, s);
    let minM = Infinity;
    for (const inst of state.run.instances) {
      minM = Math.min(minM, distPointObb(p[0], p[1], inst.obb) - halfNeed());
    }
    if (minM < 0) {
      const c = analyzeCorridor(state.scene.road.pts, halfNeed(), state.run.instances);
      state.highlight = new Set(c.blockers);
      log(`推车在 ${s.toFixed(1)}m 处被挡：净空余量 ${minM.toFixed(2)}m，${c.blockers.length} 个阻挡实例已标红。可用"对比策略"处理。`);
      warn(`推车被挡 @${s.toFixed(1)}m：局部密度达标但净空不足`);
      state.cart = null;
      draw();
      return;
    }
    if (state.cart.s >= state.cart.L) {
      log(`推车通行完成：全程 ${state.cart.L.toFixed(1)}m 净空达标`);
      state.cart = null;
    }
    draw();
    if (state.cart) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function compareStrategies() {
  if (!state.scene.road) return;
  const c0 = analyzeCorridor(state.scene.road.pts, halfNeed(), state.run.instances);
  const rel = relocateBlockers({
    scene: state.scene, instances: state.run.instances, blockers: c0.blockers,
    pathPts: state.scene.road.pts, halfNeed: halfNeed(), layoutSeed: $('layoutSeed').value,
  });
  const res = resampleAvoidingCorridor({
    scene: state.scene, layoutSeed: $('layoutSeed').value, densityScale: densityScaleFromUI(),
    locked: mode() === 'lock' && state.signRec ? lockedFromSignposts(state.signRec) : [],
    pathPts: state.scene.road.pts, halfNeed: halfNeed(), previous: state.run.instances,
  });
  state.compare = { rel, res, before: c0 };
  const fmt = (x) => (100 * x).toFixed(1) + '%';
  $('strategy').innerHTML = `
    <table><tr><th>策略</th><th>保留物件比例</th><th>移动/删除</th><th>最终最小净空</th><th></th></tr>
    <tr><td>挪动已放物件</td><td>${fmt(rel.retainedRatio)}</td><td>${rel.moved}/${rel.deleted}</td>
      <td class="${rel.clearance.minMargin < 0 ? 'bad' : 'ok'}">${rel.clearance.minMargin.toFixed(2)}m</td>
      <td><button id="applyRel">应用</button></td></tr>
    <tr><td>走廊禁布重采样</td><td>${fmt(res.retainedRatio)}</td><td>—/${state.run.instances.length - Math.round(res.retainedRatio * state.run.instances.length)}</td>
      <td class="${res.clearance.minMargin < 0 ? 'bad' : 'ok'}">${res.clearance.minMargin.toFixed(2)}m</td>
      <td><button id="applyRes">应用</button></td></tr></table>
    <div class="note">处理前最小净空 ${c0.minMargin.toFixed(2)}m，阻挡 ${c0.blockers.length} 个。挪动策略不缩小任何道具尺寸。</div>`;
  $('applyRel').onclick = () => {
    rebuildAssetFromRender(rel.instances, { accounting: state.run.accounting, events: state.run.events });
    state.highlight = new Set();
    log(`已应用"挪动"策略：移动 ${rel.moved}，删除 ${rel.deleted}，保留比例 ${fmt(rel.retainedRatio)}，净空 ${rel.clearance.minMargin.toFixed(2)}m`);
    reportAll();
  };
  $('applyRes').onclick = () => {
    rebuildAssetFromRender(res.instances, { accounting: res.accounting, events: res.events });
    state.highlight = new Set();
    log(`已应用"重采样"策略：保留比例 ${fmt(res.retainedRatio)}，净空 ${res.clearance.minMargin.toFixed(2)}m`);
    if (res.clearance.minMargin < 0) warn('重采样后净空仍不足：密度与净空在该区域不可同时满足，受限范围见净空报告');
    reportAll();
  };
  log(`策略对比完成：挪动保留 ${fmt(rel.retainedRatio)}（净空 ${rel.clearance.minMargin.toFixed(2)}m） vs 重采样保留 ${fmt(res.retainedRatio)}（净空 ${res.clearance.minMargin.toFixed(2)}m）`);
}

// Rebuild the current distribution asset from a render-instance list (e.g. after a
// clearance strategy changed the layout). Identity is preserved by instanceId.
function rebuildAssetFromRender(instances, { accounting, events } = {}) {
  const byId = new Map(state.asset.instances.map(a => [a.instanceId, a]));
  const records = instances.map((inst) => {
    const id = inst.instanceId || inst.id;
    const existing = byId.get(id);
    const rec = makeInstanceRecord({
      scene: state.scene, instanceId: id, type: inst.type,
      x: inst.x, z: inst.z, yaw: inst.yaw, scale: inst.scale, mirrored: !!inst.mirrored,
      locked: !!inst.locked, manualOverride: existing?.manualOverride ?? !!inst.manualOverride,
      signpostId: inst.signpostId || existing?.signpostId,
    });
    return rec;
  });
  state.asset = {
    ...state.asset,
    instances: records,
    manualOverrides: records.filter(r => r.manualOverride).map(r => r.instanceId),
  };
  syncAssetToRun(accounting ? { accounting, events } : undefined);
}

// camera + picking
function bindCamera() {
  let drag = null;
  view.addEventListener('mousedown', (e) => { drag = { x: e.clientX, y: e.clientY, moved: false }; });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    state.cam.yaw += dx * 0.008;
    state.cam.pitch = Math.min(1.45, Math.max(0.25, state.cam.pitch + dy * 0.006));
    drag.x = e.clientX; drag.y = e.clientY;
    draw();
  });
  window.addEventListener('mouseup', (e) => {
    if (drag && !drag.moved) {
      if (e.shiftKey) manualPlace(e);
      else pickSignpost(e);
    }
    drag = null;
  });
  view.addEventListener('wheel', (e) => {
    e.preventDefault();
    state.cam.dist = Math.min(160, Math.max(18, state.cam.dist * (e.deltaY > 0 ? 1.1 : 0.9)));
    draw();
  }, { passive: false });
}

// Manual placement: same geometry filter as the sampler; rejections are surfaced.
function manualPlace(e) {
  const r = view.getBoundingClientRect();
  const mx = (e.clientX - r.left) * devicePixelRatio, my = (e.clientY - r.top) * devicePixelRatio;
  const g = screenToGround(state.cam, view.width, view.height, mx, my, state.scene.height);
  if (!g) return;
  const type = state.heatType;
  const t = TYPES[type];
  state.manualCount = (state.manualCount || 0) + 1;
  const rngSeed = `${$('layoutSeed').value}-manual-${state.manualCount}`;
  let h = 0;
  for (const c of rngSeed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const rand = () => { h = (h * 1664525 + 1013904223) >>> 0; return h / 4294967296; };
  const cand = withObb({
    id: `manual-${type}-${state.manualCount}`, type, x: g[0], z: g[1],
    yaw: rand() * Math.PI * 2, scale: t.scale[0] + rand() * (t.scale[1] - t.scale[0]),
  });
  const ctx = makeGeoCtx(state.scene, []);
  const neighbors = state.run.instances.filter(i => Math.hypot(i.x - g[0], i.z - g[1]) < 9);
  const reason = geoRejectReason(ctx, cand, neighbors);
  if (reason) {
    warn(`手动放置被拒绝（${reason}）：与声明约束冲突，未强行放入`);
    log(`手动放置 ${TYPES[type].label} @(${g[0].toFixed(1)},${g[1].toFixed(1)}) 被拒绝：${reason}`);
    return;
  }
  // Write the manual placement into the distribution asset as a v2 record with an
  // explicit manualOverride, then re-derive render instances from the asset.
  const instanceId = cand.id;
  const rec = makeInstanceRecord({
    scene: state.scene, instanceId, type, x: g[0], z: g[1],
    yaw: cand.yaw, scale: cand.scale, manualOverride: true,
  });
  state.asset = {
    ...state.asset,
    instances: [...state.asset.instances, rec],
    manualOverrides: [...state.asset.manualOverrides, instanceId],
  };
  syncAssetToRun();
  log(`手动放置 ${TYPES[type].label} @(${g[0].toFixed(1)},${g[1].toFixed(1)})，朝向 ${(cand.yaw * 180 / Math.PI).toFixed(0)}°，已写入分布资产（人工覆盖）`);
  reportAll();
}

function pickSignpost(e) {
  const r = view.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  let best = null, bd = 18;
  for (const sp of state.lastPick) {
    const d = Math.hypot(sp.sx - mx, sp.sy - my);
    if (d < bd) { bd = d; best = sp; }
  }
  const info = $('signpostInfo');
  if (!best) { info.classList.add('hidden'); state.selectedSignpost = null; draw(); return; }
  state.selectedSignpost = best.id;
  const rec = state.signRec.list.find(x => x.signpostId === best.id);
  const inst = state.run.instances.find(i => i.instanceId === rec.instanceId || i.signpostId === best.id);
  info.classList.remove('hidden');
  info.innerHTML = `<b>路标 ${best.id}</b><br>` +
    `关联实例：<code>${rec.instanceId}</code>（树）<br>` +
    `位置 (${rec.world.x.toFixed(1)}, ${rec.world.z.toFixed(1)})，朝向 ${(rec.yaw * 180 / Math.PI).toFixed(0)}°，尺寸 ×${rec.scale.toFixed(2)}` +
    (rec.mirrored ? '（镜像）' : '') + `<br>` +
    `表面锚点：${rec.surfaceAnchor.surfaceId} (u=${rec.surfaceAnchor.u}, v=${rec.surfaceAnchor.v})<br>` +
    `身份来源：首次生成时挂牌并持久保存（实例存储 v${STORE_VERSION}），重采种子后身份不变。<br>` +
    (inst ? `当前状态：<span class="ok">在场${inst.locked ? '（已锁定）' : ''}</span>` :
      `当前状态：<span class="bad">不在场</span>（只固定地形种子模式下实例可重排；切回"锁住路标"可恢复在场）`);
  draw();
}

function resize() {
  view.width = view.clientWidth * devicePixelRatio;
  view.height = view.clientHeight * devicePixelRatio;
  draw();
}
window.addEventListener('resize', resize);

init();
resize();

// Exposed for headless verification (smoke test) only.
export const __state = state;
