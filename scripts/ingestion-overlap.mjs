// Qualify overview reads while a modest, single-flight event writer runs.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

const BASE = 'http://127.0.0.1:3003';
const DB = 'umami-ingestion-db-1';
const APP = 'umami-ingestion-app-1';
const evidence = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../evidence/2026-09-06/umami-probe-20260906-expanded-7d.json', import.meta.url), 'utf8'));
const WEBSITE = evidence.websiteId;
const READS = process.argv.includes('--smoke') ? 3 : 30;
const GAP = process.argv.includes('--smoke') ? 200 : 1000;
const check = process.argv.includes('--check');
const unknown = process.argv.slice(2).filter(value => !['--smoke', '--check'].includes(value));
assert.equal(unknown.length, 0, `Unknown option(s): ${unknown.join(', ')}`);
const timeoutMs = 10_000;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const quantile = (values, q) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? +sorted[Math.ceil(sorted.length * q) - 1].toFixed(1) : null; };
const inspect = name => JSON.parse(docker('inspect', name))[0];
const cpuUsage = () => { const match = docker('exec', DB, 'cat', '/sys/fs/cgroup/cpu.stat').match(/^usage_usec\s+(\d+)$/m); assert(match, 'usage_usec unavailable'); return Number(match[1]); };

export function runWriter(send, sleep) {
  let stopped = false; let attempted = 0; let accepted = 0; let failure = null; const state = { get failure() { return failure; } }; const started = performance.now();
  const done = (async () => { while (!stopped) { attempted++; try { const result = await send(attempted - 1); if (!result.ok) { failure = result.error || 'writer response failure'; break; } accepted++; } catch (error) { failure = error instanceof Error ? error.name : String(error); break; } if (!stopped) await sleep(); } const elapsed_ms = performance.now() - started; return { attempted, accepted, failure, elapsed_ms: +elapsed_ms.toFixed(1), events_per_sec: +(accepted / (elapsed_ms / 1000)).toFixed(2) }; })();
  return { stop: () => { stopped = true; }, done, state };
}

