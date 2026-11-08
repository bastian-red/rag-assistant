#!/usr/bin/env bash
#
# Install Ollama user-locally (no sudo), start it, and pull the two models this
# app needs. Idempotent: run it again and it only does what is missing.
#
#   ./scripts/ollama-setup.sh            install if missing, serve if not running, pull models
#   ./scripts/ollama-setup.sh --check    report only; exit 1 if anything is missing
#   ./scripts/ollama-setup.sh --embed-only   only the embedding model (the nightly
#                                            retrieval eval needs no 2.5 GB chat model)
#
# Where things go:
#
#   ~/.local/ollama/<version>/   the release (binary + its runtime libraries)
#   ~/.local/bin/ollama          a symlink to it, on PATH on most distributions
#   ~/.ollama/models/            the models (several GB), under $HOME, not /var
#   ~/.ollama/serve.log          the server's log when this script started it
#
# The archive (about 2 GB) is downloaded under ~/.local/ollama/ and deleted
# after unpacking, so the free space needed is in $HOME, never in /tmp.
#
# The release is pinned by version AND by SHA-256, both written below: a
# checksum fetched from the same place as the archive would prove nothing about
# the archive. Bump both together, from the release's sha256sum.txt.
#
# Models come from .env (CHAT_MODEL, EMBED_MODEL), falling back to
# .env.example, so this pulls exactly what the app will ask for.
#
# The server it starts uses an integrated GPU when there is one
# (OLLAMA_IGPU_ENABLE=1; Ollama drops iGPUs by default). Measured with
# scripts/model-bench.mjs on an i5-1135G7 / Iris Xe, a 2,819-token prompt:
#
#   CPU only    first token 169 s   prompt  16.7 tok/s   decode 2.5 tok/s
#   Iris Xe     first token  36 s   prompt  79   tok/s   decode 5.6 tok/s
#
# Flash attention changed nothing measurable there, so it is left at its
# default. Set OLLAMA_IGPU_ENABLE=0 before running this to keep a weaker
# iGPU out, and measure your own machine with the bench.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/load-env.sh
. scripts/load-env.sh

VERSION="0.40.12"
declare -A SHA256=(
  [amd64]="f8adcb7e08d272283a4bd3abc18cf581afe37e64b2aee04fda4f407f215485ba"
  [arm64]="eab411c311611fe0fcddf5ba73c68ea94a9571007b520d8708112348b87c0bd6"
)

CHECK_ONLY=0
EMBED_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    --embed-only) EMBED_ONLY=1 ;;
    *) printf 'ollama-setup: unknown option %s (--check, --embed-only)\n' "$arg" >&2; exit 2 ;;
  esac
done

PREFIX="${HOME}/.local/ollama/${VERSION}"
LINK="${HOME}/.local/bin/ollama"
LOG="${HOME}/.ollama/serve.log"
URL="${OLLAMA_URL:-http://localhost:11434}"
CHAT="${CHAT_MODEL:?CHAT_MODEL is not set (.env)}"
EMBED="${EMBED_MODEL:?EMBED_MODEL is not set (.env)}"
MODELS=("$CHAT" "$EMBED")
[[ $EMBED_ONLY -eq 1 ]] && MODELS=("$EMBED")

say() { printf '==> %s\n' "$*"; }
fail() { printf 'ollama-setup: %s\n' "$*" >&2; exit 1; }

case "$(uname -m)" in
  x86_64) ARCH=amd64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) fail "no pinned Ollama build for $(uname -m)." ;;
esac
[[ "$(uname -s)" == "Linux" ]] ||
  fail "this script installs the Linux build. On macOS or Windows install Ollama from https://ollama.com and run it with --check."

# The binary: whichever `ollama` is on PATH, else the one this script installs.
ollama_bin() {
  if command -v ollama >/dev/null 2>&1; then command -v ollama; return; fi
  [[ -x "$PREFIX/bin/ollama" ]] && echo "$PREFIX/bin/ollama"
}

reachable() { curl -sf -o /dev/null --max-time 2 "${URL%/}/api/version"; }

missing=()

