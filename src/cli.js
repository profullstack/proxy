/**
 * The `proxy` command. Exported as `run()` so a wrapper (cli-tools) can call
 * it in-process with credentials it resolved itself, instead of exporting
 * them into a shell.
 */

import { createWriteStream } from 'node:fs';
import { readFileSync } from 'node:fs';
import { exitIp, formatProxyUrl, maskProxyUrl, proxyFetch, resolveProxy, status } from './index.js';
import { PROVIDERS } from './providers.js';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export const HELP = `proxy — call the web through our paid proxies (Proxiware, Webshare)

  proxy <url>                 fetch a URL through the proxy, body to stdout
  proxy ip                    exit IP, country, city and ISP
  proxy url [--reveal]        the proxy URL for HTTPS_PROXY (password masked unless --reveal)
  proxy status [--json]       accounts: credit, plans, renewal, expiry
  proxy providers             which providers are configured
  proxy serve [--port 8888] [--host 127.0.0.1] [--token T]
                              local forward proxy holding the credentials, plus a JSON API
  proxy mcp                   MCP server on stdio (tools: proxy_fetch, proxy_ip, proxy_url, proxy_status)
  proxy tui                   account dashboard with a live exit test

targeting (any command):
  -p, --provider NAME         proxiware | webshare (default: PROXY_PROVIDER, else first configured)
  -c, --country CC            exit country, e.g. us, gb; "ww" for worldwide (proxiware default: us)
  -s, --session ID            sticky session: same id, same exit IP
      --ttl MIN               proxiware: sticky session lifetime in minutes
      --state S, --city C     proxiware: narrower targeting

fetching:
  -X, --method M              HTTP method (default GET, or POST with -d)
  -H, --header 'K: V'         request header, repeatable
  -d, --data BODY             request body (@file reads a file)
  -i, --include               print status line and response headers first
  -I, --head                  HEAD request, headers only
  -o, --output FILE           write the body to FILE
  -A, --user-agent UA         default: curl/8.5.0 (+@profullstack/proxy)
      --timeout SEC           default 60

credentials (environment):
  PROXIWARE_PROXY_USER, PROXIWARE_PROXY_PASSWORD [, PROXIWARE_PROXY_HOST, PROXIWARE_PROXY_PORT]
  PROXIWARE_API_KEY           account status
  WEBSHARE_API_KEY            account status, and the proxy login when no user/password is set
  WEBSHARE_PROXY_USER, WEBSHARE_PROXY_PASSWORD [, WEBSHARE_PROXY_HOST, WEBSHARE_PROXY_PORT]
`;

const SHORT = { p: 'provider', c: 'country', s: 'session', X: 'method', H: 'header', d: 'data', i: 'include', I: 'head', o: 'output', A: 'user-agent', h: 'help', v: 'version' };
const BOOLEAN = new Set(['include', 'head', 'help', 'version', 'json', 'reveal']);

export function parseArgs(argv) {
  const flags = { header: [] };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    let name;
    let value;
    if (arg.startsWith('--')) {
      [name, value] = arg.slice(2).split(/=(.*)/s, 2);
    } else if (arg.startsWith('-') && arg.length > 1 && !/^-\d/.test(arg)) {
      name = SHORT[arg[1]];
      if (!name) throw new Error(`unknown flag ${arg}`);
      if (arg.length > 2) value = arg.slice(2);
    } else {
      positional.push(arg);
      continue;
    }
    if (BOOLEAN.has(name)) {
      flags[name] = true;
      continue;
    }
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) throw new Error(`--${name} needs a value`);
    }
    if (name === 'header') flags.header.push(value);
    else flags[name] = value;
  }
  return { flags, positional };
}

function targeting(flags, env) {
  const options = { env };
  for (const key of ['provider', 'country', 'session', 'ttl', 'state', 'city']) {
    if (flags[key] !== undefined) options[key] = key === 'ttl' ? Number(flags[key]) : flags[key];
  }
  return options;
}

