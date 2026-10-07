# @profullstack/proxy

Call the web through the residential proxies we pay for, with each provider's
own authentication and targeting. One package, every surface:

| surface | how |
| --- | --- |
| library | `proxyFetch(url, init, { country, session })`, `proxyUrl()`, `exitIp()`, `status()` |
| CLI | `proxy <url>`, `proxy ip`, `proxy url`, `proxy status` |
| API | `proxy serve`: a local forward proxy that holds the credentials, plus a JSON API |
| MCP | `proxy mcp`: tools `proxy_fetch`, `proxy_ip`, `proxy_url`, `proxy_status` |
| TUI | `proxy tui`: accounts, renewals, and a live exit test |

Providers:

- **Proxiware** Unlimited Residential (`unlimited.proxiware.com:1337`). Targeting
  rides in the username: `-country-us`, `-state-…`, `-city-…`, sticky
  `-sid-<n>-ttl-<min>`. Defaults to a US exit.
- **Webshare** (`p.webshare.io:80`). `-rotate`, `-US-rotate`, or `-<n>` to pin
  proxy n. With only `WEBSHARE_API_KEY`, the proxy login is read from the API.
- **HProxy** Residential, pay per GB (`premium.hproxy.com:10000`). Username
  grammar `-type-residential-country-us-state-…-city-…-session-<id>-lifetime-<min>`
  (lifetime 3 to 1440, default 30 with a session). Defaults to a US exit. With
  only `HPROXY_API_KEY`, lines come from HProxy's generate API instead and are
  used as-is. See [HProxy: what is verified](#hproxy-what-is-verified).

## Install

```sh
npm install -g @profullstack/proxy     # the `proxy` command
npm install @profullstack/proxy        # the library
```

Node 22.19+ (or Bun). In the Profullstack fleet, `cli-tools` ships `proxy` with
the shared vault keys already wired in.

## Credentials

Environment only; the package never reads or writes a file.

| variable | |
| --- | --- |
| `PROXIWARE_PROXY_USER`, `PROXIWARE_PROXY_PASSWORD` | proxy login (Proxiware dashboard, or `GET /v1/unlimited/subscriptions`) |
| `PROXIWARE_API_KEY` | account status (`proxy status`) |
| `PROXIWARE_PROXY_HOST`, `PROXIWARE_PROXY_PORT` | override `unlimited.proxiware.com:1337` |
| `WEBSHARE_API_KEY` | account status, and the proxy login when no user/password is set |
| `WEBSHARE_PROXY_USER`, `WEBSHARE_PROXY_PASSWORD` | proxy login, skips the API lookup |
| `WEBSHARE_PROXY_HOST`, `WEBSHARE_PROXY_PORT` | override `p.webshare.io:80` |
| `HPROXY_PROXY_USER`, `HPROXY_PROXY_PASSWORD` | proxy login (HProxy dashboard, the plan's credential pair) |
| `HPROXY_API_KEY` | `hpx_…` key: account status, and generated lines when no user/password is set |
| `HPROXY_PLAN_ID` | plan to generate lines from (default: the first residential plan) |
| `HPROXY_PROXY_HOST`, `HPROXY_PROXY_PORT` | override `premium.hproxy.com:10000` |
| `PROXY_PROVIDER` | default provider when several are configured (else proxiware, then webshare, then hproxy) |
| `PROXY_SERVE_TOKEN` | default `--token` for `proxy serve` |

## CLI

```sh
proxy https://example.com                    # body to stdout, US residential exit
proxy -i -c gb https://example.com           # status + headers, UK exit
proxy -s job42 --ttl 10 https://example.com  # sticky: same IP for 10 minutes
proxy -X POST -H 'content-type: application/json' -d @body.json https://api.example.com
proxy -o page.html https://example.com
proxy ip                                     # 75.179.96.136  US Ohio …  AS10796 Charter  (proxiware)
proxy url                                    # http://user-country-us:***@unlimited.proxiware.com:1337
export HTTPS_PROXY="$(proxy url --reveal)"   # hand the real URL to another tool
proxy status                                 # credit, plans, renewal, expiry
proxy -p webshare ip                         # a specific provider
proxy -p hproxy -c de --city berlin -s w1 --ttl 30 ip   # HProxy, sticky Berlin exit
```

The default User-Agent is `curl/8.5.0 (+@profullstack/proxy)`: some APIs (ESPN)
allowlist curl-like agents and refuse browser and runtime defaults whatever the
exit IP. `-A` overrides it. Exit codes: 0 ok, 22 non-2xx response (curl's
`--fail`), 3 no credentials, 2 bad arguments, 1 anything else.

## HProxy: what is verified

Built 2026-10-07 from HProxy's own docs (`hproxy.com/llms-full.txt` and
`hproxy.com/api/v1/openapi.json`), without an account, so **nothing here has
carried live traffic yet**.

- Verified in their docs: the two example Residential Premium lines,
  `premium.hproxy.com:10000:USERNAME-type-residential-country-de-city-berlin-os-windows-session-…-lifetime-30:PASSWORD`
  (HTTP) and `premium.hproxy.com:12000:…-asn-7922-requireUdp-true-session-…-lifetime-1440:PASSWORD`
  (SOCKS5); lifetime in minutes, 3 to 1440; the API (`https://hproxy.com/api/v1`,
  `X-API-Key: hpx_…`, `GET /me`, `GET /wallet`, `GET /plans`,
  `POST /plans/{id}/generate`).
- **Unverified**: the `-state-<name>` token (a documented API field, but no
  example line shows it); whether a username without `-session-` rotates per
  request on port 10000 (the docs call 10000 a sticky port, and the rotating
  port range is only in the authenticated plan object); Residential Lite, whose
  host and grammar are not published. HProxy also says the grammar "varies by
  pool" and to use generated lines verbatim, which is what `HPROXY_API_KEY`
  without a user/password does. If a hand-built username 407s or will not
  rotate, use that path, or set `HPROXY_PROXY_PORT` from a generated line.
- With the API path a session id maps to one generated sticky line per process:
  the same id in another process gets a different IP.

## `proxy serve`

```sh
proxy serve --port 8888                      # binds 127.0.0.1
HTTPS_PROXY=http://127.0.0.1:8888 curl https://ipinfo.io/json
curl http://127.0.0.1:8888/status            # JSON API: /status /ip /url /fetch?url=
```

Clients send no credentials; the server adds them on the hop upstream, so a
tool with no proxy-auth support (or one you would rather not hand a password)
still gets the paid exit. Per-connection overrides: `X-Proxy-Country`,
`X-Proxy-Session`. Bind beyond localhost only with `--token T`, which clients
then send as `Proxy-Authorization: Bearer T` (proxy traffic) or
`Authorization: Bearer T` (API).

## MCP

```json
{ "mcpServers": { "proxy": { "command": "proxy", "args": ["mcp"] } } }
```

`proxy_fetch` (url, method, headers, body, max_bytes, provider, country,
session), `proxy_ip`, `proxy_url` (masked unless `reveal`), `proxy_status`.

## Library

```js
import { proxyFetch, proxyUrl, exitIp, status } from '@profullstack/proxy';

const res = await proxyFetch('https://example.com', { headers: { accept: 'text/html' } }, { country: 'us' });
const url = await proxyUrl({ provider: 'proxiware', session: 'worker-3', ttl: 30 });
const { ip, org } = await exitIp({ country: 'gb' });
```

Under Node this is undici's `fetch` with a `ProxyAgent` (credentials sent as a
Basic token, not URL userinfo, which some undici versions drop). Under Bun it is
the built-in `fetch` with its per-request `proxy` option. `createDispatcher()`
returns the undici agent for code that wants to keep one around.

## Development

```sh
npm test                 # offline: fake upstream proxy, no credentials needed
scripts/smoke.sh --vault # live, against the real accounts (shared vault keys)
```

Releases publish to npm from GitHub when a release is published
(`.github/workflows/publish.yml`).

MIT © Profullstack, Inc.
