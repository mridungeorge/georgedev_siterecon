#!/usr/bin/env bash
# Stops the fetch container reaching anything private: other machines on the cloud network, the
# cloud metadata server (169.254.169.254, which hands out credentials), and services on this VM
# such as RepoRecon. The app-level checks in fetch-service/app/netguard.py and render.py are the first
# layer and are best effort. This is the second, and the one that still holds if a browser is tricked
# by a redirect, a WebSocket or a DNS trick.
#
# Run as root. Safe to run again, and it repairs rules that were added in the wrong order.
set -euo pipefail

NETWORK="${SITERECON_NETWORK:-siterecon-fetch}"
SUBNET="${SITERECON_SUBNET:-172.28.0.0/24}"

if [ "$(id -u)" -ne 0 ]; then echo "Run this as root (sudo)." >&2; exit 1; fi
command -v iptables >/dev/null || { echo "iptables is required." >&2; exit 1; }

# Without persistence the rules disappear at the next reboot. This script stops rather than leave
# the browser container without them.
if ! command -v netfilter-persistent >/dev/null; then
  echo "iptables-persistent is required, otherwise these rules are lost on reboot." >&2
  echo "Install it first:  sudo apt install iptables-persistent   (answer No to saving current rules)" >&2
  exit 1
fi

if docker network inspect "$NETWORK" >/dev/null 2>&1; then
  if [ "$(docker network inspect -f '{{.EnableIPv6}}' "$NETWORK")" = "true" ]; then
    echo "The $NETWORK network has IPv6 enabled; these IPv4 rules would not cover it. Recreate it without IPv6." >&2
    exit 1
  fi
fi

# Adds a rule at the top of its chain if it is not already there.
add() { iptables -C "$@" 2>/dev/null || iptables -I "$@"; }
# Puts a rule at the very top, removing any copies lower down first. -I inserts at the top, so the
# last rule inserted ends up first, and a rule that must win over the DROP below it has to go in last.
ensure_top() { while iptables -C "$@" 2>/dev/null; do iptables -D "$@"; done; iptables -I "$@"; }

# DOCKER-USER is checked before Docker's own forwarding rules, for traffic leaving containers.
for destination in \
  0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 \
  192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4; do
  add DOCKER-USER -s "$SUBNET" -d "$destination" -j DROP
done

# Traffic from the container to this machine itself (RepoRecon, MLflow, SSH) goes through INPUT, not
# FORWARD. The DROP is added first and the ACCEPT last, so the ACCEPT ends up above it: replies to
# connections the host started (the web app calling the fetch service) get through, and anything the
# container starts does not.
add INPUT -s "$SUBNET" -j DROP
ensure_top INPUT -s "$SUBNET" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

netfilter-persistent save >/dev/null
echo "Egress rules are in place for $SUBNET and saved. Run deploy/vm/verify-egress.sh to prove they work."
