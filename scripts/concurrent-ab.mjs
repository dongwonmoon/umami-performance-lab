// Bounded concurrent read benchmark for the disposable local Umami builds.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

const OUT_DIR = new URL('../.local/', import.meta.url);
const variants = { before: 'http://127.0.0.1:3001', after: 'http://127.0.0.1:3002' };
const cases = ['expanded-7d', 'expanded-all'].map(name => {
  const saved = JSON.parse(readFileSync(new URL(`../evidence/2026-09-06/umami-probe-20260906-${name}.json`, import.meta.url), 'utf8'));
  const request = saved.requests.funnel;
  return {
    name, websiteId: saved.websiteId, startDate: saved.startDate, endDate: saved.endDate,
    request: { path: request.path, method: request.method, body: request.body },
    expected: saved.measurements.funnel.response,
  };
});

const arg = name => process.argv.includes(name);
const unknown = process.argv.slice(2).filter(value => !['--smoke', '--check'].includes(value));
assert.equal(unknown.length, 0, `Unknown option(s): ${unknown.join(', ')}`);
const smoke = arg('--smoke');
const check = arg('--check');
const timeoutMs = 10_000;
const blockMs = smoke ? 500 : 10_000;
const repeats = smoke ? 1 : 3;
const concurrencies = [1, 4, 8];

const quantile = (values, q) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return +sorted[Math.ceil(sorted.length * q) - 1].toFixed(1);
};

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const inspect = name => JSON.parse(docker('inspect', name))[0];
const imageMetadata = () => {
  const app = Object.fromEntries(Object.keys(variants).map(variant => {
    const container = inspect(`umami-funnel-${variant}-check`);
    return [variant, { container: container.Id, image_id: container.Image, image: container.Config?.Image }];
  }));
  const db = inspect('umami-qualification-db-1');
  return { app, db: { container: db.Id, image_id: db.Image, image: db.Config?.Image } };
};

const cpuUsage = () => {
  const text = docker('exec', 'umami-qualification-db-1', 'cat', '/sys/fs/cgroup/cpu.stat');
  const match = text.match(/^usage_usec\s+(\d+)$/m);
  assert(match, 'DB cgroup cpu.stat has no usage_usec');
  return Number(match[1]);
};

async function login(base) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'umami' }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  assert.equal(response.status, 200, `${base} login HTTP ${response.status}`);
  const body = await response.json();
  assert.equal(typeof body.token, 'string');
  return { Authorization: `Bearer ${body.token}`, 'Content-Type': 'application/json' };
}

