#!/usr/bin/env bash
# Finds out why the Instagram reader is not working, step by step, in plain words.
# It reads META_IG_USER_ID and META_ACCESS_TOKEN from the env file and never prints the token.
#
#   sudo bash deploy/vm/check-instagram.sh                 # uses /etc/siterecon/siterecon.env
#   sudo bash deploy/vm/check-instagram.sh /path/to/env    # another env file
#   sudo bash deploy/vm/check-instagram.sh /etc/siterecon/siterecon.env nasa   # test with another account
set -u

ENV_FILE="${1:-/etc/siterecon/siterecon.env}"
TARGET="${2:-nasa}"
API="https://graph.facebook.com/v23.0"

[ -r "$ENV_FILE" ] || { echo "Cannot read $ENV_FILE. Run this with sudo."; exit 1; }
command -v curl >/dev/null || { echo "curl is required."; exit 1; }
PY=python3; "$PY" -c 1 2>/dev/null || PY=python; "$PY" -c 1 2>/dev/null || { echo "python3 is required."; exit 1; }

# The env file is read as text, never run as a script.
value() { grep -E "^$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"; }
IG_ID="$(value META_IG_USER_ID)"
TOKEN="$(value META_ACCESS_TOKEN)"

say() { printf '%s\n' "$*"; }
get() { curl -s -m 25 -G "$API/$1" --data-urlencode "access_token=$TOKEN" "${@:2}"; }
# json <field path>: prints one value from the JSON on stdin, or nothing.
json() { "$PY" -c 'import sys,json
try:
    d=json.load(sys.stdin)
    for k in sys.argv[1].split("."):
        d=d[int(k)] if k.isdigit() else d[k]
    print(d)
except Exception:
    pass' "$1"; }
errtext() { "$PY" -c 'import sys,json
try:
    e=json.load(sys.stdin).get("error")
    if e: print("code %s: %s" % (e.get("code"), e.get("message")))
except Exception:
    pass'; }

say "1. Settings"
[ -n "$IG_ID" ] && say "   META_IG_USER_ID is set ($IG_ID)" || { say "   META_IG_USER_ID is NOT set in $ENV_FILE. The Instagram reader stays off."; }
if [ -z "$TOKEN" ]; then say "   META_ACCESS_TOKEN is NOT set in $ENV_FILE. The Instagram reader stays off."; exit 1; fi
say "   META_ACCESS_TOKEN is set (${#TOKEN} characters)"
case "$TOKEN" in
  EAA*) say "   It starts like a Facebook-login token. That is the kind this reader needs." ;;
  IGAA*|IG*) say "   It starts like an Instagram-login token. This reader calls graph.facebook.com, which does not accept those."
             say "   Fix: create the token through Facebook Login for Business (Graph API Explorer, app with the Facebook Login use case)." ;;
  *) say "   It does not start like a Meta token (usually EAA...). Check it was pasted whole, with no spaces or quotes." ;;
esac

say ""
say "2. Is the token valid?"
ME="$(get me --data-urlencode fields=id,name)"
ERR="$(printf '%s' "$ME" | errtext)"
if [ -n "$ERR" ]; then
  say "   No. Meta says: $ERR"
  case "$ERR" in
    *"Cannot parse"*|*"Malformed"*) say "   The token text is not valid. Paste it again, whole, on one line, with no quotes or spaces." ;;
    *"code 190"*) say "   The token expired or was revoked. Short tokens last about 1 hour. Make a long-lived one (60 days):"
                  say "   /oauth/access_token?grant_type=fb_exchange_token&client_id=APP_ID&client_secret=APP_SECRET&fb_exchange_token=SHORT_TOKEN" ;;
  esac
  exit 1
fi
say "   Yes. It belongs to: $(printf '%s' "$ME" | json name) (id $(printf '%s' "$ME" | json id))"

say ""
say "3. Does the token have the permissions it needs?"
PERMS="$(get me/permissions)"
GRANTED="$(printf '%s' "$PERMS" | "$PY" -c 'import sys,json
try:
    print(",".join(p["permission"] for p in json.load(sys.stdin)["data"] if p.get("status")=="granted"))
except Exception:
    pass')"
say "   Granted: ${GRANTED:-none found}"
for need in instagram_basic pages_show_list; do
  case ",$GRANTED," in *",$need,"*) say "   ok   $need" ;; *) say "   MISSING  $need. Add it when generating the token in Graph API Explorer." ;; esac
done

say ""
say "4. Which Instagram accounts can this token reach?"
ACCTS="$(get me/accounts --data-urlencode "fields=name,instagram_business_account{id,username}")"
printf '%s' "$ACCTS" | "$PY" -c 'import sys,json
try:
    data=json.load(sys.stdin).get("data",[])
except Exception:
    data=[]
if not data:
    print("   No Facebook Pages are reachable by this token. The Instagram account must be linked to a Facebook Page you manage,")
    print("   and the token must be allowed to see that Page (pages_show_list).")
for p in data:
    ig=p.get("instagram_business_account")
    if ig:
        print("   Page \"%s\" -> Instagram @%s, id %s   <-- META_IG_USER_ID should be this id" % (p.get("name"), ig.get("username"), ig.get("id")))
    else:
        print("   Page \"%s\" has no professional Instagram account linked to it." % p.get("name"))'

say ""
say "5. Is META_IG_USER_ID the right kind of id?"
IGI="$(get "$IG_ID" --data-urlencode fields=username)"
ERR="$(printf '%s' "$IGI" | errtext)"
if [ -n "$ERR" ]; then
  say "   No. Meta says: $ERR"
  say "   META_IG_USER_ID must be the Instagram account's id from step 4 (not the Facebook user id, Page id or app id)."
else
  say "   Yes. It is Instagram @$(printf '%s' "$IGI" | json username)"
fi

say ""
say "6. End-to-end test: reading @$TARGET through Business Discovery"
BD="$(get "$IG_ID" --data-urlencode "fields=business_discovery.username($TARGET){username,followers_count,media_count}")"
ERR="$(printf '%s' "$BD" | errtext)"
if [ -n "$ERR" ]; then
  say "   Failed. Meta says: $ERR"
  case "$ERR" in
    *"code 24"*|*"code 110"*|*"2207013"*) say "   The account does not exist, is private, or is a personal account. Business Discovery only reads business and creator accounts." ;;
    *"code 4"*|*"code 17"*|*"code 32"*|*"code 613"*) say "   Meta's rate limit was hit. Wait an hour and try again." ;;
    *"code 100"*) say "   Usually the id in META_IG_USER_ID is not an Instagram professional account id (see steps 4 and 5)." ;;
    *"code 10"*|*"code 200"*) say "   A permission is missing (see step 3)." ;;
  esac
  exit 1
fi
say "   Works: @$(printf '%s' "$BD" | json business_discovery.username), $(printf '%s' "$BD" | json business_discovery.followers_count) followers, $(printf '%s' "$BD" | json business_discovery.media_count) posts"
say ""
say "The Instagram reader should work. Restart SiteRecon (sudo systemctl restart siterecon) if you changed the env file."
