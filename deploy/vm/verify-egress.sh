#!/usr/bin/env bash
# Proves the egress rules work, from inside a throwaway container on the same network as the fetch
# service. Every private target must fail and the public internet must still work.
# Run after egress-rules.sh. Exit status 0 means all checks passed.
set -uo pipefail

NETWORK="${SITERECON_NETWORK:-siterecon-fetch}"
HOST_PORT="${HOST_SERVICE_PORT:-3000}"   # RepoRecon listens on 3000 on this VM
GATEWAY="$(docker network inspect -f '{{(index .IPAM.Config 0).Gateway}}' "$NETWORK")"

probe() {  # probe <expectation> <description> <url>
  local expect="$1" description="$2" url="$3" code
  code="$(docker run --rm --network "$NETWORK" curlimages/curl:8.10.1 -s -o /dev/null -m 6 -w '%{http_code}' "$url" 2>/dev/null)"
  code="${code:-000}"
  if [ "$expect" = "blocked" ] && [ "$code" = "000" ]; then echo "PASS  blocked  $description"
  elif [ "$expect" = "open" ] && [ "$code" != "000" ]; then echo "PASS  open     $description (HTTP $code)"
  else echo "FAIL  expected $expect, got HTTP $code: $description"; FAILED=1; fi
}

FAILED=0
probe blocked "cloud metadata server"            "http://169.254.169.254/computeMetadata/v1/"
probe blocked "this VM through the gateway ($GATEWAY:$HOST_PORT)" "http://$GATEWAY:$HOST_PORT/"
probe blocked "private range 10.0.0.1"           "http://10.0.0.1/"
probe blocked "private range 192.168.0.1"        "http://192.168.0.1/"
probe blocked "loopback"                         "http://127.0.0.1/"
probe open    "the public internet"              "https://example.com/"

[ "$FAILED" = "0" ] && echo "All egress checks passed." || { echo "Some egress checks FAILED. Do not run the fetch service until they pass."; exit 1; }
