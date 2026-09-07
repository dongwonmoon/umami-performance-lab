// Bounded qualification probe for the disposable performance-report database.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:3003';
const DB = 'umami-ingestion-db-1';
const WEBSITE = '18573f23-3e24-44ef-b580-154cf371e7fe';
const START = '2026-08-08T00:00:00+09:00';
const END = '2026-09-07T00:00:00+09:00';
const SUFFIX = ':performance-summary-probe';
const SOURCE = '/private/tmp/umami-qualification/src/queries/sql/reports/getPerformance.ts';
const COMMIT = 'ca661c7057984aa98ed4f7083d84dae2f65bfcb0';
const METRICS = ['lcp', 'inp', 'cls', 'fcp', 'ttfb'];
const timeoutMs = 10_000;

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const psql = sql => docker('exec', DB, 'psql', '-U', 'umami', '-d', 'umami', '-Atqc', sql);
const sqlLiteral = value => `'${value.replaceAll("'", "''")}'`;

const fixtureSource = `
  select event_id, website_id, session_id, visit_id, created_at, url_path, url_query,
         page_title, hostname,
         row_number() over (order by event_id) as rn
  from website_event
  where website_id = ${sqlLiteral(WEBSITE)}::uuid
    and event_type = 1
    and created_at >= timestamptz ${sqlLiteral(START)}
    and created_at < timestamptz ${sqlLiteral(END)}
`;

export const fixtureInsertSQL = `
with source as (${fixtureSource}), inserted as (
  insert into website_event (
    event_id, website_id, session_id, visit_id, created_at, url_path, url_query,
    page_title, hostname, event_type, lcp, inp, cls, fcp, ttfb
  )
  select
    md5(event_id::text || ${sqlLiteral(SUFFIX)})::uuid,
    website_id, session_id, visit_id, created_at, url_path, url_query,
    page_title, hostname, 5,
    round((900 + mod(rn * 137, 3201)) / 10.0, 1),
    case when mod(rn, 7) = 0 then null
         else round((40 + mod(rn * 83, 1601)) / 10.0, 1) end,
    round((300 + mod(rn * 17, 1801)) / 10000.0, 4),
    round((450 + mod(rn * 101, 2601)) / 10.0, 1),
    round((200 + mod(rn * 61, 1801)) / 10.0, 1)
  from source
  on conflict(event_id) do nothing
  returning event_id
)
select count(*) from inserted;
`;

const countsSQL = `
with source as (${fixtureSource}), expected as (
  select md5(event_id::text || ${sqlLiteral(SUFFIX)})::uuid as event_id from source
)
select
  (select count(*) from source),
  (select count(*) from website_event
   where website_id = ${sqlLiteral(WEBSITE)}::uuid
     and event_type = 5
     and created_at >= timestamptz ${sqlLiteral(START)}
     and created_at < timestamptz ${sqlLiteral(END)}),
  (select count(*) from expected join website_event using (event_id)
   where website_event.website_id = ${sqlLiteral(WEBSITE)}::uuid
     and website_event.event_type = 5
     and website_event.created_at >= timestamptz ${sqlLiteral(START)}
     and website_event.created_at < timestamptz ${sqlLiteral(END)});
`;

export function extractRelationalSummarySQL(source) {
  const match = source.match(/`\s*(select\s+percentile_cont\(0\.5\)[\s\S]*?)`/);
  assert(match, 'Could not locate the pinned relational summary SQL');
  const sql = match[1]
    .replaceAll('${cohortQuery}', '')
    .replaceAll('${joinSessionQuery}', '')
    .replaceAll('${filterQuery}', '')
    .replaceAll('{{websiteId::uuid}}', `${sqlLiteral(WEBSITE)}::uuid`)
    .replaceAll('{{startDate}}', `timestamptz ${sqlLiteral(START)}`)
    .replaceAll('{{endDate}}', `timestamptz ${sqlLiteral(END)}`)
    .trim();
  assert(!sql.includes('${') && !sql.includes('{{') && !sql.includes('}}'), 'Summary SQL has unresolved templates');
  return sql;
}

function fixtureCounts() {
  const [sourcePageviews, performanceRows, fixtureRows] = psql(countsSQL).split('|').map(Number);
  assert([sourcePageviews, performanceRows, fixtureRows].every(Number.isInteger), 'Invalid fixture counts');
  return { source_pageviews: sourcePageviews, performance_rows: performanceRows, fixture_rows: fixtureRows };
}

function summaryFromRow(row) {
  const metric = name => ({
    p50: Number(row[`${name}_p50`] || 0),
    p75: Number(row[`${name}_p75`] || 0),
    p95: Number(row[`${name}_p95`] || 0),
  });
  return { lcp: metric('lcp'), inp: metric('inp'), cls: metric('cls'), fcp: metric('fcp'), ttfb: metric('ttfb'), count: Number(row.count || 0) };
}

function readSummary(sql) {
  const row = JSON.parse(psql(`select row_to_json(summary) from (${sql}) summary;`));
  return summaryFromRow(row);
}

function explain(sql) {
  const rows = JSON.parse(psql(`explain (analyze, buffers, format json) ${sql}`));
  assert(Array.isArray(rows) && rows[0]?.Plan, 'EXPLAIN did not return a plan');
  return rows[0];
}

