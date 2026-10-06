import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';
import { parseArgs, run } from '../src/cli.js';
import { handle, serveMcp, TOOLS } from '../src/mcp.js';

function sink() {
  let text = '';
  const stream = new Writable({
    write(chunk, _encoding, done) {
      text += chunk;
      done();
    },
  });
  return { stream, text: () => text };
}

test('parseArgs: curl-like flags, repeatable headers, --k=v, glued short values', () => {
  const { flags, positional } = parseArgs(['https://x.test', '-c', 'us', '-H', 'A: 1', '-H', 'B: 2', '-i', '--session=9', '-XPOST']);
  assert.deepEqual(positional, ['https://x.test']);
  assert.equal(flags.country, 'us');
  assert.deepEqual(flags.header, ['A: 1', 'B: 2']);
  assert.equal(flags.include, true);
  assert.equal(flags.session, '9');
  assert.equal(flags.method, 'POST');
  assert.throws(() => parseArgs(['-Z']), /unknown flag/);
});

test('cli: url masks by default and reveals on request; missing creds exit 3', async () => {
  const env = { PROXIWARE_PROXY_USER: 'u', PROXIWARE_PROXY_PASSWORD: 'pw' };
  const out = sink();
  assert.equal(await run(['url', '-c', 'gb'], { env, stdout: out.stream, stderr: sink().stream }), 0);
  assert.equal(out.text().trim(), 'http://u-country-gb:***@unlimited.proxiware.com:1337');
  const revealed = sink();
  await run(['url', '--reveal'], { env, stdout: revealed.stream, stderr: sink().stream });
  assert.equal(revealed.text().trim(), 'http://u-country-us:pw@unlimited.proxiware.com:1337');
  const err = sink();
  assert.equal(await run(['url'], { env: {}, stdout: sink().stream, stderr: err.stream }), 3);
  assert.match(err.text(), /no proxy provider configured/);
});

test('cli: providers lists both; help exits 0', async () => {
  const out = sink();
  assert.equal(await run(['providers'], { env: { WEBSHARE_API_KEY: 'k' }, stdout: out.stream }), 0);
  assert.match(out.text(), /proxiware\s+missing/);
  assert.match(out.text(), /webshare\s+configured/);
  assert.equal(await run(['--help'], { env: {}, stdout: sink().stream }), 0);
});

test('mcp: initialize, tools/list, a tool error comes back as isError', async () => {
  const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.serverInfo.name, '@profullstack/proxy');
  const list = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(
    list.result.tools.map((tool) => tool.name),
    TOOLS.map((tool) => tool.name),
  );
  const call = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'proxy_url', arguments: {} } }, {});
  assert.equal(call.result.isError, true);
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});

test('mcp over stdio: a line in, a line out', async () => {
  const input = new PassThrough();
  const out = sink();
  const done = serveMcp({ input, output: out.stream, env: { PROXIWARE_PROXY_USER: 'u', PROXIWARE_PROXY_PASSWORD: 'p' } });
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'proxy_url', arguments: { country: 'de' } } })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  input.end();
  await done;
  const reply = JSON.parse(out.text().trim());
  assert.match(JSON.parse(reply.result.content[0].text).url, /u-country-de:\*\*\*@/);
});
