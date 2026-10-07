import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { run } from '../src/cli.js';
import { formatProxyUrl, maskProxyUrl, proxyFetch, resolveProxy, status } from '../src/index.js';
import { hproxy, pickProvider } from '../src/providers.js';
import { originServer, upstreamProxy } from './helpers.js';

test('hproxy username: the Residential Premium grammar from their docs', () => {
  assert.equal(hproxy.username('acct'), 'acct-type-residential-country-us');
  assert.equal(hproxy.username('acct', { country: 'ww' }), 'acct-type-residential');
  // The documented line, rebuilt: …-country-de-city-berlin-…-session-<id>-lifetime-30
  assert.equal(
    hproxy.username('acct', { country: 'DE', city: 'Berlin', session: 'k3m9x2', ttl: 30 }),
    'acct-type-residential-country-de-city-berlin-session-k3m9x2-lifetime-30',
  );
  assert.equal(
    hproxy.username('acct', { country: 'us', state: 'new york', udp: true, session: 'job-42' }),
    'acct-type-residential-country-us-state-new_york-requireUdp-true-session-job42-lifetime-30',
    'session without ttl gets the 30 minute default',
  );
  assert.match(hproxy.username('acct', { session: 1, ttl: 1 }), /-lifetime-3$/, 'clamped to 3..1440');
  assert.match(hproxy.username('acct', { session: 1, ttl: 99999 }), /-lifetime-1440$/);
  assert.equal(
    hproxy.username('acct-type-residential-country-de-session-old-lifetime-30', { country: 'gb' }),
    'acct-type-residential-country-gb',
    'targeting on a stored username is replaced, not stacked',
  );
});

test('hproxy: -p hproxy, defaults, and picked last when it is the only one configured', async () => {
  const env = { HPROXY_PROXY_USER: 'acct', HPROXY_PROXY_PASSWORD: 'p:w' };
  assert.equal(pickProvider(undefined, env).name, 'hproxy');
  assert.equal(pickProvider(undefined, { ...env, WEBSHARE_API_KEY: 'k' }).name, 'webshare');
  const url = formatProxyUrl(await resolveProxy({ provider: 'hproxy', env }));
  assert.equal(url, 'http://acct-type-residential-country-us:p%3Aw@premium.hproxy.com:10000');
  assert.equal(maskProxyUrl(url), 'http://acct-type-residential-country-us:***@premium.hproxy.com:10000');
});

function fakeApi(lines, { plans = [{ id: 'plan1', productId: 'residential-premium', dataGbTotal: 10, dataGbRemaining: 3.2 }] } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', key: init.headers['X-API-Key'], body: init.body ? JSON.parse(init.body) : undefined });
    const path = new URL(url).pathname.replace('/api/v1', '');
    const reply = (body) => new Response(JSON.stringify(body), { status: 200 });
    if (path === '/plans') return reply({ plans });
    if (path === '/me') return reply({ userId: 'u1', email: 'ops@example.com', scopes: ['buy'] });
    if (path === '/wallet') return reply({ balanceCents: 25765, currency: 'USD' });
    if (path.endsWith('/generate')) return reply({ lines: [lines.shift()], productId: 'residential-premium' });
    return new Response('{}', { status: 404 });
  };
  return { fetch, calls };
}

test('hproxy with only an API key: generates a line and uses it verbatim', async () => {
  const api = fakeApi(['203.0.113.10:10000:hp_x92kf-us-sess-a8x2q-t-30:9f2a:1c7b', '203.0.113.10:10000:hp_x92kf-us-sess-zzz-t-30:9f2a:1c7b']);
  const env = { HPROXY_API_KEY: 'hpx_test' };
  const sticky = { provider: 'hproxy', env, fetch: api.fetch, country: 'us', city: 'Austin', session: 'w1', ttl: 45 };
  const first = await resolveProxy(sticky);
  assert.equal(first.host, '203.0.113.10');
  assert.equal(first.port, 10000);
  assert.equal(first.username, 'hp_x92kf-us-sess-a8x2q-t-30', 'the generated username is not rebuilt');
  assert.equal(first.password, '9f2a:1c7b', 'a colon in the password survives');
  const generate = api.calls.find((call) => call.url.endsWith('/plans/plan1/generate'));
  assert.equal(generate.method, 'POST');
  assert.deepEqual(generate.body, { protocol: 'http', country: 'US', city: 'Austin', stickyMinutes: 45 });
  assert.ok(api.calls.every((call) => call.key === 'hpx_test'));
  const again = await resolveProxy(sticky);
  assert.equal(again.username, first.username, 'same session in one process, same line');
  assert.equal(api.calls.filter((call) => call.url.endsWith('/generate')).length, 1);
});

test('hproxy status: wallet credit, email and GB left per plan', async () => {
  const api = fakeApi([]);
  const rows = await status({ env: { HPROXY_API_KEY: 'hpx_test' }, fetch: api.fetch });
  const row = rows.find((r) => r.provider === 'hproxy');
  assert.equal(row.configured, true);
  assert.equal(row.error, null);
  assert.equal(row.account.credit, 257.65);
  assert.equal(row.account.email, 'ops@example.com');
  const [plan] = row.account.subscriptions;
  assert.deepEqual(
    { id: plan.id, kind: plan.kind, total: plan.bandwidthGb, left: plan.remainingGb },
    { id: 'plan1', kind: 'residential-premium', total: 10, left: 3.2 },
  );
});

test('cli: -p hproxy url and providers', async () => {
  let text = '';
  const stdout = new Writable({ write: (chunk, _encoding, done) => ((text += chunk), done()) });
  const env = { HPROXY_PROXY_USER: 'acct', HPROXY_PROXY_PASSWORD: 'pw' };
  assert.equal(await run(['-p', 'hproxy', 'url', '-c', 'de', '-s', 'x1', '--ttl', '60'], { env, stdout }), 0);
  assert.equal(text.trim(), 'http://acct-type-residential-country-de-session-x1-lifetime-60:***@premium.hproxy.com:10000');
  text = '';
  await run(['providers'], { env, stdout });
  assert.match(text, /hproxy\s+configured\s+HProxy Residential/);
});

test('proxyFetch through hproxy: the fake upstream sees the targeted username', async () => {
  const origin = await originServer();
  const upstream = await upstreamProxy({ user: 'acct', password: 'secret' });
  try {
    const env = {
      HPROXY_PROXY_USER: 'acct',
      HPROXY_PROXY_PASSWORD: 'secret',
      HPROXY_PROXY_HOST: '127.0.0.1',
      HPROXY_PROXY_PORT: String(upstream.port),
    };
    const response = await proxyFetch(`http://127.0.0.1:${origin.port}/hp`, {}, { provider: 'hproxy', env, country: 'gb', session: 'abc', ttl: 10 });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).url, '/hp');
    assert.ok(upstream.seen.includes('acct-type-residential-country-gb-session-abc-lifetime-10'), `upstream saw ${upstream.seen}`);
  } finally {
    await upstream.close();
    await origin.close();
  }
});
