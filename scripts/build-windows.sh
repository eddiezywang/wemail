#!/usr/bin/env bash
# One-command Windows installer build driven from WSL2 / Linux.
#
# Builds the `wemail-winbuild` docker image (wine + mono + Node 22 + Bun +
# electron-builder) and runs the full package flow inside it, producing an
# unsigned `dist/*.exe`. Falls back to a clear error message when docker is not
# available so the user can either install Docker Desktop with WSL2 integration
# or fall back to `npm run package:desktop` on a Windows host.
# Dependencies use an isolated temporary volume; build/, dist-electron/ and
# dist/ are still written in the mounted checkout and may be replaced.

set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker not available. Install Docker Desktop with WSL2 integration." >&2
  echo "Alternative: run 'npm run package:desktop' on a Windows host." >&2
  exit 2
fi

IMG="wemail-winbuild:latest"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCKER_SIGNING_ARGS=()

if [[ -n "${CSC_LINK:-}" || -n "${CSC_KEY_PASSWORD:-}" || -n "${WEMAIL_WINDOWS_PUBLISHER:-}" ]]; then
  if [[ -z "${CSC_LINK:-}" || -z "${CSC_KEY_PASSWORD:-}" || -z "${WEMAIL_WINDOWS_PUBLISHER:-}" ]]; then
    echo "ERROR: CSC_LINK, CSC_KEY_PASSWORD, and WEMAIL_WINDOWS_PUBLISHER must be provided together." >&2
    exit 3
  fi
  if [[ "${CSC_LINK}" != "${REPO_ROOT}/"* ]]; then
    echo "ERROR: CSC_LINK must point to a certificate inside the repository so Docker can mount it." >&2
    exit 3
  fi
  if [[ ! -f "${CSC_LINK}" ]]; then
    echo "ERROR: signing certificate not found: ${CSC_LINK}" >&2
    exit 3
  fi
  CERTIFICATE_RELATIVE_PATH="${CSC_LINK#${REPO_ROOT}/}"
  DOCKER_SIGNING_ARGS+=(
    -e "CSC_LINK=/app/${CERTIFICATE_RELATIVE_PATH}"
    -e CSC_KEY_PASSWORD
    -e WEMAIL_WINDOWS_PUBLISHER
  )
fi

echo ">> Building docker image ${IMG} (first run may take several minutes)..."
docker build -t "${IMG}" "${REPO_ROOT}/docker/windows-build"

echo ">> Running Windows cross-build in container..."
docker run --rm \
  -v "${REPO_ROOT}:/app" \
  --mount type=volume,destination=/app/node_modules,volume-nocopy \
  -w /app \
  -e ELECTRON_CACHE=/app/.cache/electron \
  -e ELECTRON_BUILDER_CACHE=/app/.cache/electron-builder \
  "${DOCKER_SIGNING_ARGS[@]}" \
  "${IMG}" -c '
    set -euo pipefail
    # Install deps; native modules (better-sqlite3) compile against host ABI first.
    bun install --frozen-lockfile
    # Rebuild native modules for the electron win32-x64 target so they load
    # correctly inside the packaged .exe.
    npx --no-install @electron/rebuild --arch=x64 --platform=win32 --module-dir .
    # Generate the production renderer and compile Electron main/preload once.
    npm run build:desktop
    # Produce the NSIS installer. electron-builder signs it when CSC_* is provided.
    npx --no-install electron-builder --config electron-builder.config.cjs --win nsis --x64 --publish=never
  '

echo
echo "Produced:"
if ls "${REPO_ROOT}"/dist/*.exe >/dev/null 2>&1; then
  ls -lh "${REPO_ROOT}"/dist/*.exe
else
  echo "  (no .exe found in dist/ — check build output above)"
  exit 1
fi
