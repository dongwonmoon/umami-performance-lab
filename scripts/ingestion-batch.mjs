// Comparison of sequential /api/send and /api/batch writes to a disposable app.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const BASE = 'http://127.0.0.1:3003';
const DB = 'umami-ingestion-db-1';
const APP = 'umami-ingestion-app-1';
const WEBSITE = '18573f23-3e24-44ef-b580-154cf371e7fe';
const timeoutMs = 10_000;
const smoke = process.argv.includes('--smoke');
const check = process.argv.includes('--check');
const unknown = process.argv.slice(2).filter(value => !['--smoke', '--check'].includes(value));
assert.equal(unknown.length, 0, `Unknown option(s): ${unknown.join(', ')}`);
const eventsPerMode = smoke ? 100 : 1000;
const repeats = smoke ? 1 : 3;
const modes = ['send', 'batch10', 'batch100'];

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const inspect = name => JSON.parse(docker('inspect', name))[0];
const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? +sorted[Math.ceil(sorted.length * q) - 1].toFixed(1) : null;
};

export function partition(items, size) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
}

export function classifyBatch(status, body, expected) {
  if (status !== 200) return 'http-error';
  if (body?.beep === 'boop') return 'bot-success';
  if (body?.errors) return 'partial-error';
  if (body?.size !== expected || body?.processed !== expected) return 'count-error';
  return 'ok';
}

const cpuUsage = () => {
  const text = docker('exec', DB, 'cat', '/sys/fs/cgroup/cpu.stat');
  const match = text.match(/^usage_usec\s+(\d+)$/m);
  assert(match, 'DB cgroup cpu.stat has no usage_usec');
  return Number(match[1]);
};

const dbEvidence = (tag, timestamp, expectedCount = 0) => {
  const pathArray = expectedCount ? `ARRAY[${Array.from({ length: expectedCount }, (_, index) => `'/ingest/${index}'`).join(',')}]` : "ARRAY[]::text[]";
  const sql = `select count(*), count(*) filter (where tag='${tag}'), count(distinct url_path) filter (where tag='${tag}'), count(*) filter (where tag='${tag}' and url_path = any(${pathArray})), count(*) filter (where tag='${tag}' and page_title='ingestion-batch-check'), count(*) filter (where tag='${tag}' and event_type=1), count(*) filter (where tag='${tag}' and extract(epoch from created_at)::bigint=${timestamp}), count(*) filter (where tag='${tag}' and website_id='${WEBSITE}') from website_event;`;
  const [total, count, paths, expectedPathsCount, titled, pageviews, timestamped, website] = docker('exec', DB, 'psql', '-U', 'umami', '-d', 'umami', '-Atqc', sql).split('|').map(Number);
  return { total, count, unique_paths: paths, expected_paths: expectedPathsCount, expected_title: titled, pageviews, timestamped, website };
};

