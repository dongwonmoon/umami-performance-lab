// Measure report reads while a fixed-rate, single-flight pageview writer runs.
// This is a disposable localhost experiment; it never exports event contents.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

const WRITER = 'http://127.0.0.1:3003';
const FULL = 'http://127.0.0.1:3005';
const PARALLEL = 'http://127.0.0.1:3006';
const DB = 'umami-ingestion-db-1';
const APPS = { full: 'umami-performance-summary', parallel: 'umami-performance-parallel' };
const WEBSITE = '18573f23-3e24-44ef-b580-154cf371e7fe';
const START = '2026-08-08T00:00:00+09:00';
const END = '2026-09-07T00:00:00+09:00';
const EXPECTED_COUNT = 31493;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
const smoke = process.argv.includes('--smoke');
const check = process.argv.includes('--check');
const unknown = process.argv.slice(2).filter(value => !['--smoke', '--check'].includes(value));
assert.equal(unknown.length, 0, `Unknown option(s): ${unknown.join(', ')}`);
const eventCount = smoke ? 2 : 30;
const readsPerPhase = smoke ? 1 : 5;
const readGapMs = 2000;
const writerIntervalMs = 500;
const timeoutMs = 15000;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const inspect = name => JSON.parse(docker('inspect', name))[0];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? +sorted[Math.ceil(sorted.length * q) - 1].toFixed(1) : null;
};

// Serial by construction: if a send is late, future slots are moved forward,
// rather than issuing a catch-up burst.
export async function scheduleWriter(send, { count, intervalMs, wait = sleep, now = () => performance.now() }) {
  const started = now();
  let nextAt = started;
  let attempted = 0;
  let accepted = 0;
  let skippedSlots = 0;
  const lateSlots = [];
  const scheduleLateness = [];
  const sendStarts = [];
  const latencies = [];
  let failure = null;
  while (attempted < count && !failure) {
    const scheduledAt = nextAt;
    const before = now();
    if (before < scheduledAt) await wait(scheduledAt - before);
    const actualAt = now();
    const lateness = Math.max(0, actualAt - scheduledAt);
    scheduleLateness.push(+lateness.toFixed(1));
    if (lateness > 0) lateSlots.push({ index: attempted, lateness_ms: +lateness.toFixed(1) });
    const sendStarted = now();
    sendStarts.push(sendStarted);
    attempted++;
    try {
      const result = await send(attempted - 1);
      latencies.push(+(now() - sendStarted).toFixed(1));
      if (!result.ok) failure = result.error || 'writer response failure';
      else accepted++;
    } catch (error) {
      failure = error instanceof Error ? error.name : String(error);
    }
    const completedAt = now();
    const overdue = completedAt - (scheduledAt + intervalMs);
    const skipped = overdue > 0 ? Math.ceil(overdue / intervalMs) : 0;
    skippedSlots += skipped;
    if (skipped) {
      const late = lateSlots.at(-1)?.index === attempted - 1 ? lateSlots.at(-1) : { index: attempted - 1, lateness_ms: +lateness.toFixed(1) };
      if (late !== lateSlots.at(-1)) lateSlots.push(late);
      late.skipped_slots = skipped;
    }
    nextAt = skipped ? scheduledAt + (skipped + 1) * intervalMs : scheduledAt + intervalMs;
  }
  const elapsed = now() - started;
  return { attempted, accepted, failure, skipped_slots: skippedSlots, late_slots: lateSlots, schedule_lateness_ms: scheduleLateness, send_start_ms: sendStarts, latency_ms: latencies,
    p50_ms: quantile(latencies, .5), p95_ms: quantile(latencies, .95), max_ms: latencies.length ? +Math.max(...latencies).toFixed(1) : null,
    elapsed_ms: +elapsed.toFixed(1), events_per_sec: accepted ? +(accepted / (elapsed / 1000)).toFixed(2) : null };
}

const post = async (base, path, body, headers = {}) => {
  const started = performance.now();
  try {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    return { status: response.status, body: await response.json(), elapsed_ms: +(performance.now() - started).toFixed(1) };
  } catch (error) {
    return { status: 0, body: null, elapsed_ms: +(performance.now() - started).toFixed(1), error: error instanceof Error ? error.name : String(error) };
  }
};

const reportBody = { websiteId: WEBSITE, type: 'performance', filters: {}, parameters: { startDate: START, endDate: END, unit: 'day', timezone: 'Asia/Seoul', metric: 'lcp' } };
const eventPayload = (tag, index, timestamp) => ({ type: 'event', payload: { website: WEBSITE, url: `/performance-overlap/${timestamp}/${tag}/${index}`, hostname: 'localhost', title: 'performance-ingestion-overlap', tag, timestamp, userAgent: USER_AGENT } });