const post = async (path, body, headers = {}) => {
  try { const response = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) }); return { status: response.status, body: await response.json() }; }
  catch (error) { return { status: 0, body: null, error: error instanceof Error ? error.name : String(error) }; }
};
const getRead = async headers => { const started = performance.now(); try { const response = await fetch(`${BASE}${evidence.requests.overview.path}`, { headers, signal: AbortSignal.timeout(timeoutMs) }); const body = await response.json(); const ok = response.status === 200 && isDeepStrictEqual(body, evidence.measurements.overview.response); return { elapsed: +(performance.now() - started).toFixed(3), ok, status: response.status, error: ok ? null : response.status === 200 ? 'response-mismatch' : 'http-error' }; } catch (error) { return { elapsed: +(performance.now() - started).toFixed(3), ok: false, status: 0, error: error instanceof Error ? error.name : String(error) }; } };
const writerPayload = (tag, index, timestamp) => ({ type: 'event', payload: { website: WEBSITE, url: `/overlap/${index}`, hostname: 'localhost', title: 'ingestion-overlap-check', tag, timestamp, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36' } });
const dbEvidence = (tag, timestamp, count) => { const paths = Array.from({ length: count }, (_, i) => `'/overlap/${i}'`).join(','); const sql = `select count(*) filter (where tag='${tag}'), count(distinct url_path) filter (where tag='${tag}'), count(*) filter (where tag='${tag}' and url_path=any(ARRAY[${paths}])), count(*) filter (where tag='${tag}' and website_id='${WEBSITE}'), count(*) filter (where tag='${tag}' and extract(epoch from created_at)::bigint=${timestamp}) from website_event;`; return docker('exec', DB, 'psql', '-U', 'umami', '-d', 'umami', '-Atqc', sql).split('|').map(Number); };

async function main() {
  if (check) { let calls = 0; let sleepCalls = 0; let release; const pending = new Promise(resolve => { release = resolve; }); const writer = runWriter(async () => { calls++; return pending.then(() => ({ ok: true })); }, async () => { sleepCalls++; }); writer.stop(); release(); const result = await writer.done; assert.equal(calls, 1); assert.equal(sleepCalls, 0); assert.equal(result.attempted, 1); assert.equal(result.accepted, 1); assert.equal(result.failure, null); console.log('ingestion-overlap --check passed'); return; }
  mkdirSync(new URL('../.local/', import.meta.url), { recursive: true });
  const stamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', ''); const output = new URL(`../.local/ingestion-overlap-${stamp}.json`, import.meta.url);
  const app = inspect(APP); const db = inspect(DB); const run = { recorded_at: new Date().toISOString(), status: 'running', output: output.pathname, smoke: process.argv.includes('--smoke'), website_id: WEBSITE, query: evidence.requests.overview, expected_response: evidence.measurements.overview.response, start_date: evidence.startDate, end_date: evidence.endDate, reads_per_phase: READS, gap_ms: GAP, writer_interval_ms: 200, payload: { type: 'event', website: WEBSITE, path_template: '/overlap/N', title: 'ingestion-overlap-check', user_agent: 'fixed browser-like UA' }, cache_policy: 'one /api/send warmup token reused by writer', images: { app: { id: app.Image, image: app.Config?.Image }, db: { id: db.Image, image: db.Config?.Image } }, phases: [] };
  const checkpoint = () => writeFileSync(output, JSON.stringify({ ...run, updated_at: new Date().toISOString() }, null, 2)); let failed = false;
  try {
    const timestamp = Math.floor(Date.parse(evidence.endDate) / 1000) + 60;
    run.timestamp_seconds = timestamp;
    run.payload = writerPayload('BLOCK_TAG', 0, timestamp);
    const login = await post('/api/auth/login', { username: 'admin', password: 'umami' }); assert.equal(login.status, 200); assert.equal(typeof login.body?.token, 'string'); const warm = await post('/api/send', writerPayload('overlap-warmup', 0, timestamp)); assert.equal(warm.status, 200); assert.equal(typeof warm.body?.cache, 'string'); const headers = { Authorization: `Bearer ${login.body.token}`, 'x-umami-cache': warm.body.cache };
    for (let i = 0; i < 2; i++) assert((await getRead(headers)).ok, 'read warmup failed');
    checkpoint(); console.log(`Cumulative output: ${output.pathname}`);
    for (const phase of ['read-only-before', 'mixed', 'read-only-after']) {
      const beforeCpu = cpuUsage(); const reads = []; let writer; const tag = `overlap-${stamp}`;
      if (phase === 'mixed') writer = runWriter(async index => { const result = await post('/api/send', writerPayload(tag, index, timestamp), headers); return result.status === 200 && result.body?.beep !== 'boop' ? { ok: true } : { ok: false, error: result.body?.beep === 'boop' ? 'bot-success' : 'http-error' }; }, () => new Promise(resolve => setTimeout(resolve, 200)));
      const phaseStarted = performance.now(); try { for (let index = 0; index < READS; index++) { if (writer?.state.failure) break; const read = await getRead(headers); reads.push(read); if (!read.ok || writer?.state.failure) break; if (index + 1 < READS) { await new Promise(resolve => setTimeout(resolve, GAP)); if (writer?.state.failure) break; } } } catch (error) { writer?.stop(); if (writer) await writer.done; throw error; } finally { if (writer) writer.stop(); }
      const elapsedMs = performance.now() - phaseStarted; const drainStarted = performance.now(); const writerResult = writer ? await writer.done : { attempted: 0, accepted: 0, failure: null }; const drainElapsedMs = performance.now() - drainStarted; const afterCpu = cpuUsage(); const count = writerResult.attempted; const persisted = phase === 'mixed' ? dbEvidence(tag, timestamp, count || 1) : null; const latencies = reads.map(read => read.elapsed); const cpuDelta = afterCpu - beforeCpu; const result = { phase, reads, samples: reads.length, p50_ms: quantile(latencies, .5), p95_ms: quantile(latencies, .95), actual_elapsed_ms: +elapsedMs.toFixed(1), drain_elapsed_ms: +drainElapsedMs.toFixed(1), cpu_usage_usec_delta: cpuDelta, writer: writerResult, persisted: persisted && { count: persisted[0], unique_paths: persisted[1], expected_paths: persisted[2], website: persisted[3], timestamped: persisted[4] } }; run.phases.push(result); checkpoint(); console.log(`${phase}: ${reads.length} reads, p50=${result.p50_ms ?? '-'}ms, writer=${writerResult.accepted}/${writerResult.attempted}`); if (reads.some(read => !read.ok) || writerResult.failure || cpuDelta < 0 || (phase === 'mixed' && (persisted[0] !== count || persisted[1] !== count || persisted[2] !== count || persisted[3] !== count || persisted[4] !== count))) { failed = true; throw new Error(`${phase} validation failed`); }
    }
  } catch (error) { failed = true; run.error = error instanceof Error ? error.message : String(error); throw error; } finally { run.status = failed ? 'failed' : 'complete'; checkpoint(); }
}
if (import.meta.url === `file://${process.argv[1]}`) await main();
