// User-run HTTP A/B qualification for the visitor sessions endpoint.
// It records compatibility and bounded local timings, not production capacity.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

const ROOT = '/Users/dongwon/workspace/umami-performance-lab';
const BASE = 'http://127.0.0.1:3009';
const CANDIDATE = 'http://127.0.0.1:3010';
const WEBSITE = '18573f23-3e24-44ef-b580-154cf371e7fe';
const COMMIT = 'ca661c7057984aa98ed4f7083d84dae2f65bfcb0';
const CONTAINERS = { baseline: 'umami-visitor-baseline', candidate: 'umami-visitor-candidate', db: 'umami-qualification-db-1' };
const END = new Date('2026-09-06T15:00:00.000Z');
const timeoutMs = 20000;
const args = process.argv.slice(2);
const smoke = args.includes('--smoke');
const check = args.includes('--check');
const concurrent = args.includes('--concurrent');
assert.equal(args.filter(value => !['--smoke', '--check', '--concurrent'].includes(value)).length, 0, 'unknown option');
assert([smoke, check, concurrent].filter(Boolean).length <= 1, 'choose one mode');

const docker = (...command) => execFileSync('docker', command, { encoding: 'utf8' }).trim();
const inspect = name => JSON.parse(docker('inspect', name))[0];
const cases = [
  { name: 'empty', start: new Date('2020-01-01T00:00:00.000Z'), end: new Date('2020-01-02T00:00:00.000Z') },
  { name: '7d-cap10000', days: 7, maxResults: 10000 },
  { name: '30d-cap10000', days: 30, maxResults: 10000 },
  { name: '181d-cap10000', days: 181, maxResults: 10000 },
  { name: '7d-chrome', days: 7, browser: 'eq.Chrome' },
  { name: '7d-page2', days: 7, page: 2 },
];
for (const testCase of cases) {
  if (testCase.days) testCase.start = new Date(+END - testCase.days * 86400000);
  testCase.end ??= END;
  testCase.page ??= 1;
  testCase.pageSize = 20;
}

