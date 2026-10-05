#!/usr/bin/env bash
# Starts (or restarts) the fetch service container with the limits from the spec: no extra
# privileges, a read-only filesystem, capped memory, CPU and processes, reachable only from this
# machine, and on the network that deploy/vm/egress-rules.sh locks down.
#
# Playwright starts Chromium with its own sandbox switched off by default, so this container is the
# isolation boundary: that is why it has no capabilities, a read-only root and the egress rules.
set -euo pipefail

IMAGE="${SITERECON_FETCH_IMAGE:-ghcr.io/${GITHUB_OWNER:?set GITHUB_OWNER or SITERECON_FETCH_IMAGE}/siterecon-fetch:latest}"
ENV_FILE="${SITERECON_FETCH_ENV_FILE:-/etc/siterecon/fetch.env}"
NETWORK="${SITERECON_NETWORK:-siterecon-fetch}"
SUBNET="${SITERECON_SUBNET:-172.28.0.0/24}"

# Never start a browser that opens hostile pages without its firewall. This looks for the rule that
# blocks the cloud metadata range; egress-rules.sh installs it.
if ! sudo -n iptables -C DOCKER-USER -s "$SUBNET" -d 169.254.0.0/16 -j DROP 2>/dev/null; then
  echo "The egress firewall rules are not loaded. Run: sudo bash deploy/vm/egress-rules.sh" >&2
  exit 1
fi

docker pull "$IMAGE"
docker rm -f siterecon-fetch >/dev/null 2>&1 || true

# --restart no: after a reboot the container stays down until the next deploy (or this script) starts
# it, because Docker can start containers before the firewall rules are loaded. Until then the report
# simply says the browser and social steps could not run.
# --dns: the VM's own resolver is the cloud metadata server, which the egress rules block.
docker run -d --name siterecon-fetch --restart no \
  --network "$NETWORK" \
  --dns 1.1.1.1 --dns 8.8.8.8 \
  -p 127.0.0.1:8787:8787 \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=256m \
  --shm-size=256m \
  --cap-drop=ALL --security-opt no-new-privileges \
  --pids-limit=256 --memory=700m --memory-swap=700m --cpus=1 \
  --env HOME=/tmp \
  --env-file "$ENV_FILE" \
  "$IMAGE"

echo "siterecon-fetch started on 127.0.0.1:8787"
