/**
 * `proxy serve`: a local forward proxy that holds the credentials, plus a small
 * JSON API on the same port.
 *
 * The point is that a tool which only understands `HTTPS_PROXY=http://host:port`
 * (curl, git, a browser, an app with no auth support) can use a paid proxy
 * without the password ever reaching it: it talks to 127.0.0.1, and this
 * process adds `Proxy-Authorization` on the hop upstream.
 *
 *   CONNECT host:443          tunnelled through the upstream proxy (HTTPS)
 *   GET http://host/path      absolute-form request, forwarded upstream
 *   GET /status               provider status, JSON
 *   GET /ip                   exit IP through the configured provider, JSON
 *   GET /url                  the upstream proxy URL, password masked
 *   GET /fetch?url=…          fetch a URL through the proxy, JSON envelope
 *
 * Targeting for proxied traffic comes from the server's options. A client may
 * override per connection with headers `X-Proxy-Country` and `X-Proxy-Session`
 * (on the CONNECT or the absolute-form request).
 *
 * Binds 127.0.0.1 unless told otherwise. Anyone who can reach the port spends
 * the account, so `--host 0.0.0.0` should come with `--token`, which then has
 * to arrive as `Proxy-Authorization: Bearer <token>` (proxy traffic) or
 * `Authorization: Bearer <token>` (the JSON API).
 */

import { createServer, request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { exitIp, formatProxyUrl, maskProxyUrl, proxyFetch, resolveProxy, status } from './index.js';

function json(res, code, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function authHeader(resolved) {
  return `Basic ${Buffer.from(`${resolved.username}:${resolved.password}`).toString('base64')}`;
}

function override(base, headers) {
  const country = headers['x-proxy-country'];
  const session = headers['x-proxy-session'];
  return { ...base, ...(country ? { country } : {}), ...(session ? { session } : {}) };
}

function allowed(token, header) {
  if (!token) return true;
  return header === `Bearer ${token}`;
}

/**
 * @param {object} [options]
 * @param {number} [options.port=8888]
 * @param {string} [options.host='127.0.0.1']
 * @param {string} [options.token]   require this bearer token from clients
 * @param {object} [options.proxy]   provider + targeting (provider, country, session, …)
 * @param {object} [options.env]
 * @param {(line: string) => void} [options.log]
 * @param {(opts: object) => Promise<object>} [options.resolve] injectable for tests
 * @returns {Promise<{server: import('node:http').Server, port: number, host: string, close: () => Promise<void>}>}
 */
export async function serve(options = {}) {
  const host = options.host ?? '127.0.0.1';
  const env = options.env ?? process.env;
  const base = { ...(options.proxy ?? {}), env };
  const log = options.log ?? (() => {});
  const resolve = options.resolve ?? resolveProxy;

  // Fail at startup, not on the first request, when nothing is configured.
  await resolve(base);

  const server = createServer(async (req, res) => {
    try {
      // Absolute-form request: plain-HTTP proxying.
      if (/^https?:\/\//i.test(req.url ?? '')) {
        if (!allowed(options.token, req.headers['proxy-authorization'])) {
          res.writeHead(407, { 'proxy-authenticate': 'Bearer' });
          return res.end();
        }
        const upstream = await resolve(override(base, req.headers));
        const headers = { ...req.headers, 'proxy-authorization': authHeader(upstream) };
        delete headers['x-proxy-country'];
        delete headers['x-proxy-session'];
        const forward = httpRequest(
          { host: upstream.host, port: upstream.port, method: req.method, path: req.url, headers },
          (upRes) => {
            res.writeHead(upRes.statusCode ?? 502, upRes.headers);
            upRes.pipe(res);
          },
        );
        forward.on('error', (error) => {
          log(`http ${req.url} failed: ${error.message}`);
          if (!res.headersSent) res.writeHead(502);
          res.end();
        });
        req.pipe(forward);
        return;
      }

      // Origin-form: the JSON API.
      if (!allowed(options.token, req.headers.authorization)) return json(res, 401, { error: 'unauthorized' });
      const url = new URL(req.url ?? '/', 'http://local');
      if (url.pathname === '/' || url.pathname === '/health') {
        return json(res, 200, { ok: true, endpoints: ['/status', '/ip', '/url', '/fetch?url='] });
      }
      if (url.pathname === '/status') return json(res, 200, await status({ env }));
      if (url.pathname === '/ip') return json(res, 200, await exitIp(override(base, Object.fromEntries(url.searchParams))));
      if (url.pathname === '/url') {
        return json(res, 200, { url: maskProxyUrl(formatProxyUrl(await resolve(override(base, Object.fromEntries(url.searchParams))))) });
      }
      if (url.pathname === '/fetch') {
        const target = url.searchParams.get('url');
        if (!target) return json(res, 400, { error: 'url query parameter required' });
        const response = await proxyFetch(target, { method: 'GET' }, { ...override(base, Object.fromEntries(url.searchParams)), timeoutMs: 60_000 });
        return json(res, 200, {
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: await response.text(),
        });
      }
      return json(res, 404, { error: 'not found' });
    } catch (error) {
      log(`error: ${error.message}`);
      if (!res.headersSent) json(res, 502, { error: error.message });
      else res.end();
    }
  });

  // HTTPS: open a tunnel to the upstream proxy, CONNECT through it, splice.
  server.on('connect', async (req, client, head) => {
    if (!allowed(options.token, req.headers['proxy-authorization'])) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Bearer\r\n\r\n');
      return;
    }
    let upstream;
    try {
      upstream = await resolve(override(base, req.headers));
    } catch (error) {
      client.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n${error.message}`);
      return;
    }
    const socket = netConnect(upstream.port, upstream.host, () => {
      socket.write(
        `CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\nProxy-Authorization: ${authHeader(upstream)}\r\n\r\n`,
      );
    });
    let buffered = Buffer.alloc(0);
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.off('data', onData);
      const statusLine = buffered.subarray(0, buffered.indexOf('\r\n')).toString();
      const code = Number(statusLine.split(' ')[1]);
      if (code !== 200) {
        log(`connect ${req.url} upstream said: ${statusLine}`);
        client.end(`HTTP/1.1 ${code || 502} Upstream ${statusLine}\r\n\r\n`);
        socket.destroy();
        return;
      }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const rest = buffered.subarray(end + 4);
      if (rest.length) client.write(rest);
      if (head?.length) socket.write(head);
      socket.pipe(client);
      client.pipe(socket);
    };
    socket.on('data', onData);
    socket.on('error', (error) => {
      log(`connect ${req.url} failed: ${error.message}`);
      client.destroy();
    });
    client.on('error', () => socket.destroy());
  });

  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(options.port ?? 8888, host, done);
  });
  const address = server.address();
  return {
    server,
    host,
    port: typeof address === 'object' && address ? address.port : options.port,
    close: () => new Promise((done) => server.close(() => done())),
  };
}