function dbEvidence(tag, timestamp, count) {
  const paths = Array.from({ length: count }, (_, index) => `'/performance-overlap/${timestamp}/${tag}/${index}'`).join(',');
  const pathArray = count ? `ARRAY[${paths}]` : "ARRAY[]::text[]";
  const sql = `select count(*) filter (where tag='${tag}'), count(distinct url_path) filter (where tag='${tag}'), count(*) filter (where tag='${tag}' and url_path=any(${pathArray})), count(*) filter (where tag='${tag}' and website_id='${WEBSITE}'), count(*) filter (where tag='${tag}' and event_type=1), count(*) filter (where tag='${tag}' and extract(epoch from created_at)::bigint=${timestamp}) from website_event;`;
  const values = docker('exec', DB, 'psql', '-U', 'umami', '-d', 'umami', '-Atqc', sql).split('|').map(Number);
  return { count: values[0], unique_paths: values[1], expected_paths: values[2], website: values[3], pageviews: values[4], timestamped: values[5] };
}

function cpuMax(container) {
  return docker('exec', container, 'cat', '/sys/fs/cgroup/cpu.max');
}
function runtime(container) {
  const value = inspect(container);
  return { image_id: value.Image, image: value.Config?.Image, cpu_max: cpuMax(container) };
}
function cpuUsage() {
  const match = docker('exec', DB, 'cat', '/sys/fs/cgroup/cpu.stat').match(/^usage_usec\s+(\d+)$/m);
  assert(match, 'DB cgroup v2 usage_usec unavailable');
  return Number(match[1]);
}

async function login(base) {
  const result = await post(base, '/api/auth/login', { username: 'admin', password: 'umami' });
  assert.equal(result.status, 200, `${base} login HTTP ${result.status}`);
  assert.equal(typeof result.body?.token, 'string', `${base} login did not return token`);
  return result.body.token;
}

async function readReport(base, token, expected) {
  const result = await post(base, '/api/reports/performance', reportBody, { Authorization: `Bearer ${token}` });
  const ok = result.status === 200 && isDeepStrictEqual(result.body, expected);
  return { elapsed_ms: result.elapsed_ms, ok, status: result.status, error: ok ? null : result.status === 200 ? 'response-mismatch' : result.error || 'http-error' };
}

