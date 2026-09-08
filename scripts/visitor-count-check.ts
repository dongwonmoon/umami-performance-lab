// Read-only compatibility check for the visitor count wrapper.
// It reconstructs only the count query without the caller's final display ORDER BY.
// This is SQL qualification, not patched-helper or HTTP/API validation.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

const ROOT = '/private/tmp/umami-qualification';
const WEBSITE = '18573f23-3e24-44ef-b580-154cf371e7fe';
const END = new Date('2026-09-06T15:00:00.000Z');
const args = process.argv.slice(2);
const check = args.includes('--check');
assert.equal(args.filter(value => value !== '--check').length, 0, 'unknown option');

const stable = value => JSON.stringify(value, (_, item) => item instanceof Date ? item.toISOString() : typeof item === 'bigint' ? `${item}n` : item);
const hash = value => createHash('sha256').update(stable(value)).digest('hex');
const orderPattern = /\s+order by max\(website_event\.created_at\) desc\s*$/i;
export function splitFinalOrder(sql) {
  const match = sql.match(orderPattern);
  assert(match && match.index !== undefined, 'visitor query final order was not found');
  const withoutOrder = sql.slice(0, match.index);
  assert.equal(withoutOrder + match[0], sql, 'final-order reconstruction changed SQL');
  return { withoutOrder, order: match[0] };
}
export function capped(count, maxResults) { return !!maxResults && count >= Number(maxResults); }

