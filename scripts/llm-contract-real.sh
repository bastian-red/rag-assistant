#!/usr/bin/env bash
#
# The services/llm contract suite against the REAL Ollama in .env (OLLAMA_URL,
# CHAT_MODEL, EMBED_MODEL). The gate lane runs the same suite against the fake
# on every commit; this run is what proves the fake still behaves like the
# real server. Run it before a model, Ollama or client change ships.
#
#   ./scripts/llm-contract-real.sh
#   LLM_CONTRACT_THINKING_MODEL=qwen3:4b ./scripts/llm-contract-real.sh
#
# The second form also checks that a pulled thinking-only build is reported
# as unfit (pull it first; it is 2.5 GB). Takes about a minute with the models
# loaded, up to five cold, on a CPU. Not in CI: a runner has no model server.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/load-env.sh
. scripts/load-env.sh

pnpm exec turbo run build --filter=@rag/llm --output-logs=errors-only
node scripts/check-models.mjs || {
  echo "llm-contract-real: the model server in .env is not ready (above)." >&2
  exit 1
}
LLM_CONTRACT_URL="$OLLAMA_URL" pnpm --filter @rag/llm exec vitest run src/contract.real.test.ts
