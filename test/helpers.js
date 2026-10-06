import { createServer, request as httpRequest } from 'node:http';
import { connect as netConnect, createServer as createTcpServer } from 'node:net';

/** A TCP echo server: whatever arrives goes back. */
export async function echoServer() {
  const server = createTcpServer((socket) => socket.pipe(socket));
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { port: server.address().port, close: () => new Promise((done) => server.close(done)) };
}

/** A plain HTTP origin that reports what it saw. */
export async function originServer() {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'x-origin': 'yes' });
    res.end(JSON.stringify({ method: req.method, url: req.url, ua: req.headers['user-agent'] ?? null }));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return {
    port: server.address().port,
    close: () => {
      server.closeAllConnections?.();
      return new Promise((done) => server.close(done));
    },
  };
}

/**
 * A fake upstream proxy that demands Basic user:pass, then tunnels CONNECT and
 * forwards absolute-form requests. Records the usernames it was given.
 */
export async function upstreamProxy({ user = 'u', password = 'p' } = {}) {
  const seen = [];
  const sockets = new Set();
  const ok = (header) => {
    if (!header?.startsWith('Basic ')) return false;
    const [u, p] = Buffer.from(header.slice(6), 'base64').toString().split(':');
    seen.push(u);
    return u.startsWith(user) && p === password;
  };
  const server = createServer((req, res) => {
    if (!ok(req.headers['proxy-authorization'])) {
      res.writeHead(407);
      return res.end();
    }
    const target = new URL(req.url);
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    const out = httpRequest(
      { host: target.hostname, port: target.port, path: target.pathname + target.search, method: req.method, headers },
      (up) => {
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
      },
    );
    req.pipe(out);
  });
  server.on('connect', (req, client, head) => {
    sockets.add(client);
    if (!ok(req.headers['proxy-authorization'])) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      return;
    }
    const [host, port] = req.url.split(':');
    const socket = netConnect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) socket.write(head);
      socket.pipe(client);
      client.pipe(socket);
    });
    sockets.add(socket);
    socket.on('error', () => client.destroy());
    client.on('error', () => socket.destroy());
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return {
    port: server.address().port,
    seen,
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections?.();
      return new Promise((done) => server.close(done));
    },
  };
}
