/**
 * @profullstack/proxy — call the web through the proxies we pay for.
 *
 *   import { proxyFetch, proxyUrl } from '@profullstack/proxy';
 *   const res = await proxyFetch('https://example.com', {}, { country: 'us' });
 *   process.env.SPORTS_PROXY_URL = await proxyUrl({ provider: 'proxiware' });
 *
 * Providers and their username grammar live in ./providers.js; this file is the
 * part every caller touches: a URL, a fetch, and the account status.
 */

import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { DEFAULT_ORDER, PROVIDERS, pickProvider } from './providers.js';

export { PROVIDERS, DEFAULT_ORDER, pickProvider } from './providers.js';

/**
 * Resolve everything needed to dial a provider: the provider, its upstream
 * host/port, and the username/password with targeting already applied.
 *
 * @param {import('./providers.js').ProxyOptions & {provider?: string, env?: object, fetch?: Function}} [options]
 */
export async function resolveProxy(options = {}) {
  const env = options.env ?? process.env;
  const provider = pickProvider(options.provider, env);
  const credentials = await provider.credentials(env, options.fetch);
  return {
    provider: provider.name,
    host: credentials.host,
    port: credentials.port,
    username: provider.username(credentials.user, options),
    password: credentials.password,
    protocol: options.protocol === 'socks5' ? 'socks5' : 'http',
  };
}

/** `http://user:pass@host:port`, ready for an env var or `curl -x`. */
export function formatProxyUrl(resolved) {
  const auth = `${encodeURIComponent(resolved.username)}:${encodeURIComponent(resolved.password)}`;
  return `${resolved.protocol}://${auth}@${resolved.host}:${resolved.port}`;
}

/** The proxy URL for a provider and targeting options. */
export async function proxyUrl(options = {}) {
  return formatProxyUrl(await resolveProxy(options));
}

/** Same URL with the password replaced, for anything a person or a log reads. */
export function maskProxyUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return url.replace(/:[^:@/]+@/, ':***@');
  }
}

/**
 * An undici dispatcher for Node. Proxy credentials go in a Basic token rather
 * than the URL: older undici ignored userinfo in the proxy URL and the proxy
 * answered 407 with credentials that were right.
 */
export function createDispatcher(resolved) {
  const token = `Basic ${Buffer.from(`${resolved.username}:${resolved.password}`).toString('base64')}`;
  return new ProxyAgent({ uri: `http://${resolved.host}:${resolved.port}`, token });
}

/**
 * fetch(), through a proxy.
 *
 * Under Bun the built-in fetch takes a `proxy` URL per request; under Node it
 * is undici's fetch with a ProxyAgent. `init` is a normal RequestInit.
 *
 * @param {string|URL} url
 * @param {RequestInit} [init]
 * @param {import('./providers.js').ProxyOptions & {provider?: string, env?: object, timeoutMs?: number}} [options]
 */
export async function proxyFetch(url, init = {}, options = {}) {
  const resolved = options.resolved ?? (await resolveProxy(options));
  const signal = init.signal ?? (options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined);
  if (globalThis.Bun) {
    return globalThis.fetch(url, { ...init, signal, proxy: formatProxyUrl(resolved) });
  }
  const dispatcher = createDispatcher(resolved);
  try {
    const response = await undiciFetch(url, { ...init, signal, dispatcher });
    // Read the body before the agent closes, so the caller gets a response
    // that still works after this function returns.
    const body = await response.arrayBuffer();
    return new Response(body.byteLength ? body : null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    dispatcher.close().catch(() => {});
  }
}

/** Where a request through the proxy appears to come from (ipinfo.io). */
export async function exitIp(options = {}) {
  const resolved = await resolveProxy(options);
  const response = await proxyFetch(
    'https://ipinfo.io/json',
    { headers: { accept: 'application/json', 'user-agent': 'curl/8.5.0 (+@profullstack/proxy)' } },
    { timeoutMs: 30_000, ...options, resolved },
  );
  if (!response.ok) throw new Error(`ipinfo.io answered ${response.status} through ${resolved.provider}`);
  const info = await response.json();
  return { provider: resolved.provider, ip: info.ip, country: info.country, region: info.region, city: info.city, org: info.org };
}

/**
 * Every provider: configured or not, and its account status when it has an
 * API key. One provider failing does not hide the others.
 */
export async function status(options = {}) {
  const env = options.env ?? process.env;
  return Promise.all(
    DEFAULT_ORDER.map(async (name) => {
      const provider = PROVIDERS[name];
      const row = { provider: name, label: provider.label, configured: provider.configured(env), account: null, error: null };
      if (!env[provider.env.apiKey]) {
        row.error = `${provider.env.apiKey} not set`;
        return row;
      }
      try {
        row.account = await provider.status(env, options.fetch);
      } catch (error) {
        row.error = error.message;
      }
      return row;
    }),
  );
}
