// Compare the journey API builds against the pinned, parsed SQL oracle.
// This measures localhost HTTP + response parsing; it is not a capacity claim.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

const BASE = 'http://127.0.0.1:3007';
const CANDIDATE = 'http://127.0.0.1:3008';
const CONTAINERS = { baseline: 'umami-journey-baseline', candidate: 'umami-journey-candidate', db: 'umami-qualification-db-1' };
const WEBSITE = '18573f23-3e24-44ef-b580-154cf371e7fe';
const COMMIT = 'ca661c7057984aa98ed4f7083d84dae2f65bfcb0';
const timeoutMs = 20000;
const args = process.argv.slice(2);
const smoke = args.includes('--smoke');
const check = args.includes('--check');
const paths = args.filter(value => !value.startsWith('--'));
assert.equal(args.filter(value => value.startsWith('--') && !['--smoke', '--check'].includes(value)).length, 0, 'unknown option');
assert.equal(paths.length, check ? 0 : 1, check ? '--check takes no oracle path' : 'oracle JSON path is required');

const stable = value => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? `${item}n` : item);
const rowsKey = row => stable(row);
const canonical = rows => rows.map(rowsKey).sort();
const docker = (...command) => execFileSync('docker', command, { encoding: 'utf8' }).trim();
const inspect = name => JSON.parse(docker('inspect', name))[0];
const sampleRecord = sample => ({ status: sample.status, elapsed_ms: sample.elapsed_ms, validation_error: sample.validation_error ?? null, exact_json_equal: sample.exact_json_equal, ...(sample.validation_error ? { error: sample.error ?? null, response: sample.response ?? null } : {}) });

export function validateResponse(response, oracleRows) {
  const expected = oracleRows.slice(0, 100);
  assert.equal(response.length, Math.min(100, oracleRows.length), 'unexpected top100 length');
  const counts = response.map(row => Number(row.count));
  assert(counts.every((count, index) => index === 0 || counts[index - 1] >= count), 'counts are not descending');
  assert.deepEqual(counts, expected.map(row => Number(row.count)), 'count vector differs from oracle top100');
  const available = new Map();
  for (const row of oracleRows) available.set(rowsKey(row), (available.get(rowsKey(row)) ?? 0) + 1);
  for (const row of response) {
    const remaining = available.get(rowsKey(row)) ?? 0;
    assert(remaining > 0, 'response row is not a multiset subset of oracle rows');
    available.set(rowsKey(row), remaining - 1);
  }
  if (new Set(oracleRows.map(row => row.count)).size === oracleRows.length) {
    assert.deepEqual(response, expected, 'Untied results must match exactly');
  }
  return { expected_length: expected.length, descending_counts: true, count_vector_equal: true, row_multiset_subset: true };
}

function bodyFor(testCase) {
  const filters = testCase.filters?.browser ? { browser: 'eq.Chrome' } : {};
  const parameters = { ...testCase.parameters };
  if (testCase.filters?.eventType !== undefined) parameters.eventType = testCase.filters.eventType;
  return { websiteId: WEBSITE, type: 'journey', parameters, filters };
}
function validateOracle(oracle) {
  assert.equal(oracle.status, 'complete', 'oracle is not complete');
  assert.equal(oracle.oracle, true, 'oracle JSON was not produced with --oracle');
  assert.equal(oracle.upstream_commit, COMMIT, 'oracle upstream commit mismatch');
  assert.equal(oracle.website_id, WEBSITE, 'oracle website mismatch');
  assert(Array.isArray(oracle.cases) && oracle.cases.length > 0, 'oracle has no cases');
  for (const testCase of oracle.cases) {
    assert(testCase.name && testCase.parameters?.startDate && testCase.parameters?.endDate, 'oracle case missing identity/date parameters');
    assert(Number.isInteger(Number(testCase.parameters.steps)), `${testCase.name} has invalid steps`);
    assert(Array.isArray(testCase.baseline) && Array.isArray(testCase.candidate), `${testCase.name} lacks parsed oracle rows`);
    assert(isDeepStrictEqual(canonical(testCase.baseline), canonical(testCase.candidate)), `${testCase.name} oracle canonical rows differ`);
    for (const rows of [testCase.baseline, testCase.candidate]) {
      const counts = rows.map(row => Number(row.count));
      assert(counts.every(count => Number.isSafeInteger(count) && count > 0), 'Invalid oracle count');
      assert(counts.every((count, index) => index === 0 || counts[index - 1] >= count), `${testCase.name} oracle counts are not descending`);
    }
    if (testCase.filters?.eventType !== undefined) assert([1, 2].includes(Number(testCase.filters.eventType)), `${testCase.name} invalid eventType`);
    if (testCase.filters?.browser !== undefined) assert.equal(testCase.filters.browser, 'Chrome', `${testCase.name} unexpected browser filter`);
  }
}

