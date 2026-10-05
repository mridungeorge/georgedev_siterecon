#!/usr/bin/env bash
# One-time setup of the VM for SiteRecon. Read it before you run it: it adds a swap file if there is
# none, creates a Docker network, installs firewall rules and a systemd unit, and creates the
# environment file. It does not start anything and it does not touch RepoRecon.
#
#   sudo DEPLOY_USER=george_mridunus1 bash deploy/vm/setup.sh
set -euo pipefail

: "${DEPLOY_USER:?set DEPLOY_USER to the account that owns ~/siterecon}"
if [ "$(id -u)" -ne 0 ]; then echo "Run this as root (sudo)." >&2; exit 1; fi
HERE="$(cd "$(dirname "$0")" && pwd)"

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

echo "== Environment file =="
install -d -m 0750 -o root -g "$DEPLOY_USER" /etc/siterecon
if [ ! -f /etc/siterecon/siterecon.env ]; then
  SECRET="$(openssl rand -hex 32)"
  cat > /etc/siterecon/siterecon.env <<EOF
# Shared by the web app and the fetch container. Keep it private (mode 640, root:$DEPLOY_USER).
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

echo "== systemd unit =="
sed "s/__DEPLOY_USER__/$DEPLOY_USER/g" "$HERE/siterecon.service" > /etc/systemd/system/siterecon.service
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/siterecon/data"
systemctl daemon-reload
systemctl enable siterecon >/dev/null

cat <<'NEXT'

Done. Still to do by hand (see docs/DEPLOY.md):
  1. Add deploy/vm/Caddyfile.snippet to the Caddyfile and reload Caddy.
  2. Point the siterecon.georgemridun.dev DNS record at the VM (Cloudflare, DNS only).
  3. Put your API keys in /etc/siterecon/siterecon.env.
  4. Run: bash deploy/vm/verify-egress.sh   (every private target must be blocked)
  5. Push to master, or run the Deploy workflow, to build and start both services.
NEXT
