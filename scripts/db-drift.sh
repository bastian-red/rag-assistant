#!/usr/bin/env bash
#
# `.env` then node. The check itself is scripts/db-drift.mjs; this only supplies
# DATABASE_URL the same three-step way integration.sh and seed-check.sh do, so
# the lane runs identically here and on CI, where the URL arrives through the
# job's environment and no dotenv file is ever written.
set -euo pipefail

cd "$(dirname "$0")/.."

# Caller env > .env > .env.example (scripts/load-env.sh says why).
# shellcheck source=scripts/load-env.sh
. scripts/load-env.sh

# prisma generate must have run (the schema is validated before the diff), and
# a fresh clone has nothing built. Turbo makes this a cache hit otherwise.
pnpm exec turbo run build --filter=@rag/db --output-logs=errors-only >/dev/null

exec node scripts/db-drift.mjs
