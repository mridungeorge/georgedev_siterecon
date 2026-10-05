#!/usr/bin/env bash
# Starts (or restarts) the fetch service container with the limits from the spec: no extra
# privileges, a read-only filesystem, capped memory, CPU and processes, reachable only from this
# machine, and on the network that deploy/vm/egress-rules.sh locks down.
#
# Playwright starts Chromium with its own sandbox switched off by default, so this container is the
# isolation boundary: that is why it has no capabilities, a read-only root and the egress rules.
set -euo pipefail

IMAGE="${SITERECON_FETCH_IMAGE:-ghcr.io/${GITHUB_OWNER:?set GITHUB_OWNER or SITERECON_FETCH_IMAGE}/siterecon-fetch:latest}"
ENV_FILE="${SITERECON_ENV_FILE:-/etc/siterecon/siterecon.env}"
NETWORK="${SITERECON_NETWORK:-siterecon-fetch}"

docker pull "$IMAGE"
docker rm -f siterecon-fetch >/dev/null 2>&1 || true

docker run -d --name siterecon-fetch --restart unless-stopped \
  --network "$NETWORK" \
  -p 127.0.0.1:8787:8787 \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=256m \
  --shm-size=256m \
  --cap-drop=ALL --security-opt no-new-privileges \
  --pids-limit=256 --memory=700m --memory-swap=700m --cpus=1 \
  --env HOME=/tmp \
  --env-file "$ENV_FILE" \
  "$IMAGE"

echo "siterecon-fetch started on 127.0.0.1:8787"
