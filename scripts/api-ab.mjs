// Read-only paired requests against the two disposable production builds.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const output = new URL('../.local/api-ab.json', import.meta.url);
const variants = { before: 'http://127.0.0.1:3001', after: 'http://127.0.0.1:3002' };
const headers = {};
for (const [name, base] of Object.entries(variants)) {
  const health = await fetch(`${base}/api/heartbeat`, { signal: AbortSignal.timeout(10000) });
  assert.equal(health.status, 200);
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'umami' }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(login.status, 200);
  const { token } = await login.json();
  assert.equal(typeof token, 'string');
  headers[name] = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}
const cases = ['expanded-7d', 'expanded-30d', 'expanded-all', 'ui-last7days'].map(name => {
  const saved = JSON.parse(readFileSync(new URL(`../evidence/2026-09-06/umami-probe-20260906-${name}.json`, import.meta.url), 'utf8'));
  return { name, ...saved, results: Object.fromEntries(['overview', 'funnel'].map(endpoint => [endpoint,
    { before: [], after: [], response: saved.measurements[endpoint].response }])) };
});
const started = new Date().toISOString();
for (let round = -2; round < 40; round++) {
  for (const item of cases) {
    for (const endpoint of ['overview', 'funnel']) {
      const { path, ...options } = item.requests[endpoint];
      for (const variant of round % 2 === 0 ? ['before', 'after'] : ['after', 'before']) {
        const start = performance.now();
        const response = await fetch(`${variants[variant]}${path}`, {
          ...options, headers: headers[variant], signal: AbortSignal.timeout(10000),
        });
        const body = await response.json();
        const ms = performance.now() - start;
        assert.equal(response.status, 200, `${item.name}/${endpoint}/${variant}`);
        assert.deepEqual(body, item.results[endpoint].response, `${item.name}/${endpoint}/${variant}: response changed`);
        if (round >= 0) item.results[endpoint][variant].push(ms);
      }
    }
  }
}
const quantile = (values, q) => +[...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1].toFixed(1);
for (const item of cases) {
  for (const result of Object.values(item.results)) {
    result.summary = Object.fromEntries(Object.keys(variants).map(variant => [variant, {
      n: result[variant].length, p50_ms: quantile(result[variant], 0.5), p95_ms: quantile(result[variant], 0.95),
      half_p50_ms: [quantile(result[variant].slice(0, 20), 0.5), quantile(result[variant].slice(20), 0.5)],
    }]));
  }
  console.log(JSON.stringify({ range: item.name, ...Object.fromEntries(Object.entries(item.results).map(([key, value]) => [key, value.summary])) }));
}
const images = JSON.parse(execFileSync('docker', ['image', 'inspect', 'umami-funnel:before', 'umami-funnel:after']));
mkdirSync(new URL('../.local/', import.meta.url), { recursive: true });
writeFileSync(output, JSON.stringify({
  started, finished: new Date().toISOString(),
  method: 'Two warmup rounds and 40 measured rounds; A/B order alternates; sequential requests; fixed dates/DB; exact full JSON equality to prior official-image responses on every call. Times include fetch and JSON decode, exclude login.',
  images: images.map(image => ({ id: image.Id, tags: image.RepoTags, architecture: image.Architecture, layers: image.RootFS.Layers })),
  cases: cases.map(({ name, websiteId, startDate, endDate, requests, results }) => ({ name, websiteId, startDate, endDate, requests, results })),
}, null, 2));
console.log(`Saved ${output}`);
