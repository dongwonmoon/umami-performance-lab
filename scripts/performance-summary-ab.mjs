// Compare legacy full responses with cold/warm split requests on one patched build.
// This isolates request strategy; it does not measure browser rendering or cache expiry.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const base = 'http://127.0.0.1:3005';
const parallelOnly = process.argv.includes('--parallel-only');
const compareParallel = parallelOnly || process.argv.includes('--parallel');
const parallelBase = 'http://127.0.0.1:3006';
const websiteId = '18573f23-3e24-44ef-b580-154cf371e7fe';
const parameters = { startDate: '2026-08-08T00:00:00+09:00', endDate: '2026-09-07T00:00:00+09:00', unit: 'day', timezone: 'Asia/Seoul' };
const metrics = ['lcp', 'inp', 'cls', 'fcp', 'ttfb'];
const combine = (details, summary) => ({ ...details, summary: summary.summary });
if (process.argv.includes('--check')) {
  assert.deepEqual(combine({ chart: [1], pages: [2] }, { summary: { count: 3 } }), { chart: [1], pages: [2], summary: { count: 3 } });
  console.log('performance-summary-ab --check passed');
} else {
  const output = new URL(`../.local/performance-${parallelOnly ? 'parallel-ab' : compareParallel ? 'three-way' : 'summary-ab'}-${Date.now()}.json`, import.meta.url);
  mkdirSync(new URL('../.local/', import.meta.url), { recursive: true });
  const image = JSON.parse(execFileSync('docker', ['inspect', 'umami-performance-summary'], { encoding: 'utf8' }))[0];
  const run = { started: new Date().toISOString(), status: 'running', base, websiteId, parameters,
    image: image.Image, method: 'One patched production build: full legacy request vs summary+details (parallel cold, cached-summary warm). Alternating strategy order; fixed data; localhost HTTP and decode, not browser UX.', rounds: [], checks: [] };
  const save = () => writeFileSync(output, JSON.stringify(run, null, 2));
  async function post(path, body, token, target = base) {
    const res = await fetch(target + path, { method: 'POST', headers: {
      'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    assert.equal(res.status, 200, `${path} HTTP ${res.status}`);
    return res.json();
  }
  try {
    const db = JSON.parse(execFileSync('docker', ['inspect', 'umami-ingestion-db-1'], { encoding: 'utf8' }))[0];
    run.dbLimits = { nanoCpus: db.HostConfig.NanoCpus, cpuQuota: db.HostConfig.CpuQuota, cpuPeriod: db.HostConfig.CpuPeriod, memory: db.HostConfig.Memory };
    if (parallelOnly) run.method = 'Legacy full vs parallel-only full response; alternating order, fixed DB and scopes; HTTP+decode not browser UX.';
    const { token } = await post('/api/auth/login', { username: 'admin', password: 'umami' });
    assert.equal(typeof token, 'string');
    let parallelToken;
    if (compareParallel) {
      run.parallelImage = JSON.parse(execFileSync('docker', ['inspect', 'umami-performance-parallel'], { encoding: 'utf8' }))[0].Image;
      ({ token: parallelToken } = await post('/api/auth/login', { username: 'admin', password: 'umami' }, undefined, parallelBase));
      assert.equal(typeof parallelToken, 'string');
      run.method += ' Parallel-only clean pinned build on port 3006; same DB. Six balanced strategy orders after warmup. No browser cache lifecycle measurement.';
    }
    const request = (metric, section, overrides = {}, filters = {}) => post('/api/reports/performance', {
      websiteId, type: 'performance', filters, parameters: { ...parameters, ...overrides, metric, ...(section ? { section } : {}) },
    }, token);
    const parallelRequest = (metric, overrides = {}, filters = {}) => post('/api/reports/performance', {
      websiteId, type: 'performance', filters, parameters: { ...parameters, ...overrides, metric },
    }, parallelToken, parallelBase);
    const expected = {};
    for (const metric of metrics) {
      expected[metric] = await request(metric);
      assert.equal(expected[metric].summary.count, 31493, 'Unexpected fixture; use performance-summary-probe --prepare first');
    }
    const orders = [ ['full', 'parallel', 'split'], ['parallel', 'split', 'full'], ['split', 'full', 'parallel'],
      ['split', 'parallel', 'full'], ['parallel', 'full', 'split'], ['full', 'split', 'parallel'] ];
    for (let round = 0; round < (compareParallel ? 7 : 6); round++) {
      for (const strategy of (compareParallel ? orders[Math.max(0, round - 1)] : round % 2 ? ['split', 'full'] : ['full', 'split']).filter(s => !parallelOnly || s !== 'split')) {
        const samples = []; let cached; let cacheAt;
        for (const metric of metrics) {
          const start = performance.now(); let body;
          if (strategy === 'full') body = await request(metric);
          else if (strategy === 'parallel') body = await parallelRequest(metric);
          else if (!cached) {
            const [details, summary] = await Promise.all([request(metric, 'details'), request(metric, 'summary')]);
            cached = summary; cacheAt = performance.now(); body = combine(details, cached);
          } else {
            assert(performance.now() - cacheAt < 60000, 'Simulated summary cache exceeded existing freshness window');
            body = combine(await request(metric, 'details'), cached);
          }
          const ms = performance.now() - start;
          assert.deepEqual(body, expected[metric], `${strategy}/${metric} changed full response`);
          samples.push({ metric, ms, summaryCache: strategy !== 'split' ? 'none' : metric === metrics[0] ? 'cold' : 'warm' });
        }
        run.rounds.push({ round, warmup: round === 0, strategy, samples }); save();
      }
    }
    // Fresh-scope requests: do not reuse the prior scope's summary.
    for (const scope of [
      { name: 'seven-days', overrides: { startDate: '2026-08-31T00:00:00+09:00' }, filters: {} },
      { name: 'chrome', overrides: {}, filters: { browser: 'eq.Chrome' } },
    ]) {
      const full = await request('lcp', undefined, scope.overrides, scope.filters);
      if (!parallelOnly) {
        const [details, summary] = await Promise.all([
        request('lcp', 'details', scope.overrides, scope.filters), request('lcp', 'summary', scope.overrides, scope.filters),
      ]);
      assert.deepEqual(combine(details, summary), full, `${scope.name} changed response`);
      }
      assert(full.summary.count > 0, `${scope.name} did not exercise populated data`);
      if (compareParallel) assert.deepEqual(await parallelRequest('lcp', scope.overrides, scope.filters), full, `${scope.name} parallel changed response`);
      run.checks.push({ name: scope.name, count: full.summary.count, equal: true });
    }
    if (compareParallel) {
      // Shared DB CPU: keep other clients idle. This small check is not a capacity test.
      const dbCpu = () => {
        const stat = execFileSync('docker', ['exec', 'umami-ingestion-db-1', 'cat', '/sys/fs/cgroup/cpu.stat'], { encoding: 'utf8' });
        const match = stat.match(/^usage_usec\s+(\d+)$/m);
        assert(match, 'Expected cgroup v2 DB CPU counter');
        return Number(match[1]);
      };
      run.contention = [];
      for (let round = 0; round < 3; round++) {
        for (const strategy of round % 2 ? ['parallel', 'full'] : ['full', 'parallel']) {
          const samples = []; const before = dbCpu(); const begin = performance.now();
          await Promise.all(Array.from({ length: 4 }, async () => {
            for (let i = 0; i < 2; i++) {
              const start = performance.now();
              const body = strategy === 'full' ? await request('lcp') : await parallelRequest('lcp');
              const ms = performance.now() - start;
              assert.deepEqual(body, expected.lcp, `${strategy} concurrent response differs`);
              samples.push(ms);
            }
          }));
          const elapsedMs = performance.now() - begin;
          const cpuUsec = dbCpu() - before;
          run.contention.push({ round, strategy, concurrency: 4, requests: 8, elapsedMs, dbCpuUsec: cpuUsec, samples }); save();
        }
      }
    }
    run.status = 'complete';
  } catch (error) {
    run.status = 'failed'; run.error = String(error); process.exitCode = 1;
  } finally {
    run.finished = new Date().toISOString(); save(); console.log(`${run.status}: ${output.pathname}`);
  }
}
