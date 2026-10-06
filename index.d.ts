import type { Server } from 'node:http';
import type { Dispatcher } from 'undici';

export type ProviderName = 'proxiware' | 'webshare';

export interface ProxyOptions {
  /** proxiware | webshare; default PROXY_PROVIDER, else the first configured */
  provider?: ProviderName | string;
  /** ISO 3166 alpha-2 ("us"); "ww" for worldwide. Proxiware defaults to "us". */
  country?: string;
  /** Proxiware: state/region */
  state?: string;
  /** Proxiware: city */
  city?: string;
  /** Sticky session: the same id keeps the same exit IP. Webshare maps it to a list index. */
  session?: string | number;
  /** Proxiware: sticky session lifetime in minutes */
  ttl?: number;
  udp?: boolean;
  protocol?: 'http' | 'socks5';
  /** Where credentials are read from (default process.env) */
  env?: Record<string, string | undefined>;
  /** fetch used for provider account APIs (default globalThis.fetch) */
  fetch?: typeof fetch;
}

export interface ResolvedProxy {
  provider: ProviderName;
  host: string;
  port: number;
  username: string;
  password: string;
  protocol: 'http' | 'socks5';
}

export interface Subscription {
  id: number | string | null;
  kind: string;
  network: string | null;
  mbps: number | null;
  active: boolean | null;
  autoRenew: boolean | null;
  expiresAt: string | null;
  price: number | null;
  bandwidthGb?: number | null;
  proxies?: number | null;
}

export interface AccountStatus {
  provider: ProviderName;
  email: string | null;
  credit: number | null;
  subscriptions: Subscription[];
}

export interface StatusRow {
  provider: ProviderName;
  label: string;
  configured: boolean;
  account: AccountStatus | null;
  error: string | null;
}

export interface ExitIp {
  provider: ProviderName;
  ip: string;
  country?: string;
  region?: string;
  city?: string;
  org?: string;
}

export interface Provider {
  name: ProviderName;
  label: string;
  env: { user: string; password: string; host: string; port: string; apiKey: string };
  defaults: { host: string; port: number; country: string | null };
  configured(env: Record<string, string | undefined>): boolean;
  username(base: string, options?: ProxyOptions): string;
  credentials(
    env: Record<string, string | undefined>,
    fetchImpl?: typeof fetch,
  ): Promise<{ user: string; password: string; host: string; port: number }>;
  status(env: Record<string, string | undefined>, fetchImpl?: typeof fetch): Promise<AccountStatus>;
}

export const PROVIDERS: Record<ProviderName, Provider>;
export const DEFAULT_ORDER: ProviderName[];
export const proxiware: Provider;
export const webshare: Provider;
export function pickProvider(name?: string, env?: Record<string, string | undefined>): Provider;

export function resolveProxy(options?: ProxyOptions): Promise<ResolvedProxy>;
export function formatProxyUrl(resolved: ResolvedProxy): string;
export function proxyUrl(options?: ProxyOptions): Promise<string>;
export function maskProxyUrl(url: string): string;
export function createDispatcher(resolved: ResolvedProxy): Dispatcher;
export function proxyFetch(
  url: string | URL,
  init?: RequestInit,
  options?: ProxyOptions & { timeoutMs?: number; resolved?: ResolvedProxy },
): Promise<Response>;
export function exitIp(options?: ProxyOptions): Promise<ExitIp>;
export function status(options?: {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
}): Promise<StatusRow[]>;

export interface ServeOptions {
  port?: number;
  host?: string;
  /** Require `Bearer <token>` from clients (Proxy-Authorization or Authorization) */
  token?: string;
  proxy?: ProxyOptions;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  resolve?: (options: ProxyOptions) => Promise<ResolvedProxy>;
}
export function serve(
  options?: ServeOptions,
): Promise<{ server: Server; host: string; port: number; close(): Promise<void> }>;

export const TOOLS: Array<{ name: string; description: string; inputSchema: object }>;
export function callTool(
  name: string,
  args?: Record<string, unknown>,
  env?: Record<string, string | undefined>,
): Promise<{ content: Array<{ type: 'text'; text: string }> }>;
export function handle(message: unknown, env?: Record<string, string | undefined>): Promise<object | null>;
export function serveMcp(options?: {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  env?: Record<string, string | undefined>;
}): Promise<void>;

export const HELP: string;
export function parseArgs(argv: string[]): { flags: Record<string, any>; positional: string[] };
export function run(
  argv: string[],
  io?: {
    env?: Record<string, string | undefined>;
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  },
): Promise<number>;