async function request(base, headers, item) {
  const started = performance.now();
  try {
    const response = await fetch(`${base}${item.request.path}`, {
      method: item.request.method, headers, body: item.request.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.json();
    const elapsed = performance.now() - started;
    if (response.status !== 200) return { ok: false, error: `HTTP ${response.status}`, elapsed };
    if (!isDeepStrictEqual(body, item.expected)) return { ok: false, mismatch: true, elapsed };
    return { ok: true, elapsed };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.name : String(error), elapsed: performance.now() - started };
  }
}

export async function runBlock({ concurrency, durationMs, send, now = () => performance.now() }) {
  const started = now();
  const deadline = started + durationMs;
  const latencies = [];
  let launched = 0; let completed = 0; let errors = 0; let mismatches = 0;
  const worker = async () => {
    while (now() < deadline) {
      launched++;
      const result = await send();
      completed++;
      if (result.ok) latencies.push(result.elapsed);
      else if (result.mismatch) mismatches++;
      else errors++;
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsedMs = now() - started;
  return {
    concurrency, duration_ms: durationMs, actual_elapsed_ms: +elapsedMs.toFixed(1),
    launched, completed, successful: latencies.length, errors, mismatches,
    requests_per_sec: +(latencies.length / (elapsedMs / 1000)).toFixed(3),
    p50_ms: quantile(latencies, 0.5), p95_ms: quantile(latencies, 0.95),
    latencies_ms: latencies.map(value => +value.toFixed(3)),
  };
}

const summarize = results => ({
  requests: results.length,
  errors: results.filter(result => !result.ok && !result.mismatch).length,
  mismatches: results.filter(result => result.mismatch).length,
  failures: results.filter(result => !result.ok).map(result => result.error ?? 'response mismatch'),
});
const warmup = (concurrency, send) => Promise.all(Array.from({ length: concurrency }, () => send())).then(summarize);

async function main() {
  if (check) {
    let active = 0; let maxActive = 0; let calls = 0; let clockCalls = 0;
    const result = await runBlock({
      concurrency: 3, durationMs: 15,
      now: () => [0, 0, 0, 0, 10, 10, 10, 10, 20, 20, 20, 20, 30][clockCalls++] ?? 30,
      send: async () => { active++; maxActive = Math.max(maxActive, active); const call = ++calls; await Promise.resolve(); active--; return call === 2 ? { ok: false, error: 'fake error' } : call === 3 ? { ok: false, mismatch: true } : { ok: true, elapsed: 2 }; },
    });
    assert.equal(maxActive, 3, 'fake check should honor the concurrency cap');
    assert(result.actual_elapsed_ms > result.duration_ms, 'fake check should include deterministic drain time');
    assert.equal(result.completed, result.launched);
    assert.equal(result.errors, 1);
    assert.equal(result.mismatches, 1);
    assert.equal(result.successful + result.errors + result.mismatches, result.completed);
    console.log('concurrent-ab --check passed');
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const headers = Object.fromEntries(await Promise.all(Object.entries(variants).map(async ([name, base]) => [name, await login(base)])));
  const metadata = { smoke, run_kind: smoke ? 'smoke-only-not-performance-evidence' : 'bounded-local-measurement', block_ms: blockMs, repeats, concurrencies, timeout_ms: timeoutMs, cases: cases.map(({ name, websiteId, startDate, endDate, request }) => ({ name, websiteId, startDate, endDate, request })), images: imageMetadata() };
  const stamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '');
  const output = new URL(`../.local/concurrent-ab-${stamp}.json`, import.meta.url);
  const run = { recorded_at: new Date().toISOString(), metadata, status: 'running', blocks: [] };
  const checkpoint = () => writeFileSync(output, JSON.stringify({ ...run, updated_at: new Date().toISOString() }, null, 2));
  let failed = false;
  try {
    checkpoint();
    console.log(`Cumulative output: ${output.pathname}`);
    for (const item of cases) for (const concurrency of concurrencies) for (let repeat = 0; repeat < repeats; repeat++) {
      const order = repeat % 2 === 0 ? ['before', 'after'] : ['after', 'before'];
      for (const variant of order) {
        let warmupResult; let cpuBefore; let cpuAfter; let result;
        try { warmupResult = await warmup(concurrency, () => request(variants[variant], headers[variant], item)); } catch (error) { warmupResult = { requests: 0, errors: 1, mismatches: 0, failures: [String(error)] }; }
        try { cpuBefore = cpuUsage(); } catch (error) { warmupResult.failures.push(`CPU before: ${error.message}`); warmupResult.errors++; }
        result = await runBlock({ concurrency, durationMs: blockMs, send: () => request(variants[variant], headers[variant], item) });
        try { cpuAfter = cpuUsage(); } catch (error) { result.cpu_error = `CPU after: ${error.message}`; }
        if (cpuBefore !== undefined && cpuAfter !== undefined) {
          const delta = cpuAfter - cpuBefore;
          if (delta < 0) { result.cpu_error = `negative CPU delta: ${delta}`; failed = true; }
          else { const cpuSeconds = delta / 1e6; result.cpu_usage_usec_delta = delta; result.cpu_seconds = +cpuSeconds.toFixed(6); result.cpu_ms_per_success = result.successful ? +(cpuSeconds * 1000 / result.successful).toFixed(3) : null; }
        }
        const block = { recorded_at: new Date().toISOString(), case: item.name, variant, concurrency, repeat: repeat + 1, order, warmup: warmupResult, result };
        run.blocks.push(block); checkpoint();
        console.log(`${item.name} c=${concurrency} repeat=${repeat + 1}/${repeats} ${variant}: ${result.successful} ok, ${result.errors} errors, ${result.mismatches} mismatches, p50=${result.p50_ms ?? '-'}ms`);
        failed ||= warmupResult.errors > 0 || warmupResult.mismatches > 0 || result.errors > 0 || result.mismatches > 0 || Boolean(result.cpu_error);
      }
    }
  } catch (error) {
    failed = true;
    run.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    run.status = failed ? 'failed' : 'complete'; checkpoint();
  }
  if (failed) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
