import { randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const USER_AGENT = 'Mozilla/5.0 (deployment-smoke) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';

class SmokeError extends Error {
  constructor(stage, status = 0) { super(`stage=${stage} status=${status}`); this.stage = stage; this.status = status; }
}

function target(value) {
  let url;
  try { url = new URL(value); } catch { throw new SmokeError('target'); }
  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname) || url.username || url.password || (url.pathname !== '' && url.pathname !== '/') || url.search || url.hash) throw new SmokeError('target');
  return url.origin;
}

function required(env, name) {
  if (!env[name]) throw new SmokeError('config');
  return env[name];
}

async function request(base, path, options, stage, timeoutMs, deadlineAt) {
  const remaining = deadlineAt === undefined ? timeoutMs : deadlineAt - Date.now();
  if (remaining <= 0) throw new SmokeError(stage);
  let response;
  try { response = await fetch(`${base}${path}`, { ...options, redirect: 'error', signal: AbortSignal.timeout(Math.min(timeoutMs, remaining)) }); }
  catch { throw new SmokeError(stage); }
  if (!response.ok) throw new SmokeError(stage, response.status);
  try { return { status: response.status, body: await response.json() }; }
  catch { throw new SmokeError(stage, response.status); }
}

export async function check({ env = process.env, pollIntervalMs = 250, deadlineMs = 30_000, requestTimeoutMs = 10_000 } = {}) {
  const deadlineAt = Date.now() + deadlineMs;
  const base = target(env.UMAMI_BASE_URL || 'http://127.0.0.1:3011');
  const websiteId = required(env, 'UMAMI_WEBSITE_ID');
  if (!UUID.test(websiteId)) throw new SmokeError('config');
  const username = required(env, 'UMAMI_USERNAME');
  const password = required(env, 'UMAMI_PASSWORD');
  const marker = `/deployment-smoke/${randomUUID()}`;
  const endAt = deadlineAt;
  const startAt = endAt - 60_000;
  const login = await request(base, '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) }, 'login', requestTimeoutMs, deadlineAt);
  if (typeof login.body?.token !== 'string' || !login.body.token) throw new SmokeError('login', login.status);
  const auth = { Authorization: `Bearer ${login.body.token}` };
  const website = await request(base, `/api/websites/${websiteId}`, { headers: auth }, 'website', requestTimeoutMs, deadlineAt);
  if (website.body?.domain !== 'deployment-smoke.invalid') throw new SmokeError('website', website.status);
  const statsPath = `/api/websites/${websiteId}/stats?path=eq.${encodeURIComponent(marker)}&startAt=${startAt}&endAt=${endAt}`;
  const baseline = await request(base, statsPath, { headers: auth }, 'baseline', requestTimeoutMs, deadlineAt);
  if (typeof baseline.body?.pageviews !== 'number' || !Number.isFinite(baseline.body.pageviews) || baseline.body.pageviews !== 0) throw new SmokeError('baseline', baseline.status);
  const send = await request(base, '/api/send', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT }, body: JSON.stringify({ type: 'event', payload: { website: websiteId, hostname: 'deployment-smoke.invalid', url: marker, title: 'deployment smoke', userAgent: USER_AGENT } }) }, 'send', requestTimeoutMs, deadlineAt);
  if (send.body?.beep === 'boop' || typeof send.body?.cache !== 'string' || !send.body.cache) throw new SmokeError('send', send.status);
  while (true) {
    const stats = await request(base, statsPath, { headers: auth }, 'poll', requestTimeoutMs, deadlineAt);
    if (typeof stats.body?.pageviews !== 'number' || !Number.isFinite(stats.body.pageviews) || ![0, 1].includes(stats.body.pageviews)) throw new SmokeError('poll', stats.status);
    if (stats.body.pageviews === 1) return { marker, pageviews: 1 };
    if (Date.now() >= deadlineAt) throw new SmokeError('poll', stats.status);
    await new Promise(resolve => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(0, deadlineAt - Date.now()))));
  }
}

export async function main() {
  try { console.log(JSON.stringify(await check())); }
  catch (error) { console.error(error instanceof SmokeError ? error.message : 'stage=unknown status=0'); process.exitCode = 1; }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
