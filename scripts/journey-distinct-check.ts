// Compare the pinned journey query with only its outer SELECT DISTINCT removed.
// This is a query-boundary diagnostic, not an HTTP or performance test.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.UMAMI_DIR ?? '/private/tmp/umami-qualification';
const EXPECTED_COMMIT = process.env.UMAMI_EXPECTED_COMMIT ?? 'ca661c7057984aa98ed4f7083d84dae2f65bfcb0';
const WEBSITE = '18573f23-3e24-44ef-b580-154cf371e7fe';
const END = '2026-09-06T15:00:00.000Z';
const smoke = process.argv.includes('--smoke');
const check = process.argv.includes('--check');
const ties = process.argv.includes('--ties');
const oracle = process.argv.includes('--oracle');
const unknown = process.argv.slice(2).filter(value => !['--smoke', '--check', '--ties', '--oracle'].includes(value));
assert.equal(unknown.length, 0, `Unknown option(s): ${unknown.join(', ')}`);
assert(!(smoke && ties), 'Choose --smoke or --ties');
assert(!(oracle && (smoke || ties)), 'Oracle needs the complete historical case set');

const stable = (value: any): string => JSON.stringify(value, (_, item) => {
  if (item instanceof Date) return item.toISOString();
  if (typeof item === 'bigint') return `${item}n`;
  if (item && typeof item === 'object' && !Array.isArray(item)) return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
  return item;
});
const hash = (sql: string, params: any) => createHash('sha256').update(`${sql}\0${stable(params)}`).digest('hex');
const canonicalRows = (rows: any[]) => rows.map(row => stable(row)).sort();
const removeOuterDistinct = (sql: string) => {
  const pattern = /(\bWITH\s+events\s+AS\s*\(\s*select\s+)distinct\b/i;
  assert.equal((sql.match(new RegExp(pattern.source, 'gi')) ?? []).length, 1, 'expected one outer journey SELECT DISTINCT');
  const rewritten = sql.replace(pattern, '$1');
  assert.notEqual(rewritten, sql, 'outer journey SELECT DISTINCT was not removed');
  return rewritten;
};

// Statement-local synthetic input only: no inserts, temp tables or schema changes.
function fixtureCTE(tied: boolean, reverse: boolean) {
  const rows = [
    [1, 0, '/start'], [1, 1, '/a'], [1, tied ? 1 : 2, '/b'], [1, 3, '/end'],
    [2, 0, '/same'], [2, tied ? 0 : 1, '/same'], [2, 2, '/end'],
    [3, 0, null], [3, 1, '/finish'],
  ];
  if (reverse) rows.reverse();
  const values = rows.map(([visit, second, path]) =>
    `('${WEBSITE}'::uuid, '00000000-0000-0000-0000-${String(visit).padStart(12, '0')}'::uuid,
      timestamptz '2026-09-01T00:00:00Z' + interval '${second} seconds',
      ${path === null ? 'NULL::text' : `'${path}'::text`}, ''::text, ''::text)`).join(',');
  return `WITH website_event(website_id,visit_id,created_at,url_path,event_name,referrer_path)
    AS MATERIALIZED (VALUES ${values}), events AS (`;
}

function dateRange(days: number) {
  const end = new Date(END);
  return { startDate: new Date(end.getTime() - days * 86400000), endDate: end };
}
function makeCase(name: string, days: number, view: 'views' | 'events' | 'all', steps: number, extra: any = {}) {
  const range = dateRange(days);
  return { name, basic: days === 7 && !extra.browser && !extra.startStep && !extra.endStep, parameters: { ...range, steps, ...(extra.startStep ? { startStep: extra.startStep } : {}), ...(extra.endStep ? { endStep: extra.endStep } : {}) }, filters: { ...(view === 'all' ? {} : { eventType: view === 'views' ? 1 : 2 }), ...(extra.browser ? { browser: extra.browser } : {}) } };
}

async function main() {
  if (check) {
    assert.equal(removeOuterDistinct('WITH events AS ( select distinct x from t )').replace(/\s+/g, ' '), 'WITH events AS ( select x from t )');
    assert.deepEqual(canonicalRows([{ items: ['b'], count: 1 }, { items: ['a'], count: 2 }]), canonicalRows([{ items: ['a'], count: 2 }, { items: ['b'], count: 1 }]));
    console.log('journey-distinct-check --check passed');
    return;
  }

  const output = fileURLToPath(new URL(`../.local/journey-distinct-check-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}.json`, import.meta.url));
  mkdirSync(new URL('../.local/', import.meta.url), { recursive: true });
  const run: any = { recorded_at: new Date().toISOString(), status: 'running', output, smoke, ties, oracle, website_id: WEBSITE, end_date: END, cases: [], omitted_cases: [{ name: 'cohort', reason: 'No cohort fixture was assumed; cohort filters omitted.' }], errors: [] };
  const save = () => writeFileSync(output, JSON.stringify({ ...run, updated_at: new Date().toISOString() }, null, 2));
  let prisma: any;
  let originalRawQuery: any;
  let variant = 'baseline';
  let activeFixture: any;

  try {
    const databaseUrl = process.env.DATABASE_URL;
    assert(databaseUrl, 'DATABASE_URL must be supplied externally');
    const parsedUrl = new URL(databaseUrl);
    assert.equal(parsedUrl.protocol, 'postgres:', 'DATABASE_URL must use postgres://');
    assert.equal(parsedUrl.hostname, '127.0.0.1');
    assert.equal(parsedUrl.port, '5433');
    assert.equal(parsedUrl.pathname, '/umami');
    assert(!process.env.CLICKHOUSE_URL && !process.env.DATABASE_REPLICA_URL, 'Only the local primary PostgreSQL is in scope');
    const sourcePath = 'src/queries/sql/reports/getJourney.ts';
    run.upstream_commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    assert.equal(run.upstream_commit, EXPECTED_COMMIT);
    assert.equal(execFileSync('git', ['diff', 'HEAD', '--', sourcePath], { cwd: ROOT, encoding: 'utf8' }), '', 'Journey source must remain unmodified');

    prisma = (await import(`${ROOT}/src/lib/prisma.ts`)).default;
    const { getJourney } = await import(`${ROOT}/src/queries/sql/reports/getJourney.ts`);
    originalRawQuery = prisma.rawQuery;
    const cases: any[] = [];
    for (const view of ['views', 'events', 'all'] as const) for (const steps of [3, 7]) cases.push(makeCase(`7d-${view}-${steps}`, 7, view, steps));
    cases.push(makeCase('30d-all-3', 30, 'all', 3));
    cases.push(makeCase('181d-views-3', 181, 'views', 3));
    if (smoke) cases.splice(1);
    if (ties) {
      cases.length = 0;
      for (const tied of [false, true]) for (const reverse of [false, true]) for (const steps of [3, 7]) {
        cases.push({ ...makeCase(`fixture-${tied ? 'tied' : 'unique'}-${reverse ? 'reverse' : 'forward'}-${steps}`, 7, 'all', steps), fixture: { tied, reverse } });
      }
    }

    const calls: any[] = [];
    prisma.rawQuery = async (sql: string, params: any, name?: string) => {
      assert.equal(typeof sql, 'string', 'journey rawQuery SQL must be a string');
      let rewritten = variant === 'candidate' ? removeOuterDistinct(sql) : sql;
      if (oracle) {
        assert(/limit 100\s*$/i.test(rewritten), 'Expected final Journey limit');
        rewritten = rewritten.replace(/limit 100\s*$/i, '');
      }
      if (activeFixture) rewritten = rewritten.replace(/WITH\s+events\s+AS\s*\(/i, fixtureCTE(activeFixture.tied, activeFixture.reverse));
      calls.push({ variant, sql: rewritten, params, hash: hash(rewritten, params), name: name ?? null });
      return originalRawQuery(rewritten, params, name);
    };

    const runCase = async (testCase: any) => {
      calls.length = 0;
      activeFixture = testCase.fixture;
      const execute = async (name: string) => {
        variant = name;
        try { return { result: await getJourney(WEBSITE, testCase.parameters, testCase.filters), error: null }; }
        catch (error) { return { result: null, error: error instanceof Error ? error.message : String(error) }; }
      };
      const baseline = await execute('baseline');
      const candidate = await execute('candidate');
      const exact = baseline.error || candidate.error ? false : isDeepStrictEqual(baseline.result, candidate.result);
      const canonical = baseline.error || candidate.error ? false : isDeepStrictEqual(canonicalRows(baseline.result), canonicalRows(candidate.result));
      const record = { ...testCase, parameters: { ...testCase.parameters, startDate: testCase.parameters.startDate.toISOString(), endDate: testCase.parameters.endDate.toISOString() }, baseline: baseline.result, candidate: candidate.result, baseline_error: baseline.error, candidate_error: candidate.error, exact_json_equal: exact, canonical_row_multiset_equal: canonical, query_calls: calls.splice(0) };
      run.cases.push(record); save();
      if (baseline.error || candidate.error) throw new Error(`${testCase.name} query failed`);
      if (testCase.basic) assert(baseline.result.length > 0, `${testCase.name} baseline unexpectedly empty`);
      if (!canonical) run.errors.push(`${testCase.name} canonical row multiset mismatch`);
      return baseline.result;
    };

    let firstBasic: any;
    for (const testCase of cases) {
      const result = await runCase(testCase);
      if (ties) assert.equal(result.reduce((sum: number, row: any) => sum + row.count, 0), 3, 'Fixture must retain all three visits');
      if (!firstBasic && testCase.name === '7d-views-3') firstBasic = result;
    }
    if (ties) {
      run.input_order_checks = [];
      for (const kind of ['unique', 'tied']) for (const steps of [3, 7]) {
        const forward = run.cases.find((c: any) => c.name === `fixture-${kind}-forward-${steps}`);
        const reverse = run.cases.find((c: any) => c.name === `fixture-${kind}-reverse-${steps}`);
        const equal = isDeepStrictEqual(canonicalRows(forward.baseline), canonicalRows(reverse.baseline));
        run.input_order_checks.push({ kind, steps, baseline_multiset_equal: equal });
        if (kind === 'unique') assert(equal, 'Unique timestamps must be independent of physical input order');
      }
    }
    if (smoke || ties) return;
    assert(firstBasic?.[0]?.items?.length, 'no nonempty journey value available for browser/start/end case');
    await runCase(makeCase('7d-views-chrome-3', 7, 'views', 3, { browser: 'Chrome' }));
    await runCase(makeCase('7d-views-start-end-3', 7, 'views', 3, { startStep: firstBasic[0].items[0], endStep: firstBasic[0].items.filter(Boolean).at(-1) }));
  } catch (error) {
    run.status = 'failed';
    run.errors.push(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    if (prisma) {
      if (originalRawQuery) prisma.rawQuery = originalRawQuery;
      try { await prisma.client?.$disconnect?.(); } catch (error) { run.errors.push(`disconnect: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (run.status === 'running') run.status = run.errors.length ? 'failed' : 'complete';
    if (run.status === 'failed') process.exitCode = 1;
    save();
    console.log(`Cumulative output: ${output}`);
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
