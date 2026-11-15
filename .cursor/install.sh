#!/usr/bin/env bash
# Cloud Agent install script for agent-hivemind.
#
# Idempotent, non-interactive setup:
#   - Bun 1.3.4 (pinned in .tool-versions)
# then installs project dependencies with the frozen lockfile when present.
#
# Bun ships as a plain executable from GitHub releases, so this pins the
# artifact SHA-256 and verifies it before extracting.
set -euo pipefail

BUN_VERSION="1.3.4"
BUN_BIN="/usr/local/bin/bun"
BUNX_BIN="/usr/local/bin/bunx"

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo"
fi

log() { printf '\n=== %s ===\n' "$1"; }

verify_sha256() {
  local file="$1" expected="$2"
  echo "${expected}  ${file}" | sha256sum -c -
}

install_bun() {
  if [ -x "${BUN_BIN}" ] && [ "$("${BUN_BIN}" --version)" = "${BUN_VERSION}" ]; then
    echo "bun ${BUN_VERSION} already installed at ${BUN_BIN}"
    return
  fi

  local asset sha
  case "$(uname -m)" in
    x86_64) asset="bun-linux-x64.zip"; sha="33c6996049e8d37e8b815959b14b05e5b6f496121352bf11bae7d047193c28bf" ;;
    aarch64 | arm64) asset="bun-linux-aarch64.zip"; sha="c46e841fed85347521915b1b3904d6d175d8e2fd915e18e01c111318219115a4" ;;
    *) echo "unsupported arch $(uname -m) for bun" >&2; return 1 ;;
  esac

  log "Installing Bun ${BUN_VERSION} (${asset})"
  local tmp
  tmp="$(mktemp -d)"
  curl -fsSL -o "${tmp}/${asset}" \
    "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${asset}"
  verify_sha256 "${tmp}/${asset}" "${sha}"
  unzip -oq "${tmp}/${asset}" -d "${tmp}"

  ${SUDO} install -m 0755 "${tmp}/${asset%.zip}/bun" "${BUN_BIN}"
  ${SUDO} ln -sf "${BUN_BIN}" "${BUNX_BIN}"
  rm -rf "${tmp}"
}

install_bun

# Prefer the pinned binary over any earlier Bun on PATH.
export PATH="/usr/local/bin:${PATH}"

log "Installing project dependencies"
if [ -f bun.lock ]; then
  "${BUN_BIN}" install --frozen-lockfile
else
  "${BUN_BIN}" install
fi

log "Toolchain ready"
"${BUN_BIN}" --version
