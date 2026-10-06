import assert from 'node:assert/strict';
import { test } from 'node:test';
import { proxyFetch } from '../src/index.js';
import { originServer, upstreamProxy } from './helpers.js';

function envFor(upstream, password = 'secret') {
  return {
    PROXIWARE_PROXY_USER: 'acct',
    PROXIWARE_PROXY_PASSWORD: password,
    PROXIWARE_PROXY_HOST: '127.0.0.1',
    PROXIWARE_PROXY_PORT: String(upstream.port),
  };
}

test('proxyFetch goes through the upstream proxy with the targeted username', async () => {
  const origin = await originServer();
  const upstream = await upstreamProxy({ user: 'acct', password: 'secret' });
  try {
    const response = await proxyFetch(
      `http://127.0.0.1:${origin.port}/hello?x=1`,
      { headers: { 'user-agent': 'test-ua' } },
      { env: envFor(upstream), country: 'gb', session: 7 },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.url, '/hello?x=1');
    assert.equal(body.ua, 'test-ua');
    assert.ok(upstream.seen.includes('acct-country-gb-sid-7'), `upstream saw ${upstream.seen}`);
  } finally {
    await upstream.close();
    await origin.close();
  }
});

test('proxyFetch surfaces a 407 from the upstream as an error', async () => {
  const origin = await originServer();
  const upstream = await upstreamProxy({ user: 'acct', password: 'secret' });
  try {
    await assert.rejects(proxyFetch(`http://127.0.0.1:${origin.port}/`, {}, { env: envFor(upstream, 'wrong') }));
  } finally {
    await upstream.close();
    await origin.close();
  }
});
