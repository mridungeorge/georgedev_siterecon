#!/usr/bin/env bash
# One-time setup of the VM for SiteRecon. Read it before you run it: it adds a swap file if there is
# none, creates a Docker network, installs firewall rules and a systemd unit, and creates the
# environment files. It does not start anything and it does not touch RepoRecon.
#
#   sudo DEPLOY_USER=george_mridunus1 bash deploy/vm/setup.sh
set -euo pipefail

: "${DEPLOY_USER:?set DEPLOY_USER to the account that owns ~/siterecon}"
if [ "$(id -u)" -ne 0 ]; then echo "Run this as root (sudo)." >&2; exit 1; fi
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "== Checks =="
if ! command -v netfilter-persistent >/dev/null; then
  echo "Install iptables-persistent first (sudo apt install iptables-persistent), then run this again." >&2
  exit 1
fi
if ! id -nG "$DEPLOY_USER" | tr ' ' '\n' | grep -qx docker; then
  echo "WARNING: $DEPLOY_USER is not in the docker group. The deploy workflow runs docker as that user, so add it (RepoRecon's deploy user already has this)." >&2
fi

echo "== Swap =="
if swapon --show --noheadings | grep -q .; then
  echo "Swap already present, leaving it alone:"; swapon --show
else
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "Created a 2 GB swap file."
fi

echo "== Docker network =="
docker network inspect siterecon-fetch >/dev/null 2>&1 || \
  docker network create --subnet 172.28.0.0/24 --opt com.docker.network.bridge.name=br-sitefetch siterecon-fetch

echo "== Firewall rules =="
bash "$HERE/egress-rules.sh"

echo "== Environment files =="
install -d -m 0750 -o root -g "$DEPLOY_USER" /etc/siterecon
if [ ! -f /etc/siterecon/siterecon.env ]; then
  SECRET="$(openssl rand -hex 32)"
  cat > /etc/siterecon/siterecon.env <<EOF
# Read by the web app. Keep it private (mode 640, root:$DEPLOY_USER).
SITERECON_DB=/home/$DEPLOY_USER/siterecon/data/siterecon.db
TRUST_PROXY=true
FETCH_SERVICE_URL=http://127.0.0.1:8787
FETCH_SERVICE_SECRET=$SECRET
# Free-tier keys. Leave a line empty to switch that part off. Use projects with billing OFF.
NVIDIA_NIM_API_KEY=
GEMINI_API_KEY=
PAGESPEED_API_KEY=
TAVILY_API_KEY=
MLFLOW_URL=
EOF
  chown root:"$DEPLOY_USER" /etc/siterecon/siterecon.env && chmod 0640 /etc/siterecon/siterecon.env
  echo "Created /etc/siterecon/siterecon.env with a fresh secret. Add your API keys to it."
else
  echo "Keeping the existing /etc/siterecon/siterecon.env"
fi

# The browser container gets its own small file. It opens hostile pages with Chromium's sandbox off,
# so it must never hold anything worth stealing: just the shared secret and two settings.
if [ ! -f /etc/siterecon/fetch.env ]; then
  SECRET="$(grep '^FETCH_SERVICE_SECRET=' /etc/siterecon/siterecon.env | cut -d= -f2-)"
  cat > /etc/siterecon/fetch.env <<EOF
# Read only by the fetch container. The shared secret and render settings, nothing else.
FETCH_SERVICE_SECRET=$SECRET
RENDER_MIN_AVAILABLE_MB=400
RENDER_TIMEOUT_MS=45000
EOF
  chown root:"$DEPLOY_USER" /etc/siterecon/fetch.env && chmod 0640 /etc/siterecon/fetch.env
  echo "Created /etc/siterecon/fetch.env."
else
  echo "Keeping the existing /etc/siterecon/fetch.env"
fi

echo "== systemd unit =="
sed "s/__DEPLOY_USER__/$DEPLOY_USER/g" "$HERE/siterecon.service" > /etc/systemd/system/siterecon.service
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/siterecon/data"
systemctl daemon-reload
systemctl enable siterecon >/dev/null

cat <<'NEXT'

Done. Still to do by hand (see docs/DEPLOY.md):
  1. Add deploy/vm/Caddyfile.snippet to the Caddyfile and reload Caddy.
  2. Point the siterecon.georgemridun.dev DNS record at the VM (Cloudflare, DNS only).
  3. Put your API keys in /etc/siterecon/siterecon.env (not in fetch.env).
  4. Run: bash deploy/vm/verify-egress.sh   (every probe must PASS)
  5. Push to master, or run the Deploy workflow, to build and start both services,
     then run verify-egress.sh again to check the web app can reach the fetch container.
NEXT