async function main() {
  if (check) {
    let clock = 0;
    const options = { count: 3, intervalMs: 500, wait: async ms => { clock += ms; }, now: () => clock };
    const regular = await scheduleWriter(async () => { clock += 10; return { ok: true }; }, options);
    assert.deepEqual(regular.send_start_ms, [0, 500, 1000], 'regular writer must stay on the fixed grid');
    clock = 0;
    const slow = await scheduleWriter(async () => { clock += 1200; return { ok: true }; }, options);
    assert.equal(slow.attempted, 3);
    assert.equal(slow.accepted, 3);
    assert(slow.skipped_slots >= 1, 'slow writer must record skipped slots');
    assert(slow.send_start_ms.slice(1).every((value, index) => value - slow.send_start_ms[index] >= 500), 'slow writer must not catch up in a burst');
    console.log('performance-ingestion-overlap --check passed');
    return;
  }

  mkdirSync(new URL('../.local/', import.meta.url), { recursive: true });
  const stamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '');
  const output = new URL(`../.local/performance-ingestion-overlap-${stamp}.json`, import.meta.url);
  const run = { recorded_at: new Date().toISOString(), updated_at: new Date().toISOString(), status: 'running', output: output.pathname, smoke, website_id: WEBSITE,
    scope: { start_date: START, end_date: END, unit: 'day', timezone: 'Asia/Seoul', metric: 'lcp', expected_count: EXPECTED_COUNT },
    schedule: { event_count_per_mixed_block: eventCount, reads_per_phase: readsPerPhase, read_gap_ms: readGapMs, writer_interval_ms: writerIntervalMs, single_flight: true, catch_up: false },
    payload: { type: 'event', website: WEBSITE, path_template: '/performance-overlap/TIMESTAMP/TAG/INDEX', title: 'performance-ingestion-overlap', fixed_browser_user_agent: true }, phases: [], errors: [] };
  const checkpoint = () => writeFileSync(output, JSON.stringify({ ...run, updated_at: new Date().toISOString() }, null, 2));
  let writerHeaders;
  let expected;
  let failed = false;
  try {
    run.containers = { db: runtime(DB), full: runtime(APPS.full), parallel: runtime(APPS.parallel) };
    assert.equal(run.containers.db.cpu_max, '200000 100000', `DB effective cpu.max must be 200000 100000, got ${run.containers.db.cpu_max}`);
    const fullToken = await login(FULL);
    const parallelToken = await login(PARALLEL);
    const timestamp = Math.floor(Date.parse(END) / 1000) + 3600;
    run.timestamp_seconds = timestamp;
    const warm = await post(WRITER, '/api/send', eventPayload(`warmup-${stamp}`, 0, timestamp));
    assert.equal(warm.status, 200, `writer warmup HTTP ${warm.status}`);
    assert.equal(typeof warm.body?.cache, 'string', 'writer warmup did not return cache token');
    writerHeaders = { 'x-umami-cache': warm.body.cache };
    expected = (await post(FULL, '/api/reports/performance', reportBody, { Authorization: `Bearer ${fullToken}` })).body;
    assert.equal(expected?.summary?.count, EXPECTED_COUNT, 'prepared fixture count changed; run performance-summary-probe --prepare');
    run.expected_summary = { count: expected.summary.count };
    checkpoint();

    const readPhase = async (name, strategy, token, base, phaseIndex, readCount = readsPerPhase, validate = true) => {
      const tag = `perf-overlap-${stamp}-${phaseIndex}`.slice(0, 49);
      const beforeCpu = cpuUsage();
      const reads = [];
      let writerPromise;
      writerPromise = scheduleWriter(async index => {
        const response = await post(WRITER, '/api/send', eventPayload(tag, index, timestamp), writerHeaders);
        return response.status === 200 && response.body?.beep !== 'boop' ? { ok: true } : { ok: false, error: response.body?.beep === 'boop' ? 'bot-success' : response.error || 'http-error' };
      }, { count: eventCount, intervalMs: writerIntervalMs });
      try {
        for (let index = 0; index < readCount; index++) {
          reads.push(await readReport(base, token, expected));
          if (index + 1 < readCount) await sleep(readGapMs);
        }
      } finally {
        // Always drain the scheduled writer before recording or exiting.
        const writerResult = await writerPromise;
        const afterCpu = cpuUsage();
        const persisted = dbEvidence(tag, timestamp, writerResult.accepted);
        const latencies = reads.map(read => read.elapsed_ms);
        const phase = { name, strategy, reads, samples: reads.length, p50_ms: quantile(latencies, .5), p95_ms: quantile(latencies, .95), max_ms: latencies.length ? Math.max(...latencies) : null,
          writer: writerResult, persisted, cpu_usage_usec_delta: afterCpu - beforeCpu };
        run.phases.push(phase); checkpoint();
        if (validate && (reads.some(read => !read.ok) || writerResult.failure || writerResult.accepted !== eventCount || persisted.count !== eventCount || persisted.unique_paths !== eventCount || persisted.expected_paths !== eventCount || persisted.website !== eventCount || persisted.pageviews !== eventCount || persisted.timestamped !== eventCount || phase.cpu_usage_usec_delta < 0)) throw new Error(`${name} validation failed`);
      }
      return run.phases.at(-1);
    };

    const baseline = await readPhase('baseline', 'write-only', fullToken, FULL, 0, 0);
    if (baseline.writer.failure || baseline.writer.accepted !== eventCount || baseline.writer.skipped_slots || baseline.writer.schedule_lateness_ms.some(ms => ms >= writerIntervalMs) || baseline.writer.p95_ms >= 250 || baseline.writer.max_ms >= 500) {
      run.status = 'unsuitable'; run.error = 'initial writer baseline exceeded offered-load headroom'; process.exitCode = 2; return;
    }
    for (const [index, strategy] of ['full', 'parallel', 'parallel', 'full'].entries()) {
      await readPhase(`mixed-${index + 1}`, strategy, strategy === 'full' ? fullToken : parallelToken, strategy === 'full' ? FULL : PARALLEL, index + 1);
    }
    await readPhase('baseline-final', 'write-only', fullToken, FULL, 5, 0);
  } catch (error) {
    failed = true;
    run.errors.push(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    run.offered_load_maintained = run.phases.length === 6 && run.phases.every(phase => phase.writer.skipped_slots === 0 && phase.writer.schedule_lateness_ms.every(ms => ms < writerIntervalMs));
    run.status = failed ? 'failed' : run.status === 'unsuitable' ? 'unsuitable' : 'complete';
    checkpoint();
    console.log(`Cumulative output: ${output.pathname}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