const payload = (tag, index, timestamp) => ({
  type: 'event', payload: { website: WEBSITE, url: `/ingest/${index}`, hostname: 'localhost', title: 'ingestion-batch-check', tag, timestamp, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36' },
});

async function post(path, body, headers = {}) {
  const started = performance.now();
  try {
    const response = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    return { status: response.status, body: await response.json(), elapsed: performance.now() - started };
  } catch (error) {
    return { status: 0, body: null, elapsed: performance.now() - started, error: error instanceof Error ? error.name : String(error) };
  }
}

async function main() {
  if (check) {
    assert.deepEqual(partition(Array.from({ length: 23 }, (_, i) => i), 10).map(x => x.length), [10, 10, 3]);
    assert.equal(classifyBatch(200, { size: 10, processed: 10, errors: 0 }, 10), 'ok');
    assert.equal(classifyBatch(200, { size: 10, processed: 9, errors: 1 }, 10), 'partial-error');
    assert.equal(classifyBatch(200, { beep: 'boop' }, 1), 'bot-success');
    console.log('ingestion-batch --check passed');
    return;
  }

  mkdirSync(new URL('../.local/', import.meta.url), { recursive: true });
  const stamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '');
  const output = new URL(`../.local/ingestion-batch-${stamp}.json`, import.meta.url);
  const run = { recorded_at: new Date().toISOString(), status: 'running', output: output.pathname, smoke, events_per_mode: eventsPerMode, repeats, modes, timeout_ms: timeoutMs, payload_template: { type: 'event', website: WEBSITE, paths: '/ingest/0..N-1', title: 'ingestion-batch-check', fixed_user_agent: true }, cache_policy: 'one /api/send warmup token reused for all modes', warmup_events_per_mode: 100, app: (() => { const x = inspect(APP); return { image_id: x.Image, image: x.Config?.Image }; })(), db: (() => { const x = inspect(DB); return { image_id: x.Image, image: x.Config?.Image }; })(), website_id: WEBSITE, blocks: [] };
  const checkpoint = () => writeFileSync(output, JSON.stringify({ ...run, updated_at: new Date().toISOString() }, null, 2));
  let failed = false;
  try {
    const timestamp = Math.floor(Date.now() / 1000);
    run.timestamp_seconds = timestamp;
    run.payload_template = payload('BLOCK_TAG', 0, timestamp);
    const warm = await post('/api/send', payload('warmup', 0, timestamp));
    assert.equal(warm.status, 200, `warmup HTTP ${warm.status}`);
    assert.equal(typeof warm.body?.cache, 'string', 'warmup did not return cache token');
    const headers = { 'x-umami-cache': warm.body.cache };
    checkpoint();
    console.log(`Cumulative output: ${output.pathname}`);
    for (let repeat = 0; repeat < repeats; repeat++) {
      const order = modes.slice(repeat % modes.length).concat(modes.slice(0, repeat % modes.length));
      for (const mode of order) {
        const tag = `ingest-${stamp}-${repeat + 1}-${mode}`.slice(0, 49);
        const items = Array.from({ length: eventsPerMode }, (_, index) => payload(tag, index, timestamp));
        const warmItems = Array.from({ length: 100 }, (_, index) => payload(`${tag}-warm`, index, timestamp));
        const blockStartRows = dbEvidence('__never__', timestamp).total;
        let warmupResult; let failureInfo;
        if (mode === 'send') {
          const warmResults = [];
          for (let index = 0; index < warmItems.length; index++) { const response = await post('/api/send', warmItems[index], headers); warmResults.push(response); if (response.status !== 200 || response.body?.beep === 'boop') { failureInfo = { phase: 'warmup', kind: response.body?.beep === 'boop' ? 'bot-success' : 'http-error', index, status: response.status, error: response.error }; break; } }
          warmupResult = { attempted: warmResults.length, errors: failureInfo ? 1 : 0 };
        } else {
          const warmSize = mode === 'batch10' ? 10 : 100;
          const warmResults = [];
          const warmGroups = partition(warmItems, warmSize);
          for (let index = 0; index < warmGroups.length; index++) { const group = warmGroups[index]; const response = await post('/api/batch', group, headers); warmResults.push(response); const kind = classifyBatch(response.status, response.body, group.length); if (kind !== 'ok') { failureInfo = { phase: 'warmup', kind, index, status: response.status, error: response.error, failed_item_indices: response.body?.details?.map(item => item.index) }; break; } }
          warmupResult = { attempted: warmResults.length, errors: failureInfo ? 1 : 0 };
        }
        const cpuBefore = cpuUsage();
        const blockStarted = performance.now();
        const measured = []; let errors = 0; let sent = 0;
        errors += warmupResult.errors;
        if (!failureInfo && mode === 'send') {
          for (let index = 0; index < items.length; index++) { const response = await post('/api/send', items[index], headers); measured.push(response.elapsed); sent++; if (response.status !== 200 || response.body?.beep === 'boop') { errors++; failureInfo = { phase: 'measured', kind: response.body?.beep === 'boop' ? 'bot-success' : 'http-error', index, status: response.status, error: response.error }; break; } }
        } else if (!failureInfo) {
          const size = mode === 'batch10' ? 10 : 100;
          const groups = partition(items, size);
          for (let index = 0; index < groups.length; index++) { const group = groups[index]; const response = await post('/api/batch', group, headers); measured.push(response.elapsed); sent += group.length; const kind = classifyBatch(response.status, response.body, group.length); if (kind !== 'ok') { errors += kind === 'partial-error' ? response.body.errors : 1; failureInfo = { phase: 'measured', kind, index, status: response.status, error: response.error, failed_item_indices: response.body?.details?.map(item => item.index) }; break; } }
        }
        const elapsedMs = performance.now() - blockStarted;
        const cpuAfter = cpuUsage();
        const evidence = dbEvidence(tag, timestamp, eventsPerMode);
        const cpuDelta = cpuAfter - cpuBefore;
        const result = { mode, repeat: repeat + 1, tag, sent, request_count: measured.length, errors, failure: failureInfo ?? null, p50_ms: quantile(measured, 0.5), p95_ms: quantile(measured, 0.95), elapsed_ms: +elapsedMs.toFixed(1), events_per_sec: sent ? +(sent / (elapsedMs / 1000)).toFixed(2) : null, per_event_ms: sent ? +(elapsedMs / sent).toFixed(3) : null, request_latencies_ms: measured.map(x => +x.toFixed(3)), db: evidence, cpu_usage_usec_delta: cpuDelta, cpu_seconds: +(cpuDelta / 1e6).toFixed(6), cpu_ms_per_event: sent ? +(cpuDelta / 1000 / sent).toFixed(3) : null };
        const block = { recorded_at: new Date().toISOString(), mode, repeat: repeat + 1, order, warmup: warmupResult, start_db_rows: blockStartRows, result };
        run.blocks.push(block); checkpoint();
        console.log(`${mode} repeat=${repeat + 1}/${repeats}: ${sent} events, ${errors} errors, ${failureInfo?.kind ?? 'ok'}, DB rows=${evidence.count}`);
        failed ||= errors > 0 || sent !== eventsPerMode || evidence.count !== eventsPerMode || evidence.unique_paths !== eventsPerMode || evidence.expected_paths !== eventsPerMode || evidence.expected_title !== eventsPerMode || evidence.pageviews !== eventsPerMode || evidence.timestamped !== eventsPerMode || evidence.website !== eventsPerMode || result.cpu_usage_usec_delta < 0;
        if (failed) throw new Error(`${mode} repeat ${repeat + 1} failed validation`);
      }
    }
  } catch (error) { failed = true; run.error = error instanceof Error ? error.message : String(error); throw error;
  } finally { run.status = failed ? 'failed' : 'complete'; checkpoint(); }
  if (failed) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
