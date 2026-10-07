/**
 * `proxy mcp`: the same calls as an MCP server on stdio.
 *
 * Newline-delimited JSON-RPC 2.0, which is all the stdio transport is. Written
 * out rather than pulled from the SDK so the package keeps one dependency.
 *
 *   { "mcpServers": { "proxy": { "command": "proxy", "args": ["mcp"] } } }
 */

import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { exitIp, formatProxyUrl, maskProxyUrl, proxyFetch, resolveProxy, status } from './index.js';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const targeting = {
  provider: { type: 'string', enum: ['proxiware', 'webshare', 'hproxy'], description: 'Provider; default is the first configured (proxiware, then webshare, then hproxy).' },
  country: { type: 'string', description: 'ISO country code for the exit, e.g. "us". "ww" for worldwide.' },
  session: { type: 'string', description: 'Sticky session id: the same id keeps the same exit IP.' },
};

export const TOOLS = [
  {
    name: 'proxy_fetch',
    description: 'Fetch a URL through a paid residential proxy. Returns status, headers and the body (text, truncated to max_bytes).',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch.' },
        method: { type: 'string', description: 'HTTP method, default GET.' },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        body: { type: 'string', description: 'Request body for POST/PUT.' },
        max_bytes: { type: 'number', description: 'Truncate the body to this many bytes (default 100000).' },
        ...targeting,
      },
      required: ['url'],
    },
  },
  {
    name: 'proxy_ip',
    description: 'The exit IP, country, city and ISP a request through the proxy appears to come from.',
    inputSchema: { type: 'object', properties: { ...targeting } },
  },
  {
    name: 'proxy_url',
    description: 'The proxy URL (http://user:pass@host:port) for a provider and targeting, for HTTPS_PROXY or an app setting. Password masked unless reveal is true.',
    inputSchema: { type: 'object', properties: { ...targeting, reveal: { type: 'boolean' } } },
  },
  {
    name: 'proxy_status',
    description: 'Every provider: whether it is configured, account credit, subscriptions, renewal and expiry.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function pick(args) {
  return { provider: args.provider, country: args.country, session: args.session };
}

/** Run one tool call; returns the MCP `content` result. */
export async function callTool(name, args = {}, env = process.env) {
  const options = { ...pick(args), env };
  let result;
  if (name === 'proxy_fetch') {
    const init = { method: args.method || 'GET', headers: args.headers };
    if (args.body !== undefined) init.body = args.body;
    const response = await proxyFetch(args.url, init, { ...options, timeoutMs: 60_000 });
    const text = await response.text();
    const max = Number(args.max_bytes) || 100_000;
    result = {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: text.length > max ? `${text.slice(0, max)}\n…[truncated ${text.length - max} bytes]` : text,
    };
  } else if (name === 'proxy_ip') {
    result = await exitIp(options);
  } else if (name === 'proxy_url') {
    const url = formatProxyUrl(await resolveProxy(options));
    result = { url: args.reveal ? url : maskProxyUrl(url) };
  } else if (name === 'proxy_status') {
    result = await status({ env });
  } else {
    throw Object.assign(new Error(`unknown tool ${name}`), { rpc: -32601 });
  }
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

/** Answer one JSON-RPC message; null for notifications. */
export async function handle(message, env = process.env) {
  const { id, method, params } = message ?? {};
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  try {
    if (method === 'initialize') {
      return reply({
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: '@profullstack/proxy', version: VERSION },
      });
    }
    if (method?.startsWith('notifications/')) return null;
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: TOOLS });
    if (method === 'tools/call') {
      try {
        return reply(await callTool(params?.name, params?.arguments ?? {}, env));
      } catch (error) {
        if (error.rpc) throw error;
        return reply({ isError: true, content: [{ type: 'text', text: error.message }] });
      }
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
  } catch (error) {
    return { jsonrpc: '2.0', id, error: { code: error.rpc ?? -32603, message: error.message } };
  }
}

/** Serve MCP over stdin/stdout until stdin closes. */
export function serveMcp({ input = process.stdin, output = process.stdout, env = process.env } = {}) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.on('line', async (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`);
      return;
    }
    const answer = await handle(message, env);
    if (answer && message.id !== undefined) output.write(`${JSON.stringify(answer)}\n`);
  });
  return new Promise((done) => lines.on('close', done));
}
