#!/usr/bin/env bash
# Proves the egress rules work, from inside a throwaway container on the same network as the fetch
# service. Run after egress-rules.sh, and again once the fetch container is running.
#
# A probe counts as "blocked" only when curl reports exit code 28 (the connection timed out, which is
# what a DROP rule does). Any other failure is not accepted as proof, so an unrelated problem such as
# a broken image or no DNS cannot look like a working firewall. Only targets that really answer on
# this machine are probed, because a closed port fails whether or not any rule exists.
set -uo pipefail

NETWORK="${SITERECON_NETWORK:-siterecon-fetch}"
IMAGE="curlimages/curl:8.10.1"
ENV_FILE="${SITERECON_FETCH_ENV_FILE:-/etc/siterecon/fetch.env}"
HOST_SERVICE_PORT="${HOST_SERVICE_PORT:-3000}"   # RepoRecon listens here
GATEWAY="$(docker network inspect -f '{{(index .IPAM.Config 0).Gateway}}' "$NETWORK" 2>/dev/null)"
SELF_IP="$(hostname -I | awk '{print $1}')"

if ! docker run --rm "$IMAGE" --version >/dev/null 2>&1; then
  echo "FAIL  the curl probe image will not run (is Docker working, and can it pull $IMAGE?)"
  exit 1
fi
if [ -z "$GATEWAY" ]; then echo "FAIL  the $NETWORK network does not exist. Run setup.sh first."; exit 1; fi

FAILED=0
exit_code() {  # exit_code <url>: curl's exit code for a request made from inside the network
  docker run --rm --network "$NETWORK" "$IMAGE" -s -o /dev/null -m 6 -w '%{exitcode}' "$1" 2>/dev/null
}
expect_blocked() {  # expect_blocked <description> <url>
  local code; code="$(exit_code "$2")"
  if [ "$code" = "28" ]; then echo "PASS  blocked  $1"
  else echo "FAIL  expected the connection to time out (28), got '${code:-none}': $1"; FAILED=1; fi
}
expect_open() {  # expect_open <description> <url>
  local code; code="$(exit_code "$2")"
  if [ "$code" = "0" ]; then echo "PASS  open     $1"
  else echo "FAIL  expected success (0), got '${code:-none}': $1"; FAILED=1; fi
}

expect_blocked "the cloud metadata server"                          "http://169.254.169.254/computeMetadata/v1/"
expect_blocked "RepoRecon on this VM, through the gateway ($GATEWAY:$HOST_SERVICE_PORT)" "http://$GATEWAY:$HOST_SERVICE_PORT/"
expect_blocked "this VM's own address ($SELF_IP:22)"                "http://$SELF_IP:22/"
expect_open    "the public internet, including DNS"                 "https://example.com/"

# The path the web app uses: from this machine to the container's published port. A wrong rule order
# drops the replies and this is the check that notices.
if docker ps --format '{{.Names}}' | grep -qx siterecon-fetch; then
  SECRET="$(grep '^FETCH_SERVICE_SECRET=' "$ENV_FILE" 2>/dev/null | cut -d= -f2-)"
  health="$(curl -s -m 8 -H "X-SiteRecon-Secret: $SECRET" http://127.0.0.1:8787/health 2>/dev/null)"
  if echo "$health" | grep -q '"ok":true'; then echo "PASS  open     the web app can reach the fetch service on 127.0.0.1:8787"
  else echo "FAIL  the fetch service did not answer on 127.0.0.1:8787 (got: ${health:-nothing})"; FAILED=1; fi
else
  echo "SKIP  the fetch container is not running yet. Start it, then run this script again to check 127.0.0.1:8787."
fi

[ "$FAILED" = "0" ] && echo "All egress checks passed." || { echo "Some egress checks FAILED. Do not leave the fetch service running until they pass."; exit 1; }
