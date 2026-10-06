import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickProvider, proxiware, webshare } from '../src/providers.js';
import { formatProxyUrl, maskProxyUrl, resolveProxy } from '../src/index.js';

test('proxiware username: US by default, ww drops the country', () => {
  assert.equal(proxiware.username('abc'), 'abc-country-us');
  assert.equal(proxiware.username('abc', { country: 'ww' }), 'abc');
  assert.equal(proxiware.username('abc', { country: 'GB' }), 'abc-country-gb');
});

test('proxiware username: state, city, sticky session with ttl, udp', () => {
  assert.equal(
    proxiware.username('abc', { country: 'us', state: 'new york', city: 'Brooklyn', session: 'job-42', ttl: 10, udp: true }),
    'abc-country-us-state-new_york-city-brooklyn-sid-job42-ttl-10-udp',
  );
});

test('webshare username: rotate, country rotate, pinned index, stable hash', () => {
  assert.equal(webshare.username('wsacct'), 'wsacct-rotate');
  assert.equal(webshare.username('wsacct-US-rotate'), 'wsacct-rotate', 'stored suffix is stripped');
  assert.equal(webshare.username('wsacct', { country: 'us' }), 'wsacct-US-rotate');
  assert.equal(webshare.username('wsacct', { session: 3 }), 'wsacct-3');
  const a = webshare.username('wsacct', { session: 'alpha' });
  assert.equal(a, webshare.username('wsacct', { session: 'alpha' }));
  assert.match(a, /^wsacct-(10|[1-9])$/);
});

test('pickProvider: named, env default, first configured, and a useful error', () => {
  assert.equal(pickProvider('webshare', {}).name, 'webshare');
  assert.equal(pickProvider(undefined, { PROXY_PROVIDER: 'webshare' }).name, 'webshare');
  assert.equal(pickProvider(undefined, { WEBSHARE_API_KEY: 'k' }).name, 'webshare');
  assert.equal(
    pickProvider(undefined, { PROXIWARE_PROXY_USER: 'u', PROXIWARE_PROXY_PASSWORD: 'p', WEBSHARE_API_KEY: 'k' }).name,
    'proxiware',
  );
  assert.throws(() => pickProvider(undefined, {}), /no proxy provider configured/);
  assert.throws(() => pickProvider('nope', {}), /unknown provider/);
});

test('resolveProxy + formatProxyUrl encode credentials; mask hides the password', async () => {
  const env = { PROXIWARE_PROXY_USER: 'u', PROXIWARE_PROXY_PASSWORD: 'p@ss:w/rd' };
  const resolved = await resolveProxy({ env });
  assert.equal(resolved.host, 'unlimited.proxiware.com');
  assert.equal(resolved.port, 1337);
  const url = formatProxyUrl(resolved);
  assert.equal(url, 'http://u-country-us:p%40ss%3Aw%2Frd@unlimited.proxiware.com:1337');
  assert.equal(maskProxyUrl(url), 'http://u-country-us:***@unlimited.proxiware.com:1337');
});

test('webshare reads the proxy login from the API when only the key is set', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push([url, init.headers.Authorization]);
    return new Response(JSON.stringify({ username: 'wsuser', password: 'wspass' }), { status: 200 });
  };
  const resolved = await resolveProxy({ env: { WEBSHARE_API_KEY: 'key123' }, fetch: fakeFetch, country: 'us' });
  assert.deepEqual(calls, [['https://proxy.webshare.io/api/v2/proxy/config/', 'Token key123']]);
  assert.equal(resolved.username, 'wsuser-US-rotate');
  assert.equal(resolved.password, 'wspass');
  assert.equal(resolved.host, 'p.webshare.io');
});
