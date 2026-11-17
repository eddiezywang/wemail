# Cross-build image for producing Windows (nsis) installers from WSL2 / Linux.
# Based on electronuserland/builder:wine-mono which already bundles wine, mono,
# and the electron-builder system dependencies needed to run signtool-less
# Windows packaging on Linux.
FROM electronuserland/builder:wine-mono

# The base image may ship an older Node; use the Node 22 toolchain required
# by the project and the committed Bun lockfile for dependency installation.
ENV NODE_MAJOR=22
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg; \
    mkdir -p /etc/apt/keyrings; \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg; \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends nodejs; \
    rm -rf /var/lib/apt/lists/*; \
    node --version; \
    npm --version

# Cache electron downloads inside the workspace volume so repeat builds are
# offline-friendly. The build script mounts these paths.
ENV ELECTRON_CACHE=/app/.cache/electron \
    ELECTRON_BUILDER_CACHE=/app/.cache/electron-builder

# Install Bun for the root lockfile. Packaging tools come from the locked tree.
RUN npm install -g --no-audit --no-fund bun@1.3.14

WORKDIR /app

# Default to a shell so `scripts/build-windows.sh` can pass a `bash -c '...'`
# payload. Users who `docker run -it` the image land in an interactive shell.
ENTRYPOINT ["/bin/bash"]
