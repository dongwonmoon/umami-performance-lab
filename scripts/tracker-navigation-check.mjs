#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const [upstreamArg, trackerArg] = process.argv.slice(2);
if (!upstreamArg || process.argv.includes('--help')) {
  console.error('usage: node scripts/tracker-navigation-check.mjs UPSTREAM [TRACKER_TS_FILE]');
  process.exit(2);
}
const upstream = path.resolve(upstreamArg);
const trackerPath = path.resolve(trackerArg || path.join(upstream, 'src/tracker/index.ts'));
const require = createRequire(import.meta.url);
const ts = require(path.join(upstream, 'node_modules/typescript'));
const transpiled = ts.transpileModule(fs.readFileSync(trackerPath, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  fileName: trackerPath,
  reportDiagnostics: true,
});
const diagnostics = (transpiled.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error);
if (diagnostics.length) throw new Error(`TypeScript transpile failed: ${diagnostics.length} diagnostic(s)`);
const javascript = transpiled.outputText.replace(/\nexport \{\};?\s*$/, '\n');
const tick = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

function harness({ beforeSend, disabled = false } = {}) {
  const listeners = new Map(), requests = [], storage = { disabled };
  let pendingFetch, pendingBeforeSend, href = 'https://site.test/source', navigation, prevented = false;
  const attrs = {
    'data-website-id': '11111111-1111-4111-8111-111111111111',
    'data-auto-pageview': 'false', 'data-before-send': beforeSend ? 'beforeSend' : undefined,
    'data-host-url': 'https://collector.test',
  };
  const currentScript = { getAttribute: name => attrs[name] ?? null };
  const location = {
    origin: 'https://site.test', hostname: 'site.test',
    get href() { return href; }, set href(value) { navigation = value; href = value; },
  };
  const anchor = {
    tagName: 'A', href: 'https://site.test/destination', target: '',
    getAttribute: name => name === 'data-umami-event' ? 'clicked' : null,
    getAttributeNames: () => ['data-umami-event'], closest() { return this; },
  };
  const document = {
    readyState: 'complete', visibilityState: 'visible', title: 'Navigation fixture', referrer: '', currentScript,
    addEventListener(type, callback) {
      const callbacks = listeners.get(type) || [];
      callbacks.push(callback); listeners.set(type, callbacks);
    },
    emit(type, event) { return (listeners.get(type) || []).map(callback => callback(event))[0]; },
  };
  const context = {
    document, history: { pushState() {}, replaceState() {} }, location,
    navigator: { language: 'en-US', doNotTrack: null, msDoNotTrack: null }, screen: { width: 1280, height: 720 },
    top: null, localStorage: { getItem: name => name === 'umami.disabled' && storage.disabled ? '1' : null },
    URL, Promise, setTimeout, clearTimeout,
    fetch(url, options) {
      requests.push({ url, options });
      return new Promise((resolve, reject) => { pendingFetch = { resolve, reject }; });
    },
    console,
  };
  context.top = context; context.window = context;
  context.beforeSend = beforeSend === 'pending'
    ? (_type, payload) => new Promise(resolve => { pendingBeforeSend = () => resolve(payload); })
    : beforeSend === 'cancel' ? () => null
    : beforeSend === 'reject' ? () => { throw new Error('beforeSend rejected'); }
    : undefined;
  vm.runInNewContext(javascript, context, { filename: trackerPath });
  assert.ok(context.umami, 'tracker did not initialize');
  return {
    window: context, requests,
    click() { return document.emit('click', { target: anchor, button: 0, ctrlKey: false, shiftKey: false, metaKey: false, preventDefault() { prevented = true; } }); },
    resolveBeforeSend() { assert.ok(pendingBeforeSend, 'beforeSend was not called'); pendingBeforeSend(); },
    resolveFetch(body = {}) { assert.ok(pendingFetch, 'fetch was not called'); const p = pendingFetch; pendingFetch = undefined; p.resolve({ json: async () => body }); },
    rejectFetch(error = new Error('fetch rejected')) { assert.ok(pendingFetch, 'fetch was not called'); const p = pendingFetch; pendingFetch = undefined; p.reject(error); },
    get navigation() { return navigation; }, get prevented() { return prevented; },
    set disabled(value) { storage.disabled = value; },
  };
}

const passed = [], failed = [];
async function check(name, test) {
  try { await test(); passed.push(name); }
  catch (error) { failed.push({ name, error: error instanceof Error ? error.message : String(error) }); }
}

await check('same-window waits for beforeSend, not response', async () => {
  const h = harness({ beforeSend: 'pending' }), click = h.click();
  await tick(); assert.equal(h.navigation, undefined, 'navigation bypassed beforeSend');
  h.resolveBeforeSend(); await tick();
  assert.equal(h.requests.length, 1, 'fetch was not dispatched');
  assert.equal(h.requests[0].options.keepalive, true, 'dispatch lost keepalive');
  assert.ok(h.prevented, 'same-window click was not prevented');
  assert.equal(h.navigation, 'https://site.test/destination');
  h.resolveFetch({ cache: 'cache-click' }); await click; await tick();
  assert.equal(h.window.umami.getSession().cache, 'cache-click');
});

await check('public track awaits response and handles cache', async () => {
  const h = harness(); let settled = false;
  const first = h.window.umami.track('public').then(() => { settled = true; });
  await tick(); assert.equal(h.requests.length, 1); assert.equal(settled, false, 'public track returned early');
  h.resolveFetch({ cache: 'cache-public' }); await first;
  const second = h.window.umami.track('second'); await tick();
  assert.equal(h.requests[1].options.headers['x-umami-cache'], 'cache-public');
  h.resolveFetch({}); await second;
});

for (const [name, mode] of [['cancelled beforeSend still navigates', 'cancel'], ['rejected beforeSend still navigates', 'reject'], ['disabled tracking still navigates', 'disabled']]) {
  await check(name, async () => {
    const h = harness(mode === 'disabled' ? {} : { beforeSend: mode });
    if (mode === 'disabled') h.disabled = true;
    const click = h.click();
    if (mode === 'reject') await click.catch(() => undefined); else await click;
    assert.equal(h.requests.length, 0); assert.equal(h.navigation, 'https://site.test/destination');
  });
}

await check('non-awaited response rejection is consumed', async () => {
  const h = harness(); let unhandled;
  const onUnhandled = reason => { unhandled = reason; };
  process.once('unhandledRejection', onUnhandled);
  try {
    const click = h.click(); await tick();
    assert.equal(h.navigation, 'https://site.test/destination');
    h.rejectFetch(); await click; await new Promise(resolve => setImmediate(resolve));
    assert.equal(unhandled, undefined);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});

console.log(JSON.stringify({ tracker: trackerPath, upstream, passed, failed,
  expected: 'same-window navigation is dispatched after beforeSend and fetch invocation, before response completion' }, null, 2));
if (failed.length) process.exitCode = 1;
