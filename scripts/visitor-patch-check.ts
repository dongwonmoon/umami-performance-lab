// Run once per checkout with that checkout's tsconfig. Compare outputs separately.
// Exercises the real query/helper/DB, not HTTP authentication or a production build.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

async function main() {
  if (process.argv[2] === '--compare') {
    const baseline = JSON.parse(readFileSync(process.argv[3], 'utf8'));
    const candidate = JSON.parse(readFileSync(process.argv[4], 'utf8'));
    assert.equal(baseline.status, 'complete');
    assert.equal(candidate.status, 'complete');
    assert.equal(baseline.cases.length, 16);
    assert.equal(candidate.cases.length, 16);
    const normalize = sql => sql.replace(/\s+/g, ' ').trim();
    baseline.cases.forEach((before, i) => {
      const after = candidate.cases[i];
      assert.equal(before.name, after.name);
      assert.deepEqual(before.result, after.result, `${before.name}: response`);
      assert.equal(normalize(before.queries[1].sql), normalize(after.queries[1].sql), `${before.name}: page SQL`);
      assert.deepEqual(before.queries.map(q => q.params), after.queries.map(q => q.params));
      assert.match(before.queries[0].sql, /order by max\(website_event.created_at\) desc/);
      assert.doesNotMatch(after.queries[0].sql, /order by/i);
    });
    console.log('16/16 responses, page SQL and parameters equal; candidate counts unordered');
    return;
  }
  const [root, output] = process.argv.slice(2);
  assert(root?.startsWith('/private/tmp/umami-'));
  assert(output && resolve(output).startsWith(`${process.cwd()}/.local/`));
  assert.equal(process.env.DATABASE_URL, 'postgres://umami:umami@127.0.0.1:5433/umami');
  assert(!process.env.CLICKHOUSE_URL && !process.env.DATABASE_REPLICA_URL);
  const prisma = (await import(`${root}/src/lib/prisma.ts`)).default;
  const { getWebsiteSessions } = await import(`${root}/src/queries/sql/sessions/getWebsiteSessions.ts`);
  const raw = prisma.client.$queryRawUnsafe.bind(prisma.client);
  const paged = prisma.pagedRawQuery;
  const websiteId = '18573f23-3e24-44ef-b580-154cf371e7fe';
  const endDate = new Date('2026-09-06T15:00:00Z');
  const base = { startDate: new Date(+endDate - 7 * 86400000), endDate, page: 1, pageSize: 20 };
  const cases: any[] = [];
  let queries: any[] = [];
  prisma.client.$queryRawUnsafe = async (sql, ...params) => {
    assert(/^\s*(select|with)\b/i.test(sql), 'only SELECT/CTE queries expected');
    queries.push({ sql, params });
    return raw(sql, ...params);
  };
  const fixture = `with session as (
    select '00000000-0000-0000-0000-000000000001'::uuid as session_id,
      '${websiteId}'::uuid as website_id, 'Chrome' as browser, 'macOS' as os,
      'desktop' as device, '1440x900' as screen, 'en' as language,
      'KR' as country, 'Seoul' as region, 'Seoul' as city
  ), website_event as (
    select s.session_id, s.website_id, e.hostname,
      timestamp '2026-09-01 00:00:00' as created_at, 1 as event_type, e.visit_id
    from session s cross join (values
      ('host-a.example', '00000000-0000-0000-0000-000000000011'::uuid),
      ('host-a.example', '00000000-0000-0000-0000-000000000012'::uuid),
      ('host-b.example', '00000000-0000-0000-0000-000000000013'::uuid)
    ) e(hostname, visit_id)
  ) `;
  // Only substitute table inputs; preserve actual helper arguments, including defaults.
  let fixtureMode = false;
  prisma.pagedRawQuery = (query, params, filters, ...rest) =>
    paged(fixtureMode ? fixture + query : query, params, filters, ...rest);
  const run = async (name, filters, expectedCount?: number, expectedCapped = false) => {
    queries = [];
    const result = await getWebsiteSessions(websiteId, filters);
    assert.equal(queries.length, 2, `${name}: count and page must remain separate`);
    assert.equal(result.orderBy, undefined, `${name}: unexpected response orderBy`);
    assert.equal(result.isCapped, expectedCapped, `${name}: capped state`);
    if (expectedCount !== undefined) assert.equal(result.count, expectedCount, name);
    assert(result.data.every((row, i, rows) => i === 0 || +new Date(rows[i - 1].lastAt) >= +new Date(row.lastAt)));
    cases.push({ name, result, queries });
    return result;
  };
  try {
    await run('empty', { ...base, startDate: new Date('2020-01-01'), endDate: new Date('2020-01-02') }, 0);
    const seven = await run('7d', base);
    assert(seven.count > 1);
    await run('7d-under-cap', { ...base, maxResults: 10000 }, seven.count);
    await run('7d-at-cap', { ...base, maxResults: seven.count }, seven.count, true);
    await run('7d-over-cap', { ...base, maxResults: seven.count - 1 }, seven.count - 1, true);
    await run('181d-capped', { ...base, startDate: new Date(+endDate - 181 * 86400000), maxResults: 10000 }, 10000, true);
    await run('search', { ...base, search: 'Chrome' });
    await run('browser', { ...base, browser: 'Chrome' });
    await run('hostname', { ...base, hostname: seven.data[0].hostname });
    await run('page2', { ...base, page: 2 });
    fixtureMode = true;
    const rows = (await run('fixture', base, 2)).data;
    assert.deepEqual(rows.map(r => [r.hostname, Number(r.views), Number(r.visits), Number(r.events)]).sort(), [
      ['host-a.example', 2, 2, 0], ['host-b.example', 1, 1, 0],
    ]);
    for (const cap of [1, 2, 3]) {
      await run(`fixture-cap-${cap}`, { ...base, maxResults: cap }, Math.min(2, cap), cap <= 2);
    }
    await run('fixture-page2', { ...base, page: 2, pageSize: 1 }, 2);
    await run('fixture-past-end', { ...base, page: 4, pageSize: 1 }, 2);
  } finally {
    prisma.pagedRawQuery = paged;
    prisma.client.$queryRawUnsafe = raw;
    await prisma.client.$disconnect();
  }
  writeFileSync(output, JSON.stringify({ root, status: 'complete', cases }, null, 2));
  console.log(`${output}: ${cases.length} cases passed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