async function main() {
  if (check) {
    const sql = 'select x from website_event\n order by max(website_event.created_at) desc\n';
    const split = splitFinalOrder(sql);
    assert.equal(split.withoutOrder + split.order, sql);
    assert.equal(capped(3, undefined), false);
    assert.equal(capped(3, 2), true);
    assert.equal(capped(3, 3), true);
    assert.equal(capped(3, 4), false);
    console.log('visitor-count-check --check passed');
    return;
  }

  assert.equal(process.env.DATABASE_URL, 'postgres://umami:umami@127.0.0.1:5433/umami');
  assert(!process.env.CLICKHOUSE_URL && !process.env.DATABASE_REPLICA_URL, 'only disposable primary PostgreSQL is in scope');
  const output = `/Users/dongwon/workspace/umami-performance-lab/.local/visitor-count-check-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}.json`;
  const run = { recorded_at: new Date().toISOString(), status: 'running', output, website_id: WEBSITE, end_date: END.toISOString(), cases: [], fixture: null };
  const save = () => writeFileSync(output, JSON.stringify({ ...run, updated_at: new Date().toISOString() }, null, 2));
  let prisma;
  let originalPagedRawQuery;
  let captured;
  try {
    prisma = (await import(`${ROOT}/src/lib/prisma.ts`)).default;
    const { getWebsiteSessions } = await import(`${ROOT}/src/queries/sql/sessions/getWebsiteSessions.ts`);
    originalPagedRawQuery = prisma.pagedRawQuery;
    prisma.pagedRawQuery = async (query, params, filters, name) => {
      captured = { query, params, filters, name };
      return originalPagedRawQuery(query, params, filters, name);
    };

    const runCase = async (name, filters, expectedIsCapped, expectedCount) => {
      captured = null;
      const actual = await getWebsiteSessions(WEBSITE, filters);
      assert(captured?.query && captured?.params, `${name} did not capture visitor SQL`);
      const { query, params } = captured;
      const { withoutOrder, order } = splitFinalOrder(query);
      const page = Number(filters.page) || 1;
      const pageSize = Number(filters.pageSize) || 20;
      const maxResults = filters.maxResults;
      const countSql = queryText => maxResults
        ? `select count(*) as num from (select 1 from (${queryText}) t limit ${Number(maxResults)}) t2`
        : `select count(*) as num from (${queryText}) t`;
      const orderedCount = Number((await prisma.rawQuery(countSql(query), params))[0].num);
      const unorderedCount = Number((await prisma.rawQuery(countSql(withoutOrder), params))[0].num);
      const pageRows = await prisma.rawQuery(`${withoutOrder}${order} limit ${pageSize} offset ${pageSize * (page - 1)}`, params, captured.name);
      const reconstructed = { data: pageRows, count: unorderedCount, page, pageSize, orderBy: filters.orderBy, isCapped: capped(unorderedCount, maxResults) };
      const record = { name, input: { ...filters, startDate: filters.startDate.toISOString(), endDate: filters.endDate.toISOString() }, expected_isCapped: expectedIsCapped, expected_count: expectedCount ?? null, actual, ordered_count: orderedCount, unordered_count: unorderedCount, count_equal: orderedCount === unorderedCount && orderedCount === actual.count, page_sql_reattached_equal: withoutOrder + order === query, metadata_equal: isDeepStrictEqual(reconstructed, actual), page_data_equal: isDeepStrictEqual(pageRows, actual.data), query_hash: hash(query), params_hash: hash(params) };
      run.cases.push(record);
      assert.equal(record.count_equal, true, `${name} count changed`);
      assert.equal(record.page_sql_reattached_equal, true, `${name} page SQL changed`);
      assert.equal(record.metadata_equal, true, `${name} metadata reconstruction changed`);
      assert.equal(record.page_data_equal, true, `${name} page rows changed`);
      assert.equal(actual.isCapped, expectedIsCapped, `${name} unexpected cap state`);
      if (expectedCount !== undefined) assert.equal(actual.count, expectedCount, `${name} unexpected count`);
      return actual;
    };

    const emptyRange = { startDate: new Date('2020-01-01T00:00:00.000Z'), endDate: new Date('2020-01-02T00:00:00.000Z'), page: 1, pageSize: 20 };
    await runCase('empty', emptyRange, false, 0);
    const range7 = { startDate: new Date(+END - 7 * 86400000), endDate: END, page: 1, pageSize: 20 };
    const sevenDay = await runCase('7d', range7, false);
    const sevenQuery = captured.query;
    const sevenParams = captured.params;
    assert(sevenDay.count > 0, '7d fixture must be nonempty');
    const sevenCount = sevenDay.count;
    await runCase('181d', { startDate: new Date(+END - 181 * 86400000), endDate: END, page: 1, pageSize: 20 }, false);
    await runCase('7d-cap-below', { ...range7, maxResults: Math.max(1, sevenCount - 1) }, true);
    await runCase('7d-cap-at', { ...range7, maxResults: sevenCount }, true);
    await runCase('7d-cap-above', { ...range7, maxResults: sevenCount + 1 }, false);
    const hostname = sevenDay.data[0]?.hostname;
    assert(hostname, '7d fixture has no hostname for filtered case');
    await runCase('7d-search', { ...range7, search: 'Chrome' }, false);
    await runCase('7d-browser', { ...range7, browser: 'Chrome' }, false);
    await runCase('7d-hostname', { ...range7, hostname }, false);
    await runCase('7d-page2', { ...range7, page: 2, pageSize: 20 }, false);

    const fixtureCtes = `
      with session(session_id, website_id, browser, os, device, screen, language, country, region, city) as (
        values ('00000000-0000-0000-0000-000000000001'::uuid, '${WEBSITE}'::uuid, 'Chrome', 'macOS', 'desktop', '1440x900', 'en', 'KR', 'Seoul', 'Seoul')
      ), website_event(session_id, website_id, hostname, created_at, event_type, visit_id, distinct_id) as (
        values
          ('00000000-0000-0000-0000-000000000001'::uuid, '${WEBSITE}'::uuid, 'host-a.example', timestamptz '2026-09-01T00:00:00Z', 1, '00000000-0000-0000-0000-000000000011'::uuid, 'fixture-a'),
          ('00000000-0000-0000-0000-000000000001'::uuid, '${WEBSITE}'::uuid, 'host-a.example', timestamptz '2026-09-01T00:00:00Z', 1, '00000000-0000-0000-0000-000000000012'::uuid, 'fixture-a'),
          ('00000000-0000-0000-0000-000000000001'::uuid, '${WEBSITE}'::uuid, 'host-b.example', timestamptz '2026-09-01T00:00:00Z', 1, '00000000-0000-0000-0000-000000000013'::uuid, 'fixture-b')
      )`;
    // Shadow the two tables, but execute the actual captured visitor query.
    const fixtureSql = fixtureCtes + sevenQuery;
    const fixtureOrder = splitFinalOrder(fixtureSql);
    const fixtureCount = queryText => `select count(*) as num from (select 1 from (${queryText}) t) t2`;
    const fixtureOrdered = Number((await prisma.rawQuery(fixtureCount(fixtureSql), sevenParams))[0].num);
    const fixtureUnordered = Number((await prisma.rawQuery(fixtureCount(fixtureOrder.withoutOrder), sevenParams))[0].num);
    const fixtureRows = await prisma.rawQuery(fixtureOrder.withoutOrder + fixtureOrder.order, sevenParams);
    run.fixture = { expected_groups: 2, ordered_count: fixtureOrdered, unordered_count: fixtureUnordered, count_groups_not_ids: fixtureOrdered === 2 && fixtureUnordered === 2, tied_latest_timestamp: true, hostnames: fixtureRows.map(row => row.hostname), query_hash: hash(fixtureSql) };
    assert.equal(fixtureOrdered, 2, 'fixture must count hostname groups, not session IDs');
    assert.equal(fixtureUnordered, 2, 'fixture unordered count changed groups');
    assert.equal(new Set(fixtureRows.map(row => row.hostname)).size, 2, 'fixture host groups collapsed');
    assert.equal(fixtureRows.length, 2, 'fixture page rows changed');
    assert.deepEqual(fixtureRows.map(row => [row.hostname, Number(row.views), Number(row.visits), Number(row.events)]).sort(), [
      ['host-a.example', 2, 2, 0], ['host-b.example', 1, 1, 0],
    ]);
    assert(fixtureRows.every(row => new Date(row.lastAt).toISOString() === '2026-09-01T00:00:00.000Z'));
    run.fixture.cap_checks = [];
    for (const cap of [1, 2, 3]) {
      const ordered = await originalPagedRawQuery(fixtureSql, sevenParams, { ...range7, maxResults: cap });
      const unordered = Number((await prisma.rawQuery(`select count(*) as num from (select 1 from (${fixtureOrder.withoutOrder}) t limit ${cap}) t2`, sevenParams))[0].num);
      assert.equal(ordered.count, Math.min(2, cap));
      assert.equal(unordered, ordered.count);
      assert.equal(ordered.isCapped, cap <= 2);
      run.fixture.cap_checks.push({ cap, count: unordered, isCapped: ordered.isCapped });
    }
    run.status = 'complete';
  } catch (error) {
    run.status = 'failed';
    run.error = error instanceof Error ? error.message : String(error);
    console.error(run.error);
    process.exitCode = 1;
  } finally {
    if (prisma) {
      if (originalPagedRawQuery) prisma.pagedRawQuery = originalPagedRawQuery;
      try { await prisma.client?.$disconnect?.(); } catch (error) { run.error = `disconnect: ${error instanceof Error ? error.message : String(error)}`; run.status = 'failed'; process.exitCode = 1; }
    }
    if (run.status === 'complete') { run.finished = new Date().toISOString(); save(); console.log(output); }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
