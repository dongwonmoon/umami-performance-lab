import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

import { check } from './deployment-smoke.mjs';

const websiteId = '11111111-1111-4111-8111-111111111111';
const token = 'test-token';
const readJson = async request => {
  let body = '';
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : null;
};

async function fixture({ store = true } = {}) {
  const events = [];
  const requests = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const body = request.method === 'POST' ? await readJson(request) : null;
    requests.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });
    if (url.pathname === '/api/auth/login') {
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ token }));
    }
    if (url.pathname === `/api/websites/${websiteId}`) {
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ domain: 'deployment-smoke.invalid' }));
    }
    if (url.pathname === `/api/websites/${websiteId}/stats`) {
      const startAt = Number(url.searchParams.get('startAt'));
      const endAt = Number(url.searchParams.get('endAt'));
      const marker = (url.searchParams.get('path') || '').replace(/^eq\./, '');
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ pageviews: events.filter(event => event.path === marker && event.createdAt >= startAt && event.createdAt <= endAt).length }));
    }
    if (url.pathname === '/api/send') {
      if (store) events.push({ path: body?.payload?.url, createdAt: Date.now() });
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ cache: 'cache-token' }));
    }
    response.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}`, requests, close: () => new Promise(resolve => server.close(resolve)) };
}

const envFor = baseUrl => ({ UMAMI_BASE_URL: baseUrl, UMAMI_WEBSITE_ID: websiteId, UMAMI_USERNAME: 'admin', UMAMI_PASSWORD: 'secret' });

test('deployment check sends one marker event and observes exactly one pageview', async () => {
  const server = await fixture();
  try {
    const result = await check({ env: envFor(server.baseUrl), pollIntervalMs: 1, deadlineMs: 500 });
    assert.equal(result.pageviews, 1);
    assert.match(result.marker, /^\/deployment-smoke\/[0-9a-f-]{36}$/);
    assert.equal(server.requests.filter(request => request.path === '/api/send').length, 1);
  } finally { await server.close(); }
});

test('deployment check fails when send returns 200 but the event is not stored', async () => {
  const server = await fixture({ store: false });
  try {
    await assert.rejects(check({ env: envFor(server.baseUrl), pollIntervalMs: 1, deadlineMs: 20 }), /stage=poll/);
  } finally { await server.close(); }
});

test('unsafe target is rejected before login or send', async () => {
  const server = await fixture();
  try {
    await assert.rejects(check({ env: { ...envFor(`${server.baseUrl}/unsafe`), UMAMI_BASE_URL: `${server.baseUrl}/unsafe` } }), /stage=target/);
    assert.equal(server.requests.length, 0);
  } finally { await server.close(); }
});

test('CLI emits compact JSON on stdout on success', async () => {
  const server = await fixture();
  try {
    const child = spawn(process.execPath, ['scripts/deployment-smoke.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, ...envFor(server.baseUrl) } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const [code] = await once(child, 'close');
    assert.equal(code, 0);
    assert.deepEqual(Object.keys(JSON.parse(stdout)), ['marker', 'pageviews']);
    assert.equal(stderr, '');
  } finally { await server.close(); }
});

test('CLI rejects unsafe target without leaking credentials', async () => {
  const child = spawn(process.execPath, ['scripts/deployment-smoke.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, UMAMI_BASE_URL: 'http://user:secret@127.0.0.1:3011/private', UMAMI_WEBSITE_ID: websiteId, UMAMI_USERNAME: 'admin', UMAMI_PASSWORD: 'secret' } });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'close');
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /^stage=target status=0\n$/);
  assert.equal(stderr.includes('secret'), false);
});