async function post(base, path, body, token) {
  const started = performance.now();
  try {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    let parsed = null;
    try { parsed = await response.json(); } catch { /* preserve non-JSON HTTP errors without raw bodies */ }
    return { status: response.status, body: parsed, elapsed_ms: +(performance.now() - started).toFixed(1) };
  } catch (error) {
    return { status: 0, body: null, elapsed_ms: +(performance.now() - started).toFixed(1), error: error instanceof Error ? error.name : String(error) };
  }
}
async function login(base) {
  const result = await post(base, '/api/auth/login', { username: 'admin', password: 'umami' });
  assert.equal(result.status, 200, `${base} login HTTP ${result.status}`);
  assert.equal(typeof result.body?.token, 'string', `${base} login token missing`);
  return result.body.token;
}
function runtime(name) {
  const item = inspect(name);
  let cpuMax = null;
  try { cpuMax = docker('exec', name, 'cat', '/sys/fs/cgroup/cpu.max'); } catch { /* record unavailable rather than inventing a limit */ }
  return { image_id: item.Image, image: item.Config?.Image, labels: { upstream: item.Config?.Labels?.['lab.upstream'] ?? null, variant: item.Config?.Labels?.['lab.variant'] ?? null }, cpu_max: cpuMax, nano_cpus: item.HostConfig?.NanoCpus, cpu_quota: item.HostConfig?.CpuQuota, cpu_period: item.HostConfig?.CpuPeriod, memory_bytes: item.HostConfig?.Memory };
}
function cpuUsec() { const match = docker('exec', CONTAINERS.db, 'cat', '/sys/fs/cgroup/cpu.stat').match(/^usage_usec\s+(\d+)$/m); assert(match, 'DB cpu.stat usage_usec unavailable'); return Number(match[1]); }