function headersFrom(flags) {
  const headers = {};
  for (const line of flags.header) {
    const at = line.indexOf(':');
    if (at <= 0) throw new Error(`bad header "${line}" (want "Name: value")`);
    headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  if (!Object.keys(headers).some((key) => key.toLowerCase() === 'user-agent')) {
    headers['user-agent'] = flags['user-agent'] ?? 'curl/8.5.0 (+@profullstack/proxy)';
  }
  return headers;
}

async function fetchCommand(url, flags, env, io) {
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const init = { method: flags.method ?? (flags.head ? 'HEAD' : flags.data !== undefined ? 'POST' : 'GET'), headers: headersFrom(flags) };
  if (flags.data !== undefined) init.body = flags.data.startsWith('@') ? readFileSync(flags.data.slice(1)) : flags.data;
  const response = await proxyFetch(url, init, { ...targeting(flags, env), timeoutMs: Number(flags.timeout ?? 60) * 1000 });
  if (flags.include || flags.head) {
    io.stdout.write(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}\n`);
    for (const [key, value] of response.headers) io.stdout.write(`${key}: ${value}\n`);
    io.stdout.write('\n');
  }
  if (!flags.head) {
    const body = Buffer.from(await response.arrayBuffer());
    if (flags.output) {
      await new Promise((done, fail) => createWriteStream(flags.output).on('error', fail).end(body, done));
      io.stderr.write(`proxy: ${response.status}, ${body.length} bytes → ${flags.output}\n`);
    } else {
      io.stdout.write(body);
    }
  }
  return response.ok ? 0 : 22; // curl's --fail exit code, so scripts can tell
}

/**
 * @param {string[]} argv
 * @param {{env?: object, stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream}} [io]
 * @returns {Promise<number>} exit code
 */
export async function run(argv, io = {}) {
  const env = io.env ?? process.env;
  const out = { stdout: io.stdout ?? process.stdout, stderr: io.stderr ?? process.stderr };
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    out.stderr.write(`proxy: ${error.message}\n`);
    return 2;
  }
  const { flags, positional } = parsed;
  if (flags.version) {
    out.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const [command, ...rest] = positional;
  if (flags.help || !command || command === 'help') {
    out.stdout.write(HELP);
    return command || flags.help ? 0 : 2;
  }

  try {
    switch (command) {
      case 'ip': {
        const info = await exitIp(targeting(flags, env));
        out.stdout.write(flags.json ? `${JSON.stringify(info, null, 2)}\n` : `${info.ip}  ${info.country ?? ''} ${info.region ?? ''} ${info.city ?? ''}  ${info.org ?? ''}  (${info.provider})\n`);
        return 0;
      }
      case 'url': {
        const url = formatProxyUrl(await resolveProxy(targeting(flags, env)));
        out.stdout.write(`${flags.reveal ? url : maskProxyUrl(url)}\n`);
        return 0;
      }
      case 'status': {
        const rows = await status({ env });
        if (flags.json) {
          out.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
          return 0;
        }
        for (const row of rows) {
          out.stdout.write(`${row.provider}: ${row.configured ? 'configured' : 'not configured'}`);
          if (row.account) {
            out.stdout.write(`, credit $${Number(row.account.credit ?? 0).toFixed(2)}\n`);
            for (const sub of row.account.subscriptions) {
              out.stdout.write(
                `  #${sub.id} ${sub.kind}${sub.mbps ? ` ${sub.mbps} Mbps` : ''} ${sub.active ? 'active' : 'inactive'}` +
                  `, renew ${sub.autoRenew ? 'on' : 'off'}, until ${sub.expiresAt ?? '?'}` +
                  `${sub.price !== null && sub.price !== undefined ? `, $${Number(sub.price).toFixed(2)}` : ''}\n`,
              );
            }
          } else {
            out.stdout.write(row.error ? ` (${row.error})\n` : '\n');
          }
        }
        return 0;
      }
      case 'providers': {
        for (const provider of Object.values(PROVIDERS)) {
          out.stdout.write(`${provider.name.padEnd(10)} ${provider.configured(env) ? 'configured' : 'missing'}  ${provider.label}\n`);
        }
        return 0;
      }
      case 'serve': {
        const { serve } = await import('./server.js');
        const running = await serve({
          port: Number(flags.port ?? 8888),
          host: flags.host ?? '127.0.0.1',
          token: flags.token ?? env.PROXY_SERVE_TOKEN,
          proxy: targeting(flags, env),
          env,
          log: (line) => out.stderr.write(`proxy: ${line}\n`),
        });
        out.stderr.write(
          `proxy: listening on http://${running.host}:${running.port}  ` +
            `(HTTPS_PROXY=http://${running.host}:${running.port}; JSON API at /status /ip /url /fetch?url=)\n`,
        );
        await new Promise(() => {});
        return 0;
      }
      case 'mcp': {
        const { serveMcp } = await import('./mcp.js');
        await serveMcp({ env, output: out.stdout });
        return 0;
      }
      case 'tui': {
        const { runTui } = await import('./tui.js');
        await runTui({ env, output: out.stdout });
        return 0;
      }
      case 'get':
      case 'fetch':
        if (!rest[0]) throw new Error(`${command} needs a URL`);
        return await fetchCommand(rest[0], flags, env, out);
      default:
        return await fetchCommand(command, flags, env, out);
    }
  } catch (error) {
    out.stderr.write(`proxy: ${error.message}\n`);
    return error.code === 'PROXY_CREDENTIALS_MISSING' ? 3 : 1;
  }
}
