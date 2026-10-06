#!/usr/bin/env bash
# Live smoke test against the real providers: every surface, real traffic.
#
#   scripts/smoke.sh            credentials from the environment
#   scripts/smoke.sh --vault    pull the team's shared keys first (logicsrc
#                               vault profullstack/global--shared); the
#                               decrypted file is emptied straight after
#
# Spends a few KB of proxy traffic. Not part of `npm test`.
set -u
cd "$(dirname "$0")/.." || exit 1

if [ "${1:-}" = "--vault" ]; then
  umask 077
  ENVF="$(mktemp -d)/vault.env"
  logicsrc teams pull profullstack global shared --env "$ENVF" >/dev/null 2>&1 || { echo "vault pull failed" >&2; exit 1; }
  set -a; . "$ENVF"; set +a
  : > "$ENVF"
fi

PORT="${SMOKE_PORT:-18888}"
step() { printf '\n--- %s\n' "$*"; }

step "providers"; node bin/proxy.js providers
step "exit ip (default provider, us)"; node bin/proxy.js ip
step "sticky gb session, twice: same ip expected"; node bin/proxy.js ip -c gb -s 4242; node bin/proxy.js ip -c gb -s 4242
step "status"; node bin/proxy.js status
step "url (masked)"; node bin/proxy.js url
step "fetch ESPN (allowlists curl-like UAs)"
node bin/proxy.js -i 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard' | head -1
step "SiriusXM edge gateway: 401 = reached the app, 403 awselb = exit refused"
node bin/proxy.js -i -X POST -H 'content-type: application/json' -d '{}' \
  https://api.edge-gateway.siriusxm.com/session/v1/sessions/anonymous | head -1

step "serve on 127.0.0.1:$PORT, curl through it"
node bin/proxy.js serve --port "$PORT" 2>/dev/null &
SERVER=$!
sleep 2
curl -s --max-time 30 -x "http://127.0.0.1:$PORT" https://ipinfo.io/json | head -c 160; echo
curl -s --max-time 30 "http://127.0.0.1:$PORT/url"; echo
kill "$SERVER"

step "mcp: proxy_ip over stdio"
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"proxy_ip","arguments":{"country":"us"}}}' \
  | node bin/proxy.js mcp | tail -1 | head -c 300; echo
