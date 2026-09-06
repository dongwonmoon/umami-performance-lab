import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

assert(process.env.UMAMI_DIR, 'Set UMAMI_DIR to the upstream checkout');
const { default: prisma } = await import(pathToFileURL(resolve(process.env.UMAMI_DIR, 'src/lib/prisma.ts')).href);
const { getFunnel } = await import(pathToFileURL(resolve(process.env.UMAMI_DIR, 'src/queries/sql/reports/getFunnel.ts')).href);

const websiteId = '18573f23-3e24-44ef-b580-154cf371e7fe';
const endDate = new Date('2026-09-07T00:00:00+09:00');
const original = prisma.rawQuery;
const evidence = [];
try {
  for (const [window, start] of [['7d', '2026-08-31T00:00:00+09:00'],
    ['30d', '2026-08-08T00:00:00+09:00'], ['all', '2026-03-10T00:00:00+09:00']]) {
    let query;
    prisma.rawQuery = async (sql, parameters, name) => {
      query = { sql, parameters };
      return original(sql, parameters, name);
    };
    await getFunnel(websiteId, { startDate: new Date(start), endDate, window: 60,
      steps: ['/', '/pricing', '/signup'].map(value => ({ type: 'path', value })) }, {});
    prisma.rawQuery = original;
    // Keep A unbounded when this check is rerun against the patched source.
    query.sql = query.sql.replaceAll('and we.created_at >= {{startDate}}', '');
    const needle = 'and we.created_at <= {{endDate}}';
    assert.equal(query.sql.split(needle).length - 1, 2);
    const candidate = query.sql.replaceAll(needle,
      'and we.created_at >= {{startDate}}\n                and we.created_at <= {{endDate}}');
    const samples = { original: [], bounded: [] };
    let expected;
    for (let round = -2; round < 20; round++) {
      const order = round % 2 === 0 ? ['original', 'bounded'] : ['bounded', 'original'];
      for (const variant of order) {
        const started = performance.now();
        const result = await original(variant === 'original' ? query.sql : candidate, query.parameters);
        const ms = performance.now() - started;
        expected ??= result;
        assert.deepEqual(result, expected, `${window}/${variant}: result differs`);
        if (round >= 0) samples[variant].push(ms);
      }
    }
    const plans = {};
    for (const [variant, sql] of Object.entries({ original: query.sql, bounded: candidate })) {
      const explained = await original(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, query.parameters);
      plans[variant] = explained[0]['QUERY PLAN'][0];
    }
    const summary = Object.fromEntries(Object.entries(samples).map(([name, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return [name, { p50_ms: +sorted[9].toFixed(1), p95_ms: +sorted[18].toFixed(1) }];
    }));
    evidence.push({ window, ...query, candidate, samples, plans, result: expected, summary });
    console.log(JSON.stringify({ window, result: expected, summary }));
  }
  mkdirSync(new URL('../.local/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../.local/sql-ab.json', import.meta.url), JSON.stringify({
    method: 'SQL-only, local upstream Prisma client; two warmups and 20 measured alternating A/B rounds per range; exact output equality each call',
    evidence,
  }, null, 2));
} finally {
  prisma.rawQuery = original;
  await prisma.client.$disconnect();
}
