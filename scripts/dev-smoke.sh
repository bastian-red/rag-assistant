#!/usr/bin/env bash
#
# Prove the DOCUMENTED `pnpm dev` serves a working app from a cold start.
#
# Every other lane supplies its own environment (e2e.sh and integration.sh source
# .env and start the apps directly, bypassing turbo), so none of them can see the
# failure that sank three sibling projects for months: turbo in strict env mode
# stripping names the app needs, and `pnpm dev` booting an API with no
# AUTH_SECRET. This script strips every .env name from its own environment with
# `env -u` and runs `pnpm dev` exactly as the README says, so the only way the
# configuration can reach the processes is the path a reader's machine uses:
# scripts/dev.sh sourcing .env, turbo passing declared names through.
#
# Assert on content, never on a status code. A broken app answers 200 with an
# error page. So this requires: the api's /health ok (Postgres, Redis, the
# model server and both models); a sign-in through Auth.js; the library
# rendering the seeded user's name and collections as the API read them
# from Postgres (GET /auth/me, GET /collections), so the web -> service
# token -> API -> database path is whole;
# and /status reading every service as up through the API.
#
# The model server must already be running at OLLAMA_URL (a real Ollama, or
# `pnpm ollama:fake` in CI): dev.sh refuses to start without it, and that
# refusal is part of the documented behaviour.
#
# Negative check: point "dev" in package.json back at `turbo run dev` and this
# fails, because nothing then loads .env.
#
# Usage: ./scripts/dev-smoke.sh      (datastores up, migrated, seeded)
set -euo pipefail
set -m

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOG="${LOG:-/tmp/rag-dev-smoke.log}"
COOKIES="$(mktemp -t rag-dev-smoke-cookies.XXXXXX)"
DEV_PID=""
WAIT_SECONDS="${WAIT_SECONDS:-120}"

cleanup() {
  if [[ -n "$DEV_PID" ]] && kill -0 "$DEV_PID" 2>/dev/null; then
    kill -- -"$DEV_PID" 2>/dev/null || true
    wait "$DEV_PID" 2>/dev/null || true
  fi
  rm -f "$COOKIES"
}
trap cleanup EXIT

die() {
  echo >&2
  echo "FAIL: $*" >&2
  exit 1
}

[[ -f .env ]] || die "no .env in the repo root. See README.md, 'Running it'."

env_value() { sed -n "s/^[[:space:]]*$1=//p" .env | tail -1; }
API_PORT="$(env_value API_PORT)"
WEB_PORT="$(env_value WEB_PORT)"
API_BASE_URL="http://localhost:${API_PORT:-4600}"
APP_BASE_URL="http://localhost:${WEB_PORT:-3600}"

# The seeded facts, read out of the seed rather than retyped.
SEED=packages/db/prisma/seed.mts
seed_const() { sed -n "s/^const $1 = '\([^']*\)';.*/\1/p" "$SEED"; }
USER_EMAIL="$(seed_const FIRST_EMAIL)"
USER_PASSWORD="$(seed_const FIRST_PASSWORD)"
USER_NAME="$(seed_const FIRST_NAME)"
for pair in "FIRST_EMAIL:$USER_EMAIL" "FIRST_PASSWORD:$USER_PASSWORD" "FIRST_NAME:$USER_NAME"; do
  [[ -n "${pair#*:}" ]] || die "could not read ${pair%%:*} out of ${SEED}."
done

for url in "${API_BASE_URL}/health" "${APP_BASE_URL}/sign-in"; do
  if curl -sf -o /dev/null "$url" 2>/dev/null; then
    die "something is already serving ${url}. Stop it first."
  fi
done

# Cold, like a fresh clone: no app build output for `dev` to lean on. The
# workspace packages' dist/ is left alone deliberately -- `dev` dependsOn ^build,
# and whether that rebuild happens is part of what is being tested; CI runs this
# on a checkout that has none at all.
echo "==> Removing app build outputs"
for stale in apps/*/dist apps/*/.next; do
  [[ -e "$stale" ]] || continue
  rm -rf "${ROOT:?}/${stale}"
  echo "    removed ${stale}"
done

