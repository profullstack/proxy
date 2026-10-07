/**
 * The proxy providers we hold accounts with, and how each one spells a request.
 *
 * Every provider takes the same options and turns them into its own username
 * syntax, because that is where all of them put targeting: the country, the
 * sticky session and the rest ride in the proxy username, not in a header and
 * not in a separate endpoint. So "give me a US exit that holds for ten minutes"
 * is one object here and a different string per provider on the wire.
 *
 * Credentials come from the environment and nowhere else. This package never
 * reads a file and never writes one; a caller that keeps keys somewhere (a
 * vault, a credential store) resolves them and passes `env`.
 */

/**
 * @typedef {object} ProxyOptions
 * @property {string} [country]  ISO 3166 alpha-2, any case ("us", "GB")
 * @property {string} [state]    Proxiware, HProxy: a state/region slug
 * @property {string} [city]     Proxiware, HProxy: a city slug
 * @property {string|number} [session] keep the same exit IP across requests
 * @property {number} [ttl]      Proxiware, HProxy: minutes a sticky session lives
 * @property {'http'|'socks5'} [protocol]
 */

const lower = (value) => String(value).trim().toLowerCase();
const slug = (value) => lower(value).replace(/\s+/g, '_');

function need(env, names, provider) {
  const missing = names.filter((name) => !env[name]);
  if (missing.length) {
    const error = new Error(`${provider}: ${missing.join(', ')} not set`);
    error.code = 'PROXY_CREDENTIALS_MISSING';
    error.missing = missing;
    throw error;
  }
}

