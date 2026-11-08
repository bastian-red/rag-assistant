#!/usr/bin/env bash
#
# The periodic eval lane: the pinned corpus in evals/corpus, the REAL models
# in .env (OLLAMA_URL, CHAT_MODEL, EMBED_MODEL, EVAL_JUDGE_MODEL), the code the
# API runs (ingest pipeline, retrieval, @rag/answer), and thresholds that fail
# the run. Reports land in evals/reports/<date>-<label>.{json,md}.
#
#   ./scripts/evals.sh --label baseline                  # retrieval, answers, judge
#   ./scripts/evals.sh --phases retrieval,sweep --chunks 400:60,250:40
#   ./scripts/evals.sh --limit 8 --no-fail --no-write    # a quick look
#   ./scripts/evals.sh --baseline evals/reports/2026-11-06-baseline.json
#
# Its own database (rag_eval, same Postgres) and upload folder
# (.data/eval-uploads), so it never touches what `pnpm dev` is using. The
# ingested libraries persist between runs and are reused while the corpus,
# the expected status and the embedding model are unchanged.
#
# Not in CI: a runner has no model server, and the answers come from a model.
# About 35-50 min for a full run on the reference laptop with the iGPU on
# (scripts/ollama-setup.sh); progress, rate and ETA go to
# /tmp/rag-eval/progress.log (tail -f it).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/load-env.sh
. scripts/load-env.sh

BASE_DB="${DATABASE_URL:-postgresql://rag:rag@localhost:5445/rag?schema=public}"
export DATABASE_URL="${EVAL_DATABASE_URL:-${BASE_DB/\/rag\?/\/rag_eval?}}"
[[ "$DATABASE_URL" != "$BASE_DB" ]] ||
  { echo "evals: refusing to run against the dev database (${BASE_DB%%\?*})." >&2; exit 1; }
export UPLOAD_DIR="${EVAL_UPLOAD_DIR:-$ROOT/.data/eval-uploads}"
mkdir -p "$UPLOAD_DIR"

echo "evals: build"
pnpm exec turbo run build --filter=@rag/evals... --output-logs=errors-only >/dev/null

# A run whose phases never chat (retrieval, sweep) needs only the embedding
# model; the nightly workflow pulls nothing else.
phases="retrieval,answers,judge"
args=("$@")
for i in "${!args[@]}"; do
  case "${args[$i]}" in
    --phases=*) phases="${args[$i]#--phases=}" ;;
    --phases) phases="${args[$((i + 1))]:-}" ;;
  esac
done
check=()
[[ ",${phases}," == *",answers,"* || ",${phases}," == *",judge,"* ]] || check=(--embed-only)

node scripts/check-models.mjs "${check[@]}" || {
  echo "evals: the model server in .env is not ready (above). ./scripts/ollama-setup.sh ${check[*]} starts it." >&2
  exit 1
}

echo "evals: database ${DATABASE_URL%%\?*}, uploads ${UPLOAD_DIR}, models ${OLLAMA_URL}"
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
pnpm --filter @rag/db exec prisma migrate deploy >/dev/null

mkdir -p /tmp/rag-eval
echo "evals: follow progress with: tail -f /tmp/rag-eval/progress.log"
exec node evals/dist/main.js "$@"