mapfile -t ENV_KEYS < <(
  sed -n 's/^[[:space:]]*#\?[[:space:]]*\([A-Z][A-Z0-9_]*\)[[:space:]]*=.*/\1/p' .env.example .env | sort -u
)
[[ ${#ENV_KEYS[@]} -gt 0 ]] || die "parsed no variable names out of .env.example."
UNSET_ARGS=()
for key in "${ENV_KEYS[@]}"; do UNSET_ARGS+=(-u "$key"); done

echo "==> Starting: pnpm dev (${#ENV_KEYS[@]} .env names stripped from the child environment)"
echo "    log: ${LOG}"
env "${UNSET_ARGS[@]}" pnpm dev >"$LOG" 2>&1 &
DEV_PID=$!

wait_for() {
  local url="$1" name="$2"
  local i
  for ((i = 0; i < WAIT_SECONDS; i++)); do
    curl -sf -o /dev/null "$url" 2>/dev/null && return 0
    if ! kill -0 "$DEV_PID" 2>/dev/null; then
      echo "pnpm dev exited before ${name} came up. Last 150 lines of ${LOG}:" >&2
      tail -150 "$LOG" >&2
      exit 1
    fi
    sleep 1
  done
  echo "${name} never came up at ${url} within ${WAIT_SECONDS}s. Last 150 lines of ${LOG}:" >&2
  tail -150 "$LOG" >&2
  exit 1
}
# The web port first, and the first page served at once, with no retry. Next
# is ready seconds before the API listens; scripts/wait-for-api.mjs holds the
# web port shut until the API answers, so the first request must already be a
# real page and not an "API unreachable" error.
wait_for_port() {
  local url="$1" name="$2"
  local i
  for ((i = 0; i < WAIT_SECONDS * 4; i++)); do
    [[ "$(curl -s -o /dev/null -w '%{http_code}' "$url" 2>/dev/null)" != "000" ]] && return 0
    if ! kill -0 "$DEV_PID" 2>/dev/null; then
      echo "pnpm dev exited before ${name} came up. Last 150 lines of ${LOG}:" >&2
      tail -150 "$LOG" >&2
      exit 1
    fi
    sleep 0.25
  done
  echo "${name} never opened ${url} within ${WAIT_SECONDS}s. Last 150 lines of ${LOG}:" >&2
  tail -150 "$LOG" >&2
  exit 1
}
echo "==> Waiting for the web port, then reading /status on its first request"
wait_for_port "${APP_BASE_URL}/icon.svg" web
first="$(curl -s -w '\n%{http_code}' "${APP_BASE_URL}/status")"
[[ "${first##*$'\n'}" == "200" ]] && grep -qF "Every service is up" <<<"$first" || {
  tail -60 "$LOG" >&2
  die "the first request to /status after the web port opened did not read every service as up (HTTP ${first##*$'\n'}). Next started before the API listened, or a dependency is down."
}

echo "==> Waiting for api and web"
wait_for "${API_BASE_URL}/health" api
wait_for "${APP_BASE_URL}/sign-in" web

json_field() {
  node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      try { process.stdout.write(String(JSON.parse(raw)[process.argv[1]] ?? "")); } catch {}
    });' "$1"
}

echo "==> Checking /health reports every dependency ok"
body="$(curl -s "${API_BASE_URL}/health")"
[[ "$(json_field status <<<"$body")" == "ok" ]] || die "api /health is not ok: ${body}"
for check in postgres redis ollama models; do
  grep -qF "\"name\":\"${check}\",\"status\":\"ok\"" <<<"$body" ||
    die "api /health does not report ${check} ok: ${body}"
done

echo "==> Signing in as ${USER_EMAIL} through Auth.js"
csrf="$(curl -s -c "$COOKIES" -b "$COOKIES" "${APP_BASE_URL}/api/auth/csrf" | json_field csrfToken)"
[[ -n "$csrf" ]] || die "GET /api/auth/csrf returned no csrfToken. Auth.js is not mounted."
curl -s -o /dev/null -L -c "$COOKIES" -b "$COOKIES" \
  --data-urlencode "csrfToken=${csrf}" \
  --data-urlencode "email=${USER_EMAIL}" \
  --data-urlencode "password=${USER_PASSWORD}" \
  "${APP_BASE_URL}/api/auth/callback/credentials"
session="$(curl -s -c "$COOKIES" -b "$COOKIES" "${APP_BASE_URL}/api/auth/session")"
grep -qF "$USER_EMAIL" <<<"$session" || {
  tail -150 "$LOG" >&2
  die "sign-in produced no session (${session}). AUTH_SECRET never reached a process, or the seed did not run."
}

echo "==> Checking the library renders the user and their collections as the API read them"
library="$(curl -s -L -b "$COOKIES" "${APP_BASE_URL}/")"
grep -qF "$USER_NAME" <<<"$library" || {
  tail -150 "$LOG" >&2
  die "/ does not show '${USER_NAME}'. It is an error page or an empty shell."
}
# The first person's seeded collections, read out of the seed: the page reads
# them through GET /collections, so their names prove the owner-filtered read.
mapfile -t SHELVES < <(grep -ozP "owner: FIRST_EMAIL,\s*collection: '\K[^']+" "$SEED" | tr '\0' '\n')
[[ ${#SHELVES[@]} -gt 0 ]] || die "could not read FIRST_EMAIL's collections out of ${SEED}."
grep -qF 'data-testid="collections"' <<<"$library" || {
  tail -150 "$LOG" >&2
  die "/ lists no collections (web -> service token -> api -> Postgres)."
}
for shelf in "${SHELVES[@]}"; do
  grep -qF "<h3>${shelf}</h3>" <<<"$library" || die "/ does not list the seeded collection '${shelf}'."
done

echo "==> Checking /status reads every service through the API"
status_page="$(curl -s "${APP_BASE_URL}/status")"
grep -qF "Every service is up" <<<"$status_page" || {
  tail -60 "$LOG" >&2
  die "/status does not say every service is up."
}

echo
echo "PASS: pnpm dev serves api and web, configured by .env alone; /health sees Postgres, Redis and both models; sign-in reaches Postgres through the API."