async function getJson(url, headers, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(20_000) });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    const error = new Error(`${url} answered ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

/**
 * Proxiware Unlimited Residential.
 *
 * Username grammar, read from their dashboard's proxy builder (2026-10-06):
 * `<user>-country-us-state-<s>-city-<c>-sid-<n>-ttl-<min>-udp`. Without
 * `-country-…` exits are worldwide, which is rarely what a caller means, so a
 * caller that wants worldwide says `country: 'ww'`.
 */
export const proxiware = {
  name: 'proxiware',
  label: 'Proxiware Unlimited Residential',
  env: {
    user: 'PROXIWARE_PROXY_USER',
    password: 'PROXIWARE_PROXY_PASSWORD',
    host: 'PROXIWARE_PROXY_HOST',
    port: 'PROXIWARE_PROXY_PORT',
    apiKey: 'PROXIWARE_API_KEY',
  },
  defaults: { host: 'unlimited.proxiware.com', port: 1337, country: 'us' },

  configured(env) {
    return Boolean(env.PROXIWARE_PROXY_USER && env.PROXIWARE_PROXY_PASSWORD);
  },

  username(base, options = {}) {
    let name = base;
    const country = options.country ?? this.defaults.country;
    if (country && lower(country) !== 'ww') name += `-country-${lower(country)}`;
    if (options.state) name += `-state-${slug(options.state)}`;
    if (options.city) name += `-city-${slug(options.city)}`;
    if (options.session !== undefined && options.session !== null && options.session !== '') {
      const sid = String(options.session).replace(/[^A-Za-z0-9]/g, '');
      name += `-sid-${sid}`;
      if (options.ttl) name += `-ttl-${Number(options.ttl)}`;
    }
    if (options.udp) name += '-udp';
    return name;
  },

  async credentials(env) {
    need(env, [this.env.user, this.env.password], this.name);
    return {
      user: env.PROXIWARE_PROXY_USER,
      password: env.PROXIWARE_PROXY_PASSWORD,
      host: env.PROXIWARE_PROXY_HOST || this.defaults.host,
      port: Number(env.PROXIWARE_PROXY_PORT || this.defaults.port),
    };
  },

  /** Balance and subscriptions, from https://docs.proxiware.com/v1 */
  async status(env, fetchImpl) {
    need(env, [this.env.apiKey], this.name);
    const headers = { 'API-KEY': env.PROXIWARE_API_KEY, accept: 'application/json' };
    const base = 'https://api.proxiware.com/v1';
    const [account, subscriptions] = await Promise.all([
      getJson(`${base}/account`, headers, fetchImpl),
      getJson(`${base}/unlimited/subscriptions`, headers, fetchImpl).catch(() => []),
    ]);
    const list = Array.isArray(subscriptions) ? subscriptions : (subscriptions?.data ?? []);
    return {
      provider: this.name,
      email: account?.email ?? null,
      credit: account?.credit ?? null,
      subscriptions: list.map((sub) => ({
        id: sub.id,
        kind: 'unlimited',
        network: sub.network,
        mbps: sub.mbps,
        active: sub.active,
        autoRenew: sub.auto_renewal,
        expiresAt: sub.expires_at ? new Date(sub.expires_at * 1000).toISOString() : null,
        price: sub.billing_amount ?? null,
      })),
    };
  },
};

/**
 * Webshare.
 *
 * One rotating endpoint (`p.webshare.io:80`) whose username picks the exit:
 * `<user>-rotate` rotates across the whole list, `<user>-us-rotate` rotates
 * within a country, and `<user>-<n>` pins proxy number n from the list. The
 * last is what a session maps to, since Webshare has no session token.
 *
 * With only `WEBSHARE_API_KEY` set, the proxy username and password are read
 * from the account's proxy config, so a password change in the dashboard does
 * not strand every caller holding the old one.
 */
export const webshare = {
  name: 'webshare',
  label: 'Webshare',
  env: {
    user: 'WEBSHARE_PROXY_USER',
    password: 'WEBSHARE_PROXY_PASSWORD',
    host: 'WEBSHARE_PROXY_HOST',
    port: 'WEBSHARE_PROXY_PORT',
    apiKey: 'WEBSHARE_API_KEY',
  },
  defaults: { host: 'p.webshare.io', port: 80, country: null },

  configured(env) {
    return Boolean((env.WEBSHARE_PROXY_USER && env.WEBSHARE_PROXY_PASSWORD) || env.WEBSHARE_API_KEY);
  },

  username(base, options = {}) {
    // A stored username may already carry a suffix (`wsacct-rotate`); the
    // targeting is built on the bare account name.
    const bare = base.replace(/(-[a-z]{2})?-rotate$/i, '').replace(/-\d+$/, '');
    if (options.session !== undefined && options.session !== null && options.session !== '') {
      const index = Number.parseInt(String(options.session), 10);
      if (Number.isFinite(index) && index > 0) return `${bare}-${index}`;
      // A non-numeric session still has to be stable, so hash it onto 1..10:
      // ten is the free plan's list and every paid plan has at least that.
      let hash = 0;
      for (const char of String(options.session)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
      return `${bare}-${(hash % 10) + 1}`;
    }
    const country = options.country ?? this.defaults.country;
    return country && lower(country) !== 'ww' ? `${bare}-${country.toUpperCase()}-rotate` : `${bare}-rotate`;
  },

  async credentials(env, fetchImpl) {
    const host = env.WEBSHARE_PROXY_HOST || this.defaults.host;
    const port = Number(env.WEBSHARE_PROXY_PORT || this.defaults.port);
    if (env.WEBSHARE_PROXY_USER && env.WEBSHARE_PROXY_PASSWORD) {
      return { user: env.WEBSHARE_PROXY_USER, password: env.WEBSHARE_PROXY_PASSWORD, host, port };
    }
    need(env, [this.env.apiKey], this.name);
    const config = await getJson(
      'https://proxy.webshare.io/api/v2/proxy/config/',
      { Authorization: `Token ${env.WEBSHARE_API_KEY}` },
      fetchImpl,
    );
    if (!config?.username || !config?.password) {
      throw new Error('webshare: proxy config has no username/password');
    }
    return { user: config.username, password: config.password, host, port };
  },

  async status(env, fetchImpl) {
    need(env, [this.env.apiKey], this.name);
    const headers = { Authorization: `Token ${env.WEBSHARE_API_KEY}` };
    const subscription = await getJson('https://proxy.webshare.io/api/v2/subscription/', headers, fetchImpl);
    const plan = subscription?.plan
      ? await getJson(`https://proxy.webshare.io/api/v2/subscription/plan/${subscription.plan}/`, headers, fetchImpl).catch(
          () => null,
        )
      : null;
    return {
      provider: this.name,
      email: null,
      credit: subscription?.free_credits ?? null,
      subscriptions: [
        {
          id: subscription?.plan ?? null,
          kind: plan ? `${plan.proxy_type}/${plan.proxy_subtype}` : 'unknown',
          network: plan?.proxy_subtype ?? null,
          mbps: null,
          active: plan ? plan.status === 'active' : null,
          autoRenew: subscription?.will_renew ?? null,
          expiresAt: subscription?.end_date ?? null,
          price: plan?.monthly_price ?? null,
          bandwidthGb: plan?.bandwidth_limit ?? null,
          proxies: plan?.proxy_count ?? null,
        },
      ],
    };
  },
};