async function main() {
  if (check) {
    const rows = [{ items: ['/a'], count: 10 }, { items: ['/b'], count: 10 }, { items: ['/c'], count: 9 }];
    assert.doesNotThrow(() => validateResponse(rows, rows));
    assert.throws(() => validateResponse([{ items: ['/a'], count: 8 }, rows[1], rows[2]], rows), /counts|count vector/);
    assert.throws(() => validateResponse([rows[1], rows[2], rows[2]], rows), /count vector/);
    assert.throws(() => validateResponse([rows[0], rows[0], rows[2]], rows), /multiset subset/);
    const cutoffRows = Array.from({ length: 102 }, (_, index) => ({ items: [`/${index}`], count: index < 99 ? 300 - index : index === 99 || index === 100 ? 100 : 99 }));
    const swappedCutoff = cutoffRows.slice(0, 99).concat(cutoffRows[100]);
    assert.doesNotThrow(() => validateResponse(swappedCutoff, cutoffRows));
    assert.throws(() => validateResponse(cutoffRows.slice(0, 99).concat(cutoffRows[101]), cutoffRows), /count vector/);
    console.log('journey-api-ab --check passed');
    return;
  }

  const oraclePath = paths[0];
  const output = `/Users/dongwon/workspace/umami-performance-lab/.local/journey-api-ab-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}.json`;
  mkdirSync('/Users/dongwon/workspace/umami-performance-lab/.local', { recursive: true });
  const run = { recorded_at: new Date().toISOString(), status: 'running', output, smoke, oracle_path: oraclePath, upstream_commit: null, website_id: WEBSITE, endpoints: { baseline: BASE, candidate: CANDIDATE }, timeout_ms: timeoutMs, containers: {}, cases: [], warmups: [], blocks: [], errors: [] };
  const save = () => writeFileSync(output, JSON.stringify({ ...run, updated_at: new Date().toISOString() }, null, 2));
  let tokens = {};
  try {
    const oracleText = readFileSync(oraclePath, 'utf8');
    const oracle = JSON.parse(oracleText);
    run.oracle_sha256 = createHash('sha256').update(oracleText).digest('hex');
    validateOracle(oracle);
    run.upstream_commit = oracle.upstream_commit;
    run.containers = { baseline: runtime(CONTAINERS.baseline), candidate: runtime(CONTAINERS.candidate), db: runtime(CONTAINERS.db) };
    assert.equal(run.containers.baseline.labels.upstream, COMMIT);
    assert.equal(run.containers.candidate.labels.upstream, COMMIT);
    assert.equal(run.containers.baseline.labels.variant, 'baseline');
    assert.equal(run.containers.candidate.labels.variant, 'distinct-only');
    assert.notEqual(run.containers.baseline.image_id, run.containers.candidate.image_id);
    tokens = { baseline: await login(BASE), candidate: await login(CANDIDATE) };

    const request = async (target, token, testCase) => {
      const response = await post(target, '/api/reports/journey', bodyFor(testCase), token);
      const result = { target, status: response.status, elapsed_ms: response.elapsed_ms, error: response.error ?? null, request_body: bodyFor(testCase), response: response.body };
      if (response.status !== 200 || !Array.isArray(response.body)) return { ...result, validation_error: 'HTTP or response-shape error' };
      try { return { ...result, validation: validateResponse(response.body, testCase.baseline), exact_json_equal: isDeepStrictEqual(response.body, testCase.baseline.slice(0, 100)) }; }
      catch (error) { return { ...result, validation_error: error instanceof Error ? error.message : String(error), exact_json_equal: false }; }
    };
    const initialCases = smoke ? oracle.cases.slice(0, 1) : oracle.cases;
    for (const testCase of initialCases) {
      const [baseline, candidate] = await Promise.all([request(BASE, tokens.baseline, testCase), request(CANDIDATE, tokens.candidate, testCase)]);
      const record = { name: testCase.name, baseline, candidate, oracle_rows: testCase.baseline, exact_pair_json_equal: isDeepStrictEqual(baseline.response, candidate.response) };
      run.cases.push(record); save();
      if (baseline.validation_error || candidate.validation_error) throw new Error(`${testCase.name} initial API validation failed`);
    }
    if (smoke) return;

    const selectedNames = new Set(['7d-views-3', '181d-views-3', '7d-all-7']);
    const selected = oracle.cases.filter(testCase => selectedNames.has(testCase.name));
    assert.equal(selected.length, 3, 'oracle missing a selected warmup case');
    for (const testCase of selected) {
      for (const targetName of ['baseline', 'candidate']) {
        const sample = await request(targetName === 'baseline' ? BASE : CANDIDATE, tokens[targetName], testCase);
        run.warmups.push({ target: targetName, case: testCase.name, sample }); save();
        if (sample.validation_error) throw new Error(`${targetName}/${testCase.name} warmup validation failed`);
      }
    }
    for (let round = 0; round < 6; round++) {
      const order = round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
      for (const targetName of order) {
        const target = targetName === 'baseline' ? BASE : CANDIDATE;
        for (const testCase of selected) {
        const before = cpuUsec();
        const samples = [];
        for (let index = 0; index < 5; index++) samples.push(await request(target, tokens[targetName], testCase));
        const cpu = cpuUsec() - before;
        run.blocks.push({ recorded_at: new Date().toISOString(), kind: 'sequential', round: round + 1, target: targetName, case: testCase.name, requests: 5, cpu_usec: cpu, cpu_usec_per_request: +(cpu / 5).toFixed(1), samples: samples.map(sampleRecord) });
        save();
        if (samples.some(sample => sample.validation_error)) throw new Error(`${targetName}/${testCase.name} sequential validation failed`);
        }
      }
    }

    const contentionCase = oracle.cases.find(testCase => testCase.name === '181d-views-3');
    assert(contentionCase, 'oracle missing 181d-views-3 contention case');
    for (let round = 0; round < 3; round++) for (const targetName of round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const target = targetName === 'baseline' ? BASE : CANDIDATE;
      const before = cpuUsec();
      const started = performance.now();
      const samples = (await Promise.all(Array.from({ length: 4 }, async () => {
        const worker = [];
        for (let index = 0; index < 2; index++) worker.push(await request(target, tokens[targetName], contentionCase));
        return worker;
      }))).flat();
      const elapsed = performance.now() - started;
      const cpu = cpuUsec() - before;
      run.blocks.push({ recorded_at: new Date().toISOString(), kind: 'contention', round: round + 1, target: targetName, case: contentionCase.name, concurrency: 4, requests: 8, elapsed_ms: +elapsed.toFixed(1), cpu_usec: cpu, cpu_usec_per_request: +(cpu / 8).toFixed(1), samples: samples.map(sampleRecord) });
      save();
      if (samples.some(sample => sample.validation_error)) throw new Error(`${targetName}/contention validation failed`);
    }
    run.status = 'complete';
  } catch (error) {
    run.status = 'failed'; run.errors.push(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
  } finally {
    if (run.status === 'running') run.status = run.errors.length ? 'failed' : 'complete';
    run.finished = new Date().toISOString(); save(); console.log(`${run.status}: ${output}`);
    tokens = {};
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