# --- 1. the binary ------------------------------------------------------------
BIN="$(ollama_bin || true)"
if [[ -z "$BIN" ]]; then
  if [[ $CHECK_ONLY -eq 1 ]]; then
    missing+=("the ollama binary")
  else
    command -v zstd >/dev/null 2>&1 || fail "zstd is needed to unpack the release (apt install zstd)."
    archive="ollama-linux-${ARCH}.tar.zst"
    # Downloaded beside the install, not into mktemp's /tmp: the archive is
    # about 2 GB and /tmp is often a small partition or a RAM-backed tmpfs (it
    # failed here at 70% with "curl: (23) Failure writing output").
    mkdir -p "$(dirname "$PREFIX")"
    tmp="$(mktemp -d "$(dirname "$PREFIX")/.download.XXXXXX")"
    trap 'rm -rf "$tmp"' EXIT
    say "Downloading Ollama ${VERSION} (${archive})"
    curl -fL --progress-bar -o "$tmp/$archive" \
      "https://github.com/ollama/ollama/releases/download/v${VERSION}/${archive}"
    actual="$(sha256sum "$tmp/$archive" | cut -d' ' -f1)"
    [[ "$actual" == "${SHA256[$ARCH]}" ]] ||
      fail "checksum mismatch for ${archive}: expected ${SHA256[$ARCH]}, got ${actual}. Not installing."
    say "Checksum ok; unpacking into ${PREFIX}"
    mkdir -p "$PREFIX" "$(dirname "$LINK")"
    tar --zstd -xf "$tmp/$archive" -C "$PREFIX"
    [[ -x "$PREFIX/bin/ollama" ]] || fail "the archive had no bin/ollama."
    ln -sfn "$PREFIX/bin/ollama" "$LINK"
    BIN="$PREFIX/bin/ollama"
    case ":${PATH}:" in
      *":$(dirname "$LINK"):"*) ;;
      *) say "Add $(dirname "$LINK") to PATH to run 'ollama' directly." ;;
    esac
  fi
fi
[[ -n "$BIN" ]] && say "Binary: ${BIN} ($("$BIN" --version 2>/dev/null | tail -1 || echo 'version unknown'))"

# --- 2. the server ------------------------------------------------------------
if ! reachable; then
  if [[ $CHECK_ONLY -eq 1 || -z "$BIN" ]]; then
    missing+=("a server answering at ${URL}")
  else
    host_port="${URL#*://}"
    host_port="${host_port%%/*}"
    say "Starting 'ollama serve' on ${host_port} (log: ${LOG})"
    mkdir -p "$(dirname "$LOG")"
    # setsid + nohup: the server outlives this script and the terminal.
    OLLAMA_HOST="$host_port" OLLAMA_IGPU_ENABLE="${OLLAMA_IGPU_ENABLE:-1}" \
      setsid nohup "$BIN" serve >>"$LOG" 2>&1 < /dev/null &
    for _ in $(seq 1 60); do reachable && break; sleep 0.5; done
    reachable || fail "the server did not answer at ${URL} within 30 s. See ${LOG}."
  fi
fi
reachable && say "Server: answering at ${URL}"

# --- 3. the models --------------------------------------------------------------
if reachable; then
  pulled="$(curl -sf "${URL%/}/api/tags")"
  for model in "${MODELS[@]}"; do
    want="$model"
    [[ "${want##*/}" == *:* ]] || want="${want}:latest"
    if grep -qF "\"name\":\"${want}\"" <<<"$pulled"; then
      say "Model: ${model} is pulled"
    elif [[ $CHECK_ONLY -eq 1 || -z "$BIN" ]]; then
      missing+=("the model ${model}")
    else
      say "Pulling ${model} (this is the large download)"
      OLLAMA_HOST="${URL#*://}" "$BIN" pull "$model"
    fi
  done
fi

if [[ ${#missing[@]} -gt 0 ]]; then
  printf 'ollama-setup: missing: %s\n' "$(IFS=';'; echo "${missing[*]}")" >&2
  echo "Run ./scripts/ollama-setup.sh (without --check) to install them." >&2
  exit 1
fi
say "Ready: ${MODELS[*]} at ${URL}"