function cardinalities(body) {
  const keys = ['chart', 'pages', 'pageTitles', 'devices', 'browsers'];
  for (const key of keys) assert(Array.isArray(body[key]), `Report field ${key} is not an array`);
  return Object.fromEntries(keys.map(key => [key, body[key].length]));
}

function validateSummary(summary, expectedCount) {
  assert.equal(summary.count, expectedCount, 'Report count does not match fixture');
  for (const name of METRICS) {
    for (const percentile of ['p50', 'p75', 'p95']) {
      assert(Number.isFinite(summary[name][percentile]) && summary[name][percentile] >= 0, `Invalid ${name}.${percentile}`);
    }
  }
}

async function report(headers, metric) {
  const started = performance.now();
  const response = await fetch(`${BASE}/api/reports/performance`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      websiteId: WEBSITE,
      type: 'performance',
      filters: {},
      parameters: { startDate: START, endDate: END, unit: 'day', timezone: 'Asia/Seoul', metric },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json();
  assert.equal(response.status, 200, `Performance report HTTP ${response.status}`);
  return { elapsed_ms: +(performance.now() - started).toFixed(3), body };
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  assert(args.every(value => value === '--check' || value === '--prepare'), `Unknown option(s): ${args.join(', ')}`);
  assert(!(check && args.includes('--prepare')), 'Use either --check or --prepare');

  const summarySQL = extractRelationalSummarySQL(readFileSync(SOURCE, 'utf8'));
  assert(fixtureInsertSQL.includes('on conflict(event_id) do nothing'));
  assert(!/\b(delete|update)\b/i.test(fixtureInsertSQL), 'Fixture SQL must not delete or update');
  if (check) {
    assert(summarySQL.includes('and website_event.event_type = 5'));
    console.log('performance-summary-probe --check passed');
    return;
  }

  mkdirSync(new URL('../.local/', import.meta.url), { recursive: true });
  const stamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '');
  const output = new URL(`../.local/performance-summary-probe-${stamp}.json`, import.meta.url);
  const run = {
    recorded_at: new Date().toISOString(), status: 'running', output: output.pathname,
    method: 'Sequential authenticated performance reports: one warm pass and one measured pass per metric.',
    app: BASE, db_container: DB, website_id: WEBSITE, start: START, end: END,
    upstream_commit: COMMIT, summary_source: SOURCE,
    fixture: { suffix: SUFFIX, source: 'event_type=1 pageviews in [start,end)', metrics: 'bounded positive deterministic values; INP null every seventh row' },
    passes: [], sql: { query: summarySQL, plans: [] },
    scope: 'Summary SQL timings are aggregate-query reads, not the full-route fraction.',
  };
  const checkpoint = () => writeFileSync(output, JSON.stringify({ ...run, updated_at: new Date().toISOString() }, null, 2));
  let failed = false;
  try {
    const prepared = args.includes('--prepare');
    if (prepared) {
      const inserted = Number(psql(fixtureInsertSQL));
      assert(Number.isInteger(inserted) && inserted >= 0, 'Invalid inserted-row count');
      psql('analyze website_event;');
      run.fixture.inserted_rows = inserted;
    }
    run.fixture.counts = fixtureCounts();
    assert(run.fixture.counts.source_pageviews > 0, 'No source pageviews found in fixed window');
    assert.equal(run.fixture.counts.fixture_rows, run.fixture.counts.source_pageviews, 'Prepared fixture is incomplete');
    assert.equal(run.fixture.counts.performance_rows, run.fixture.counts.source_pageviews, 'Unexpected performance-row cardinality');

    const sqlSummary = readSummary(summarySQL);
    validateSummary(sqlSummary, run.fixture.counts.fixture_rows);
    run.sql.summary = sqlSummary;
    for (let index = 0; index < 3; index++) run.sql.plans.push(explain(summarySQL));
    checkpoint();

    const login = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'umami' }), signal: AbortSignal.timeout(timeoutMs),
    });
    assert.equal(login.status, 200, 'Local test-account login failed');
    const { token } = await login.json();
    assert.equal(typeof token, 'string');
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    let expectedSummary;
    for (const pass of ['warm', 'measured']) {
      const results = [];
      for (const metric of METRICS) {
        const result = await report(headers, metric);
        validateSummary(result.body.summary, run.fixture.counts.fixture_rows);
        if (!expectedSummary) expectedSummary = result.body.summary;
        else assert.deepEqual(result.body.summary, expectedSummary, 'Report summaries differ');
        results.push({ metric, elapsed_ms: result.elapsed_ms, summary: result.body.summary, cardinalities: cardinalities(result.body) });
      }
      run.passes.push({ name: pass, reports: results });
      checkpoint();
    }
    assert.deepEqual(expectedSummary, sqlSummary, 'API summary differs from independent relational SQL');
  } catch (error) {
    failed = true;
    run.error = error instanceof Error ? error.message : String(error);
    checkpoint();
    console.error(`performance-summary-probe failed: ${run.error}`);
    process.exitCode = 1;
  } finally {
    run.status = failed ? 'failed' : 'complete';
    checkpoint();
    console.log(`${run.status}: ${output.pathname}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
