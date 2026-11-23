import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Minimal DOM shim: verifies index.html ids match app.mjs wiring and that a full
// generate + render + heatmap + stats pipeline executes without exceptions.

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));

function makeCtx(canvas) {
  return {
    canvas,
    fillStyle: '', strokeStyle: '', font: '', lineWidth: 1,
    fillRect() {}, strokeRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
    closePath() {}, fill() {}, stroke() {}, arc() {}, setLineDash() {},
    fillText() {}, save() {}, restore() {}, clearRect() {},
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData() {},
  };
}

class El {
  constructor(id) {
    this.id = id;
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.value = '1';
    this.checked = false;
    this.textContent = '';
    this._innerHTML = '';
    this.width = 300; this.height = 300;
    this.clientWidth = 800; this.clientHeight = 500;
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  set innerHTML(v) { this._innerHTML = v; }
  get innerHTML() { return this._innerHTML; }
  appendChild(c) { this.children.push(c); return c; }
  prepend(c) { this.children.unshift(c); }
  querySelector() { return new El('q'); }
  querySelectorAll() { return []; }
  addEventListener() {}
  getContext() { return makeCtx(this); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 500 }; }
  get lastChild() { return this.children[this.children.length - 1]; }
}

const registry = new Map();
const dynamicOk = (id) => htmlIds.has(id) || /^dens(v)?-(tree|rock|bush|decor)$/.test(id);

globalThis.document = {
  getElementById(id) {
    if (!dynamicOk(id)) throw new Error(`app.mjs references missing #${id} in index.html`);
    if (!registry.has(id)) registry.set(id, new El(id));
    return registry.get(id);
  },
  createElement: () => new El('dyn'),
  querySelector: (sel) => ({ value: 'lock' }),
  querySelectorAll: () => [],
};
globalThis.window = {
  localStorage: { getItem: () => null, setItem: () => {} },
  addEventListener() {},
};
globalThis.localStorage = globalThis.window.localStorage;
globalThis.requestAnimationFrame = () => {};
globalThis.devicePixelRatio = 1;

test('UI boots: init + generate + full render pipeline runs headless', async () => {
  await import('../src/app.mjs');
  const log = registry.get('log');
  assert.ok(log.children.length > 0, 'log should have entries after boot');
  const stats = registry.get('stats');
  assert.ok(stats.innerHTML.includes('声明间距'), 'stats panel should contain spacing table');
  const clearance = registry.get('clearance');
  assert.ok(clearance.innerHTML.includes('走廊') || clearance.includes('净空'), 'clearance panel filled');
});
