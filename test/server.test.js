import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { test } from 'node:test';
import { serve } from '../src/server.js';
import { echoServer, originServer, upstreamProxy } from './helpers.js';

function connectThrough(port, target, headers = {}) {
  return new Promise((done, fail) => {
    const socket = netConnect(port, '127.0.0.1', () => {
      const extra = Object.entries(headers)
        .map(([key, value]) => `${key}: ${value}\r\n`)
        .join('');
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${extra}\r\n`);
    });
    let buffer = '';
    socket.on('data', function first(chunk) {
      buffer += chunk.toString();
      if (!buffer.includes('\r\n\r\n')) return;
      socket.off('data', first);
      done({ socket, status: Number(buffer.split(' ')[1]) });
    });
    socket.on('error', fail);
  });
}

async function withServer(fn, serveOptions = {}) {
  const upstream = await upstreamProxy({ user: 'acct', password: 'secret' });
  const env = {
    PROXIWARE_PROXY_USER: 'acct',
    PROXIWARE_PROXY_PASSWORD: 'secret',
    PROXIWARE_PROXY_HOST: '127.0.0.1',
    PROXIWARE_PROXY_PORT: String(upstream.port),
  };
  const local = await serve({ port: 0, env, ...serveOptions });
  try {
    await fn({ local, upstream });
  } finally {
    local.server.closeAllConnections?.();
    await local.close();
    await upstream.close();
  }
}

test('CONNECT is tunnelled upstream with credentials added', async () => {
  const echo = await echoServer();
  try {
    await withServer(async ({ local, upstream }) => {
      const { socket, status } = await connectThrough(local.port, `127.0.0.1:${echo.port}`, { 'X-Proxy-Country': 'de' });
      assert.equal(status, 200);
      const reply = await new Promise((done) => {
        socket.once('data', (chunk) => done(chunk.toString()));
        socket.write('ping');
      });
      assert.equal(reply, 'ping');
      socket.destroy();
      assert.ok(upstream.seen.includes('acct-country-de'), `upstream saw ${upstream.seen}`);
    });
  } finally {
    await echo.close();
  }
});

test('absolute-form HTTP is forwarded upstream', async () => {
  const origin = await originServer();
  try {
    await withServer(async ({ local }) => {
      const body = await new Promise((done, fail) => {
        const req = httpRequest(
          { host: '127.0.0.1', port: local.port, path: `http://127.0.0.1:${origin.port}/path?q=1`, method: 'GET', agent: false },
          (res) => {
            let text = '';
            res.on('data', (chunk) => (text += chunk));
            res.on('end', () => done({ status: res.statusCode, text }));
          },
        );
        req.on('error', fail);
        req.end();
      });
      assert.equal(body.status, 200);
      assert.equal(JSON.parse(body.text).url, '/path?q=1');
    });
  } finally {
    await origin.close();
  }
});

test('JSON API: /url is masked, unknown paths 404', async () => {
  await withServer(async ({ local }) => {
    const url = await (await fetch(`http://127.0.0.1:${local.port}/url`)).json();
    assert.match(url.url, /^http:\/\/acct-country-us:\*\*\*@127\.0\.0\.1:\d+$/);
    assert.equal((await fetch(`http://127.0.0.1:${local.port}/nope`)).status, 404);
  });
});

test('--token is enforced on the API and on CONNECT', async () => {
  const echo = await echoServer();
  try {
    await withServer(
      async ({ local }) => {
        assert.equal((await fetch(`http://127.0.0.1:${local.port}/url`)).status, 401);
        const authed = await fetch(`http://127.0.0.1:${local.port}/url`, { headers: { authorization: 'Bearer t0k' } });
        assert.equal(authed.status, 200);
        const denied = await connectThrough(local.port, `127.0.0.1:${echo.port}`);
        assert.equal(denied.status, 407);
        denied.socket.destroy();
        const allowed = await connectThrough(local.port, `127.0.0.1:${echo.port}`, { 'Proxy-Authorization': 'Bearer t0k' });
        assert.equal(allowed.status, 200);
        allowed.socket.destroy();
      },
      { token: 't0k' },
    );
  } finally {
    await echo.close();
  }
});

test('serve refuses to start with no provider configured', async () => {
  await assert.rejects(serve({ port: 0, env: {} }), /no proxy provider configured/);
});
