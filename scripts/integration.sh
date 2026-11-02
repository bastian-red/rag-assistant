#!/usr/bin/env bash
#
# The integration lane: real Postgres (pgvector), real Redis, a model server
# that speaks Ollama's HTTP, every service's integration suite.
#
#   ./scripts/integration.sh              # everything
#   ./scripts/integration.sh auth         # the database suite, then API files matching "auth"
#
# Its own database (rag_it) and Redis database (1), so it never touches what
# `pnpm dev` is using. Every budget is the DOCUMENTED one from .env.example:
# the suites spread signed-in calls over fresh users and anonymous calls over
# random addresses, which is how real traffic is keyed, and a lane that lifts a
# limit hides that limit's bugs.
#
# The model server is the fake from @rag/llm on its own port, never the
# developer's Ollama: this lane proves the wiring, and an answer from a real
# model is not a deterministic thing to assert on (that is the eval lane's job).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/load-env.sh
. scripts/load-env.sh

BASE_DB="${DATABASE_URL:-postgresql://rag:rag@localhost:5445/rag?schema=public}"
export DATABASE_URL="${INTEGRATION_DATABASE_URL:-${BASE_DB/\/rag\?/\/rag_it?}}"
BASE_REDIS="${REDIS_URL:-redis://localhost:6391}"
export REDIS_URL="${INTEGRATION_REDIS_URL:-${BASE_REDIS%/}/1}"
[[ -n "${AUTH_SECRET:-}" ]] || export AUTH_SECRET=integration-auth-secret-0123456789

[[ "$DATABASE_URL" != "$BASE_DB" ]] ||
  { echo "integration: refusing to run against the dev database (${BASE_DB%%\?*})." >&2; exit 1; }

echo "integration: build"
# Not the web app: this lane tests the API and the services (e2e.sh builds
# the site against a running API).
pnpm exec turbo run build --filter='!@rag/web' --output-logs=errors-only >/dev/null

# The fake model server, with both configured models listed, so /health is
# green for the right reason. Stopped on any exit.
FAKE_PORT="${INTEGRATION_FAKE_OLLAMA_PORT:-11535}"
export CHAT_MODEL="${CHAT_MODEL:-qwen3:4b-instruct}"
export EMBED_MODEL="${EMBED_MODEL:-qwen3-embedding:0.6b}"
export OLLAMA_URL="http://127.0.0.1:${FAKE_PORT}"
node services/llm/dist/fake/main.js --port "$FAKE_PORT" --models "${CHAT_MODEL},${EMBED_MODEL}" &
FAKE_PID=$!
trap 'kill "$FAKE_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do
  (exec 3<>"/dev/tcp/127.0.0.1/${FAKE_PORT}") 2>/dev/null && break
  sleep 0.1
done

echo "integration: database ${DATABASE_URL%%\?*}, redis ${REDIS_URL}, models ${OLLAMA_URL} (fake)"
pnpm --filter @rag/db exec node -e "
  const { PrismaClient } = require('./generated/client');
  const url = new URL(process.env.DATABASE_URL);
  const name = url.pathname.slice(1);
  url.pathname = '/postgres';
  const admin = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  admin.\$queryRawUnsafe('SELECT 1 FROM pg_database WHERE datname = \$1', name)
    .then((rows) => rows.length === 0 ? admin.\$executeRawUnsafe('CREATE DATABASE \"' + name + '\"') : null)
    .finally(() => admin.\$disconnect());
"
pnpm --filter @rag/api exec node -e "
  const { Redis } = require('ioredis');
  const r = new Redis(process.env.REDIS_URL);
  r.flushdb().finally(() => r.disconnect());
"
pnpm --filter @rag/db exec prisma migrate deploy >/dev/null
node scripts/db-drift.mjs

# The suites delete every user they make. A user left behind is a failure:
# from build step 2 a user carries a library, and leftovers would grow rag_it
# run after run. Counted around each phase, so the message names the phase.
count_users() {
  pnpm --silent --filter @rag/db exec node -e "
    const { PrismaClient } = require('./generated/client');
    const db = new PrismaClient();
    db.user.count().then((n) => console.log(n)).finally(() => db.\$disconnect());
  "
}
leftovers() { # phase before after
  [[ "$2" == "$3" ]] ||
    { echo "integration: the $1 suites left $(($3 - $2)) user(s) in ${DATABASE_URL%%\?*}." >&2; exit 1; }
}

echo "integration: seed"
pnpm --filter @rag/db exec tsx prisma/seed.mts >/dev/null

echo "integration: database guarantees"
before=$(count_users)
pnpm --filter @rag/db exec vitest run --config vitest.integration.config.ts
leftovers database "$before" "$(count_users)"

echo "integration: API"
before=$(count_users)
if [[ $# -gt 0 ]]; then
  pnpm --filter @rag/api exec vitest run --config vitest.integration.config.ts "$@"
else
  pnpm --filter @rag/api exec vitest run --config vitest.integration.config.ts
fi
leftovers API "$before" "$(count_users)"
echo "integration: no users left behind ($before)"
