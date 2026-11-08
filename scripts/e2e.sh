#!/usr/bin/env bash
#
# The E2E lane: build in production mode, reseed, start the fake model server,
# the API and the web app, run Playwright. Arguments go straight to
# `playwright test`.
#
# This lane supplies its own environment and starts the apps directly, bypassing
# turbo -- which is exactly why it proves nothing about whether the documented
# `pnpm dev` works. That is scripts/dev-smoke.sh's job, and it strips the
# environment first.
#
# The model server is the fake from @rag/llm (Ollama's HTTP, deterministic
# answers), so the browser flows are reproducible and need no model. Real
# answer quality is the eval lane's job.
#
# Every budget runs at its DOCUMENTED value (.env.example). Each spec's browser
# carries its own X-Forwarded-For (e2e/fixtures.ts), the web server forwards it,
# and the API (trust proxy = 1 hop) keys the per-address budgets on it, the way
# real traffic from many people is keyed.
#
# Usage: ./scripts/e2e.sh [playwright args...]
set -euo pipefail
set -m # each background job leads its own process group, so cleanup kills the whole tree

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOG_DIR="${LOG_DIR:-/tmp/rag-e2e}"
mkdir -p "$LOG_DIR"
API_LOG="$LOG_DIR/api.log"
WEB_LOG="$LOG_DIR/web.log"
INGEST_LOG="$LOG_DIR/ingest.log"
FAKE_LOG="$LOG_DIR/fake-ollama.log"
API_PID=""
WEB_PID=""
INGEST_PID=""
FAKE_PID=""
WAIT_SECONDS="${WAIT_SECONDS:-90}"

cleanup() {
  for pid in "$WEB_PID" "$API_PID" "$INGEST_PID" "$FAKE_PID"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill -- -"$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT

# Caller env > .env > .env.example (scripts/load-env.sh says why).
# shellcheck source=scripts/load-env.sh
. scripts/load-env.sh

[[ -n "${AUTH_SECRET:-}" ]] || export AUTH_SECRET=ci-secret-at-least-32-characters-long
export PORT=""
FAKE_PORT="${E2E_FAKE_OLLAMA_PORT:-11536}"
export OLLAMA_URL="http://127.0.0.1:${FAKE_PORT}"
# The fake server's port, for the health spec that stops and restarts it.
export E2E_FAKE_OLLAMA_PORT="$FAKE_PORT"
# The fake's hashed vectors have their own calibration (integration.sh says
# why): the real model's 0.43 would make every question an abstention.
export RETRIEVAL_MIN_SIMILARITY="${RETRIEVAL_MIN_SIMILARITY:-0.12}"

check_reachable() {
  local url="$1" label="$2" host port
  if [[ ! "$url" =~ ^[a-z+]+://([^@/]*@)?([^:/?#]+):([0-9]+) ]]; then
    return 0
  fi
  host="${BASH_REMATCH[2]}"
  port="${BASH_REMATCH[3]}"
  if ! (exec 3<>"/dev/tcp/${host}/${port}") 2>/dev/null; then
    echo "${label} is not reachable at ${host}:${port}. Start the datastores:" >&2
    echo "  docker compose -f infra/docker-compose.yml up -d" >&2
    return 1
  fi
}
failed=0
check_reachable "$DATABASE_URL" Postgres || failed=1
check_reachable "$REDIS_URL" Redis || failed=1
[[ $failed -eq 0 ]] || exit 1

# Refuse to run against something already listening: the suite would test that
# instead, with whatever environment and build it happens to have.
INGEST_HEALTH="http://127.0.0.1:${INGEST_PORT:-4500}/health"
for url in "${API_BASE_URL}/health" "${APP_BASE_URL}/sign-in" "${OLLAMA_URL}/api/version" "$INGEST_HEALTH"; do
  if curl -sf -o /dev/null "$url" 2>/dev/null; then
    echo "Something is already serving ${url}. Stop it first (pnpm dev?)." >&2
    exit 1
  fi
done

wait_for() {
  local url="$1" name="$2" pid="$3" log="$4"
  local i
  for ((i = 0; i < WAIT_SECONDS; i++)); do
    if curl -sf -o /dev/null "$url" 2>/dev/null; then return 0; fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "${name} exited during startup. Last 30 lines of ${log}:" >&2
      tail -30 "$log" >&2
      exit 1
    fi
    sleep 1
  done
  echo "${name} never came up at ${url} within ${WAIT_SECONDS}s. Last 30 lines of ${log}:" >&2
  tail -30 "$log" >&2
  exit 1
}

echo "==> Building everything (production)"
NODE_ENV=production pnpm exec turbo run build >"$LOG_DIR/build.log" 2>&1 || {
  tail -40 "$LOG_DIR/build.log" >&2
  exit 1
}

echo "==> Applying migrations and seeding"
pnpm --filter @rag/db run migrate:deploy >"$LOG_DIR/migrate.log" 2>&1 || {
  tail -30 "$LOG_DIR/migrate.log" >&2
  exit 1
}
# The seed restores its own accounts, so a previous run never decides this
# run's outcome. Specs that change things do it on rows they create themselves.
pnpm --filter @rag/db run seed >"$LOG_DIR/seed.log" 2>&1 || {
  tail -30 "$LOG_DIR/seed.log" >&2
  exit 1
}

# Accounts earlier runs made through the sign-up form, and their files.
pnpm --filter @rag/db exec node ../../scripts/e2e-cleanup.mjs >"$LOG_DIR/cleanup.log" 2>&1 || {
  tail -20 "$LOG_DIR/cleanup.log" >&2
  exit 1
}

echo "==> Starting the fake model server, ingest worker, api, web (logs in ${LOG_DIR})"
node services/llm/dist/fake/main.js --port "$FAKE_PORT" --models "${CHAT_MODEL},${EMBED_MODEL}" \
  >"$FAKE_LOG" 2>&1 &
FAKE_PID=$!
wait_for "${OLLAMA_URL}/api/version" fake-ollama "$FAKE_PID" "$FAKE_LOG"
# The worker before the API: it re-queues the seeded documents at start
# (reconcile), and the library specs wait for them to be READY.
node services/ingest/dist/main.js >"$INGEST_LOG" 2>&1 &
INGEST_PID=$!
wait_for "$INGEST_HEALTH" ingest "$INGEST_PID" "$INGEST_LOG"
node apps/api/dist/main.js >"$API_LOG" 2>&1 &
API_PID=$!
wait_for "${API_BASE_URL}/health" api "$API_PID" "$API_LOG"
(cd apps/web && exec node_modules/.bin/next start -p "$WEB_PORT") >"$WEB_LOG" 2>&1 &
WEB_PID=$!
wait_for "${APP_BASE_URL}/sign-in" web "$WEB_PID" "$WEB_LOG"

echo "==> Running Playwright"
pnpm --filter @rag/e2e exec playwright test "$@"
