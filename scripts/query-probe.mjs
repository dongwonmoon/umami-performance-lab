// Read-only probe for the disposable localhost Umami qualification instance.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

const [websiteId, startDate, endDate, output] = process.argv.slice(2);
assert(websiteId && output && Date.parse(startDate) < Date.parse(endDate),
  'Usage: node umami-query-probe.mjs WEBSITE_ID START_ISO END_ISO OUTPUT_JSON');
const base = 'http://127.0.0.1:3000';
const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'umami' }),
  signal: AbortSignal.timeout(10000),
});
assert.equal(login.status, 200, 'Local test-account login failed');
const { token } = await login.json();
assert.equal(typeof token, 'string');
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const parameters = { startDate, endDate };
const report = (type, extra) => ({
  path: `/api/reports/${type}`, method: 'POST',
  body: JSON.stringify({ websiteId, type, filters: {}, parameters: { ...parameters, ...extra } }),
});
const endpoints = {
  overview: { path: `/api/websites/${websiteId}/stats?startAt=${Date.parse(startDate)}&endAt=${Date.parse(endDate)}` },
  funnel: report('funnel', {
    window: 60, steps: ['/', '/pricing', '/signup'].map(value => ({ type: 'path', value })),
  }),
};
const measurements = Object.fromEntries(Object.keys(endpoints).map(k => [k, { samples_ms: [] }]));
for (let round = -2; round < 20; round++) {
  for (const [name, { path, ...options }] of Object.entries(endpoints)) {
    const started = performance.now();
    const response = await fetch(`${base}${path}`, { ...options, headers, signal: AbortSignal.timeout(10000) });
    const body = await response.json();
    const elapsed = performance.now() - started;
    assert.equal(response.status, 200, `${name}: HTTP ${response.status}`);
    if (name === 'overview') assert(Number.isFinite(body.pageviews) && body.pageviews > 0);
    if (name === 'funnel') assert(body.length === 3 && body[0].visitors > 0);
    const measurement = measurements[name];
    if ('response' in measurement) assert.deepEqual(body, measurement.response, `${name}: response changed`);
    measurement.response = body;
    if (round >= 0) measurement.samples_ms.push(elapsed);
  }
}
for (const measurement of Object.values(measurements)) {
  const sorted = [...measurement.samples_ms].sort((a, b) => a - b);
  measurement.p50_ms = sorted[Math.ceil(sorted.length * 0.5) - 1];
  measurement.p95_ms = sorted[Math.ceil(sorted.length * 0.95) - 1];
}
writeFileSync(output, JSON.stringify({
  recorded_at: new Date().toISOString(), websiteId, startDate, endDate,
  method: 'Node fetch, sequential round-robin, two warmups, 20 samples, nearest-rank quantiles; no concurrent ingestion',
  requests: endpoints, measurements,
}, null, 2));
console.log(JSON.stringify(Object.fromEntries(Object.entries(measurements).map(([k, v]) => [k, {
  n: v.samples_ms.length, p50_ms: +v.p50_ms.toFixed(1), p95_ms: +v.p95_ms.toFixed(1),
}]))));
console.log(`Saved ${output}`);
