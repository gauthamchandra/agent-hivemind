#!/usr/bin/env bash
# Cloud Agent install script for agent-hivemind.
#
# Idempotent, non-interactive setup:
#   - the Bun version named in .tool-versions
# then installs project dependencies from the tracked lockfile.
# The zip checksums below are for one Bun release. A different .tool-versions
# entry exits before the download.
#
# Bun ships as a plain executable from GitHub releases, so this pins the
# artifact SHA-256 and verifies it before extracting.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUN_VERSION="$(awk '/^bun[[:space:]]+/ { print $2; exit }' "${ROOT}/.tool-versions")"
if [ -z "${BUN_VERSION}" ]; then
  echo ".tool-versions does not name a bun version" >&2
  exit 1
fi
CHECKSUM_BUN_VERSION="1.3.4"
if [ "${BUN_VERSION}" != "${CHECKSUM_BUN_VERSION}" ]; then
  echo "bun checksums are for ${CHECKSUM_BUN_VERSION}, and .tool-versions names ${BUN_VERSION}" >&2
  exit 1
fi
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
(cd "${ROOT}" && "${BUN_BIN}" install --frozen-lockfile)

log "Toolchain ready"
"${BUN_BIN}" --version
