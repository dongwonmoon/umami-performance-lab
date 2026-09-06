// Local PostgreSQL check: temporary tables disappear when the transaction ends.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

assert(process.env.UMAMI_DIR, 'Set UMAMI_DIR to the patched upstream checkout');
const { default: prisma } = await import(pathToFileURL(resolve(process.env.UMAMI_DIR, 'src/lib/prisma.ts')).href);
const { getFunnel } = await import(pathToFileURL(resolve(process.env.UMAMI_DIR, 'src/queries/sql/reports/getFunnel.ts')).href);

const websiteId = randomUUID();
const startDate = new Date('2026-08-31T00:00:00+09:00');
const endDate = new Date('2026-09-01T00:00:00+09:00');
const original = prisma.rawQuery;
const lowerBound = 'and we.created_at >= {{startDate}}';
let bounded = false;
try {
  await prisma.client.$transaction(async tx => {
    for (const table of ['website_event', 'event_data']) {
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING DEFAULTS) ON COMMIT DROP`);
    }
    // The production binder is not exported; mirror only placeholder binding here.
    prisma.rawQuery = async (sql, data) => {
      assert(sql.includes(lowerBound), 'Apply the start-bound patch before this check');
      if (!bounded) sql = sql.replaceAll(lowerBound, '');
      const params = [];
      const query = sql.replaceAll(/\{\{\s*(\w+)(::\w+)?\s*}}/g, (_, name, type) => {
        params.push(data[name]);
        return `$${params.length}${type ?? ''}`;
      });
      return tx.$queryRawUnsafe(query, ...params);
    };
    const sessions = [
      { name: 'normal', rows: [[0, '/'], [10, '/pricing'], [20, '/signup']] },
      { name: 'repeated', rows: [[0, '/'], [1, '/'], [2, '/pricing'], [3, '/pricing'], [4, '/signup']] },
      { name: 'before-start', rows: [[-1, '/'], [0, '/pricing'], [1, '/signup']] },
      { name: 'over-window', rows: [[0, '/'], [61, '/pricing'], [62, '/signup']] },
      { name: 'end-boundary', rows: [[1410, '/'], [1440, '/pricing'], [1440 + 1 / 60000, '/signup']] },
      { name: 'after-end', rows: [[1441, '/'], [1442, '/pricing'], [1443, '/signup']] },
      { name: 'same-time', rows: [[0, '/'], [0, '/pricing'], [0, '/signup']] },
    ];
    for (const { name, rows } of sessions) {
      const sessionId = randomUUID();
      for (const [minutes, path] of rows) {
        const eventId = randomUUID();
        const time = new Date(startDate.getTime() + Number(minutes) * 60000);
        await tx.$executeRawUnsafe(`INSERT INTO pg_temp.website_event
          (event_id, website_id, session_id, visit_id, created_at, url_path, event_name)
          VALUES ($1::uuid, $2::uuid, $3::uuid, $3::uuid, $4, $5, $6)`,
          eventId, websiteId, sessionId, time, path, path === '/pricing' ? 'checkout' : null);
        if (path === '/pricing') await tx.$executeRawUnsafe(`INSERT INTO pg_temp.event_data
          (event_data_id, website_id, website_event_id, created_at, data_key, string_value, data_type)
          VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'plan', $5, 1)`,
          randomUUID(), websiteId, eventId, time, ['normal', 'repeated'].includes(name) ? 'pro' : 'free');
      }
    }
    const path = value => ({ type: 'path', value });
    const checks = [
      { name: 'boundaries, repeated visits, same timestamp, conversion window',
        steps: ['/', '/pricing', '/signup'].map(path), expected: [5, 4, 3] },
      { name: 'wildcard path', steps: ['/', '/pric*', '/signup'].map(path), expected: [5, 4, 3] },
      { name: 'event property filter', steps: [path('/'), { type: 'event', value: 'checkout',
        filters: [{ property: 'plan', operator: 'eq', value: 'pro' }] }, path('/signup')], expected: [5, 2, 2] },
      { name: 'eight steps, including repeated step at the same timestamp',
        steps: ['/', '/pricing', ...Array(6).fill('/signup')].map(path), expected: [5, 4, 3, 3, 3, 3, 3, 3] },
    ];
    for (const check of checks) {
      bounded = false;
      const before = await getFunnel(websiteId, { startDate, endDate, window: 60, steps: check.steps }, {});
      bounded = true;
      const after = await getFunnel(websiteId, { startDate, endDate, window: 60, steps: check.steps }, {});
      assert.deepEqual(before.map(row => row.visitors), check.expected, check.name);
      assert.deepEqual(after, before, check.name);
      console.log(`PASS: ${check.name} → ${JSON.stringify(check.expected)}`);
    }
  }, { timeout: 15000 });
} finally {
  prisma.rawQuery = original;
  await prisma.client.$disconnect();
}