export function validateShape(body) {
  assert(body && typeof body === 'object' && !Array.isArray(body), 'response is not an object');
  assert(Array.isArray(body.data), 'response data is not an array');
  assert(Number.isSafeInteger(body.count) && body.count >= 0, 'response count is invalid');
  assert(Number.isSafeInteger(body.page) && body.page > 0, 'response page is invalid');
  assert(Number.isSafeInteger(body.pageSize) && body.pageSize > 0, 'response pageSize is invalid');
  assert.equal(typeof body.isCapped, 'boolean', 'response isCapped is invalid');
  assert(!Object.hasOwn(body, 'orderBy'), 'response unexpectedly includes orderBy');
  assert(body.data.length <= body.pageSize, 'too many page rows');
  for (const [i, row] of body.data.entries()) {
    assert.equal(typeof row.id, 'string', 'missing row id');
    assert(Number.isFinite(Date.parse(row.lastAt)), 'invalid lastAt');
    assert(i === 0 || Date.parse(body.data[i - 1].lastAt) >= Date.parse(row.lastAt), 'page not latest-first');
  }
}
export function validateExact(body, oracle) {
  validateShape(body);
  assert(isDeepStrictEqual(body, oracle), 'response differs from frozen baseline oracle');
}
function pathFor(testCase) {
  const params = new URLSearchParams({ startAt: String(+testCase.start), endAt: String(+testCase.end), page: String(testCase.page), pageSize: String(testCase.pageSize) });
  if (testCase.maxResults) params.set('maxResults', String(testCase.maxResults));
  if (testCase.browser) params.set('browser', testCase.browser);
  return `/api/websites/${WEBSITE}/sessions?${params}`;
}
async function get(base, token, testCase) {
  const started = performance.now();
  try {
    const response = await fetch(`${base}${pathFor(testCase)}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
    let body = null;
    try { body = await response.json(); } catch { /* preserve status without raw non-JSON text */ }
    return { status: response.status, body, elapsed_ms: +(performance.now() - started).toFixed(1) };
  } catch (error) {
    return { status: 0, body: null, elapsed_ms: +(performance.now() - started).toFixed(1), error: error instanceof Error ? error.name : String(error) };
  }
}
async function login(base) {
  // Login is intentionally separate so no token is ever written to the result.
  const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'umami' }), signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.json().catch(() => null);
  assert.equal(response.status, 200, `${base} login HTTP ${response.status}`);
  assert.equal(typeof body?.token, 'string', `${base} login token missing`);
  return body.token;
}
function runtime(name) {
  const item = inspect(name);
  let cpuMax = null;
  try { cpuMax = docker('exec', name, 'cat', '/sys/fs/cgroup/cpu.max'); } catch { /* unavailable is recorded */ }
  return { image_id: item.Image, image: item.Config?.Image, labels: { upstream: item.Config?.Labels?.['lab.upstream'] ?? null, variant: item.Config?.Labels?.['lab.variant'] ?? null }, cpu_max: cpuMax, nano_cpus: item.HostConfig?.NanoCpus, cpu_quota: item.HostConfig?.CpuQuota, cpu_period: item.HostConfig?.CpuPeriod, memory_bytes: item.HostConfig?.Memory };
}
function cpuUsec() {
  const match = docker('exec', CONTAINERS.db, 'cat', '/sys/fs/cgroup/cpu.stat').match(/^usage_usec\s+(\d+)$/m);
  assert(match, 'DB cpu.stat usage_usec unavailable');
  return Number(match[1]);
}
function publicSample(result, includeBody = false) {
  const value = { status: result.status, elapsed_ms: result.elapsed_ms, exact_json_equal: result.exact_json_equal ?? null, validation_error: result.validation_error ?? null };
  if (result.error) value.error = result.error;
  if (includeBody || result.validation_error) value.response = result.body;
  return value;
}

function runFour(request) {
  return Promise.all(Array.from({ length: 4 }, () => request()));
}

async function main() {
  if (check) {
    const valid = { data: [], count: 0, page: 1, pageSize: 20, isCapped: false };
    assert.doesNotThrow(() => validateShape(valid));
    assert.throws(() => validateShape({ ...valid, orderBy: undefined }), /orderBy/);
    assert.throws(() => validateShape({ ...valid, count: '0' }), /count/);
    assert.throws(() => validateExact({ ...valid, page: 2 }, valid), /differs/);
    assert.throws(() => validateShape({ ...valid, data: [{ id: 'x', lastAt: 'bad' }] }), /lastAt/);
    assert.throws(() => validateShape({ ...valid, data: [{ id: 'x', lastAt: '2026-01-01' }, { id: 'y', lastAt: '2026-01-02' }] }), /latest-first/);
    const releases = [];
    const batch = runFour(() => new Promise(resolve => releases.push(resolve)));
    assert.equal(releases.length, 4, 'four requests must start before awaiting completion');
    releases.forEach((resolve, i) => resolve(i));
    assert.deepEqual(await batch, [0, 1, 2, 3]);
    console.log('visitor-api-ab --check passed');
    return;
  }

  const output = `${ROOT}/.local/visitor-api-ab-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}.json`;
  mkdirSync(`${ROOT}/.local`, { recursive: true });
  const run = { recorded_at: new Date().toISOString(), status: 'running', output, smoke, concurrent, upstream_commit: COMMIT, website_id: WEBSITE, endpoints: { baseline: BASE, candidate: CANDIDATE }, timeout_ms: timeoutMs, containers: {}, cases: [], warmups: [], blocks: [], errors: [] };
  const save = () => writeFileSync(output, JSON.stringify({ ...run, updated_at: new Date().toISOString() }, null, 2));
  let tokens = {};
  const fail = message => { run.errors.push(message); save(); throw new Error(message); };
  try {
    run.containers = { baseline: runtime(CONTAINERS.baseline), candidate: runtime(CONTAINERS.candidate), db: runtime(CONTAINERS.db) };
    assert.equal(run.containers.baseline.labels.upstream, COMMIT);
    assert.equal(run.containers.candidate.labels.upstream, COMMIT);
    assert.equal(run.containers.baseline.labels.variant, 'baseline');
    assert.equal(run.containers.candidate.labels.variant, 'count-order-only');
    assert.notEqual(run.containers.baseline.image_id, run.containers.candidate.image_id);
    for (const field of ['cpu_max', 'nano_cpus', 'cpu_quota', 'cpu_period', 'memory_bytes']) {
      assert.equal(run.containers.baseline[field], run.containers.candidate[field], `app resource mismatch: ${field}`);
    }
    tokens = { baseline: await login(BASE), candidate: await login(CANDIDATE) };
    const request = async (targetName, testCase, oracle) => {
      const result = await get(targetName === 'baseline' ? BASE : CANDIDATE, tokens[targetName], testCase);
      const checked = { ...result, exact_json_equal: false };
      try {
        if (result.status !== 200) throw new Error(`HTTP ${result.status}`);
        if (oracle) { validateExact(result.body, oracle); checked.exact_json_equal = true; }
        else {
          validateShape(result.body);
          assert.equal(result.body.page, testCase.page);
          assert.equal(result.body.pageSize, testCase.pageSize);
          if (testCase.name === 'empty') {
            assert.equal(result.body.count, 0); assert.equal(result.body.data.length, 0);
          } else {
            assert(result.body.count > 0, 'expected nonempty fixture');
            assert.equal(result.body.data.length, 20, 'expected a full fixture page');
          }
          if (testCase.name === '7d-cap10000') assert.equal(result.body.count, 3403, 'fixed DB changed');
          if (['30d-cap10000', '181d-cap10000'].includes(testCase.name)) assert.equal(result.body.count, 10000);
          assert.equal(result.body.isCapped, !!testCase.maxResults && result.body.count >= testCase.maxResults);
          checked.exact_json_equal = null; // Establishing an oracle, not comparing one.
        }
      } catch (error) { checked.validation_error = error instanceof Error ? error.message : String(error); }
      return checked;
    };
    const initial = concurrent ? cases.filter(c => c.name === '181d-cap10000') : cases;
    for (const testCase of initial) {
      const baseline = await request('baseline', testCase);
      const candidate = baseline.validation_error ? { status: 0, body: null, elapsed_ms: 0, validation_error: 'baseline oracle unavailable', exact_json_equal: false } : await request('candidate', testCase, baseline.body);
      const record = { name: testCase.name, request: { ...testCase, start: testCase.start.toISOString(), end: testCase.end.toISOString() }, baseline: publicSample(baseline, true), candidate: publicSample(candidate) };
      run.cases.push(record); save();
      if (baseline.validation_error || candidate.validation_error) fail(`${testCase.name} initial validation failed`);
    }
    if (smoke) { run.status = 'complete'; return; }

    const selected = concurrent ? initial : cases.filter(testCase => ['7d-cap10000', '30d-cap10000', '181d-cap10000'].includes(testCase.name));
    for (const testCase of selected) for (const targetName of ['baseline', 'candidate']) {
      const sample = await request(targetName, testCase, run.cases.find(item => item.name === testCase.name).baseline.response);
      run.warmups.push({ target: targetName, case: testCase.name, sample: publicSample(sample) }); save();
      if (sample.validation_error) fail(`${targetName}/${testCase.name} warmup failed`);
    }
    for (let round = 0; round < 3; round++) {
      const order = round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
      for (const targetName of order) for (const testCase of selected) {
        const before = cpuUsec();
        const started = performance.now();
        const fetchSample = () => request(targetName, testCase, run.cases.find(item => item.name === testCase.name).baseline.response);
        const samples = concurrent ? await runFour(fetchSample) : [];
        if (!concurrent) for (let index = 0; index < 3; index++) samples.push(await fetchSample());
        const elapsed = performance.now() - started;
        const cpu = cpuUsec() - before;
        const completed = samples.filter(sample => !sample.validation_error).length;
        run.blocks.push({ recorded_at: new Date().toISOString(), kind: concurrent ? 'concurrent' : 'sequential', concurrency: concurrent ? 4 : 1, elapsed_ms: +elapsed.toFixed(1), round: round + 1, target: targetName, case: testCase.name, requests: samples.length, completed_requests: completed, cpu_usec: cpu, cpu_usec_per_request: completed === samples.length ? +(cpu / completed).toFixed(1) : null, samples: samples.map(sample => publicSample(sample)) });
        save();
        if (samples.some(sample => sample.validation_error)) fail(`${targetName}/${testCase.name} timed validation failed`);
      }
    }
    run.status = 'complete';
  } catch (error) {
    run.status = 'failed';
    if (!run.errors.length) run.errors.push(error instanceof Error ? error.message : String(error));
    save();
    process.exitCode = 1;
  } finally {
    tokens = {};
    run.finished = new Date().toISOString();
    if (run.status === 'running') run.status = run.errors.length ? 'failed' : 'complete';
    save();
    console.log(`${run.status}: ${output}`);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
