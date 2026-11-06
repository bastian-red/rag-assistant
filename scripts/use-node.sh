# shellcheck shell=bash
#
# Sourced, not executed: `. scripts/use-node.sh` from the repo root.
#
# Puts the Node pinned in .nvmrc first on PATH for a lane script run directly
# (./scripts/integration.sh), so the processes it starts run on the same Node
# as `pnpm dev`, CI and the images. pnpm already does this for anything it runs
# (.npmrc use-node-version); a shell script started by hand has only the
# machine's node, which here is 20 and end of life.
#
# No-op when the right node is already first (CI's setup-node reads .nvmrc).
use_pinned_node() {
  local want have bin
  want="$(tr -d '[:space:]' <.nvmrc)"
  have="$(node -p process.versions.node 2>/dev/null || true)"
  [[ "$have" == "$want" ]] && return 0
  bin="$(pnpm exec node -p 'require("node:path").dirname(process.execPath)')" || {
    echo "use-node: pnpm could not provide Node $want (.npmrc use-node-version)" >&2
    return 1
  }
  export PATH="$bin:$PATH"
  have="$(node -p process.versions.node)"
  if [[ "$have" != "$want" ]]; then
    echo "use-node: wanted Node $want, PATH gives $have" >&2
    return 1
  fi
}
use_pinned_node
