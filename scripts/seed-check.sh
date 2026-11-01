#!/usr/bin/env bash
#
# Prove the seed is deterministic and idempotent.
#
#   deterministic   two runs produce the same digest, ids included.
#   idempotent      the second run replaces the first instead of adding to it.
#   two libraries   at least two seeded accounts, which the isolation tests need.
#
#   ./scripts/seed-check.sh
set -euo pipefail

cd "$(dirname "$0")/.."

# Caller env > .env > .env.example (scripts/load-env.sh says why).
# shellcheck source=scripts/load-env.sh
. scripts/load-env.sh

# The check reads through the db package's built client; a fresh clone has
# nothing built. Turbo makes this a cache hit otherwise.
pnpm exec turbo run build --filter=@rag/db --output-logs=errors-only >/dev/null

exec node scripts/seed-check.mjs
