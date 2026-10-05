#!/usr/bin/env bash
# Stops the fetch container reaching anything private: other machines on the cloud network, the
# cloud metadata server (169.254.169.254, which hands out credentials), and services on this VM
# such as RepoRecon. The app-level checks in fetch-service/app/netguard.py are the first layer. This
# is the second, and the one that still holds if a browser is tricked by a redirect or DNS trick.
#
# Run as root. Safe to run again: every rule is checked before it is added.
set -euo pipefail

NETWORK="${SITERECON_NETWORK:-siterecon-fetch}"
SUBNET="${SITERECON_SUBNET:-172.28.0.0/24}"

if [ "$(id -u)" -ne 0 ]; then echo "Run this as root (sudo)." >&2; exit 1; fi
command -v iptables >/dev/null || { echo "iptables is required." >&2; exit 1; }

if docker network inspect "$NETWORK" >/dev/null 2>&1; then
  if [ "$(docker network inspect -f '{{.EnableIPv6}}' "$NETWORK")" = "true" ]; then
    echo "The $NETWORK network has IPv6 enabled; these IPv4 rules would not cover it. Recreate it without IPv6." >&2
    exit 1
  fi
fi

add() { iptables -C "$@" 2>/dev/null || iptables -I "$@"; }

# DOCKER-USER is checked before Docker's own forwarding rules, for traffic leaving containers.
for destination in \
  0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 \
  192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4; do
  add DOCKER-USER -s "$SUBNET" -d "$destination" -j DROP
done

# Traffic from the container to this machine itself (RepoRecon, MLflow, SSH) goes through INPUT, not
# FORWARD. Replies to connections the host started are allowed. Anything the container starts is not.
add INPUT -s "$SUBNET" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
add INPUT -s "$SUBNET" -j DROP

if command -v netfilter-persistent >/dev/null; then
  netfilter-persistent save >/dev/null
  echo "Rules saved with netfilter-persistent."
else
  echo "NOTE: install iptables-persistent (apt install iptables-persistent) or these rules are lost on reboot."
fi

echo "Egress rules are in place for $SUBNET. Run deploy/vm/verify-egress.sh to prove they work."