/**
 * HProxy residential, pay per GB.
 *
 * Two ways in, because HProxy documents two:
 *
 * - `HPROXY_PROXY_USER` + `HPROXY_PROXY_PASSWORD`: the username is built here
 *   with the Residential Premium grammar their docs show in full
 *   (hproxy.com/llms-full.txt, GET /plans/{id}/sessions, read 2026-10-07):
 *   `<user>-type-residential-country-de-city-berlin-session-<id>-lifetime-<min>`
 *   on `premium.hproxy.com:10000` (HTTP; 12000 is SOCKS5). The `-state-`
 *   token, and whether a sessionless username rotates on port 10000, are not
 *   shown in any example and are unverified.
 * - `HPROXY_API_KEY` alone: the line comes from `POST /plans/{id}/generate`,
 *   which HProxy says to use verbatim because "the exact host, port and
 *   username grammar in the response varies by pool". A session id then maps
 *   to one generated sticky line per process; another process gets another IP.
 */
const HPROXY_API = 'https://hproxy.com/api/v1';
const hproxyLines = new Map();

async function hproxyJson(path, env, fetchImpl = globalThis.fetch, body) {
  const init = { headers: { 'X-API-Key': env.HPROXY_API_KEY, accept: 'application/json' }, signal: AbortSignal.timeout(20_000) };
  if (body === undefined) return getJson(`${HPROXY_API}${path}`, init.headers, fetchImpl);
  const response = await fetchImpl(`${HPROXY_API}${path}`, {
    ...init,
    method: 'POST',
    headers: { ...init.headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(`hproxy: ${path} answered ${response.status}${parsed?.error ? ` (${parsed.error.message ?? parsed.error})` : ''}`);
    error.status = response.status;
    throw error;
  }
  return parsed;
}

const hasSession = (options) => options.session !== undefined && options.session !== null && options.session !== '';

export const hproxy = {
  name: 'hproxy',
  label: 'HProxy Residential',
  env: {
    user: 'HPROXY_PROXY_USER',
    password: 'HPROXY_PROXY_PASSWORD',
    host: 'HPROXY_PROXY_HOST',
    port: 'HPROXY_PROXY_PORT',
    apiKey: 'HPROXY_API_KEY',
  },
  defaults: { host: 'premium.hproxy.com', port: 10000, country: 'us', ttl: 30 },

  configured(env) {
    return Boolean((env.HPROXY_PROXY_USER && env.HPROXY_PROXY_PASSWORD) || env.HPROXY_API_KEY);
  },

  username(base, options = {}) {
    // A username copied from a generated line already carries targeting; the
    // new targeting is built on the bare account name.
    let name = `${base.replace(/-(type|country|state|city|asn|os|session|lifetime|requireUdp)-.*$/, '')}-type-residential`;
    const country = options.country ?? this.defaults.country;
    if (country && lower(country) !== 'ww') name += `-country-${lower(country)}`;
    if (options.state) name += `-state-${slug(options.state)}`;
    if (options.city) name += `-city-${slug(options.city)}`;
    if (options.udp) name += '-requireUdp-true';
    if (hasSession(options)) {
      name += `-session-${String(options.session).replace(/[^A-Za-z0-9]/g, '')}`;
      // Premium takes 3 to 1440 minutes, and both documented lines carry one.
      name += `-lifetime-${Math.min(1440, Math.max(3, Number(options.ttl) || this.defaults.ttl))}`;
    }
    return name;
  },

  async credentials(env, fetchImpl, options = {}) {
    const host = env.HPROXY_PROXY_HOST || this.defaults.host;
    const port = Number(env.HPROXY_PROXY_PORT || this.defaults.port);
    if (env.HPROXY_PROXY_USER && env.HPROXY_PROXY_PASSWORD) {
      return { user: env.HPROXY_PROXY_USER, password: env.HPROXY_PROXY_PASSWORD, host, port };
    }
    need(env, [this.env.apiKey], this.name);
    const planId = env.HPROXY_PLAN_ID || (await this.plan(env, fetchImpl)).id;
    const country = options.country ?? this.defaults.country;
    const body = { protocol: options.protocol === 'socks5' ? 'socks5' : 'http' };
    if (country && lower(country) !== 'ww') body.country = country.toUpperCase();
    if (options.state) body.state = String(options.state);
    if (options.city) body.city = String(options.city);
    if (options.udp) body.udp = true;
    if (hasSession(options)) body.stickyMinutes = Math.min(1440, Math.max(3, Number(options.ttl) || this.defaults.ttl));
    const key = JSON.stringify([env.HPROXY_API_KEY, planId, body, hasSession(options) ? String(options.session) : null]);
    let line = hproxyLines.get(key);
    if (!line) {
      const generated = await hproxyJson(`/plans/${encodeURIComponent(planId)}/generate`, env, fetchImpl, body);
      line = generated?.lines?.[0];
      if (!line) throw new Error('hproxy: generate returned no lines');
      hproxyLines.set(key, line);
    }
    // host:port:user:pass, and a password may itself hold a colon.
    const [lineHost, linePort, user, ...rest] = line.split(':');
    return { user, password: rest.join(':'), host: lineHost, port: Number(linePort), username: user };
  },

  /** The plan to generate lines from: the first residential one. */
  async plan(env, fetchImpl) {
    const { plans = [] } = (await hproxyJson('/plans', env, fetchImpl)) ?? {};
    const plan = plans.find((p) => String(p.productId ?? p.product).startsWith('residential')) ?? plans[0];
    if (!plan) throw new Error('hproxy: the account has no active plan (buy GB first)');
    return plan;
  },

  /** Wallet, and GB left on each plan, from https://hproxy.com/docs/proxy-api */
  async status(env, fetchImpl) {
    need(env, [this.env.apiKey], this.name);
    const [me, wallet, plans] = await Promise.all([
      hproxyJson('/me', env, fetchImpl),
      hproxyJson('/wallet', env, fetchImpl),
      hproxyJson('/plans', env, fetchImpl).catch(() => ({ plans: [] })),
    ]);
    return {
      provider: this.name,
      email: me?.email ?? null,
      credit: typeof wallet?.balanceCents === 'number' ? wallet.balanceCents / 100 : null,
      subscriptions: (plans?.plans ?? []).map((plan) => ({
        id: plan.id,
        kind: plan.productId ?? plan.product ?? 'unknown',
        network: plan.product ?? null,
        mbps: null,
        active: true, // GET /plans lists active plans only
        autoRenew: null,
        expiresAt: plan.expiresAt ?? null,
        price: null,
        bandwidthGb: plan.dataGbTotal ?? null,
        remainingGb: plan.dataGbRemaining ?? null,
      })),
    };
  },
};

export const PROVIDERS = { proxiware, webshare, hproxy };

/** Preference order when the caller names no provider. */
export const DEFAULT_ORDER = ['proxiware', 'webshare', 'hproxy'];

/**
 * Pick a provider: the named one, else `PROXY_PROVIDER`, else the first one
 * with credentials. Throws when nothing is configured, naming what to set.
 */
export function pickProvider(name, env = process.env) {
  const wanted = name || env.PROXY_PROVIDER;
  if (wanted) {
    const provider = PROVIDERS[lower(wanted)];
    if (!provider) {
      throw new Error(`unknown provider "${wanted}" (known: ${Object.keys(PROVIDERS).join(', ')})`);
    }
    return provider;
  }
  const found = DEFAULT_ORDER.map((key) => PROVIDERS[key]).find((provider) => provider.configured(env));
  if (found) return found;
  const error = new Error(
    'no proxy provider configured: set PROXIWARE_PROXY_USER + PROXIWARE_PROXY_PASSWORD, ' +
      'or WEBSHARE_API_KEY (or WEBSHARE_PROXY_USER + WEBSHARE_PROXY_PASSWORD), ' +
      'or HPROXY_PROXY_USER + HPROXY_PROXY_PASSWORD (or HPROXY_API_KEY)',
  );
  error.code = 'PROXY_CREDENTIALS_MISSING';
  throw error;
}
