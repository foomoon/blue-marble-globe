#!/usr/bin/env bash
# Set the map server's admin sign-in (for /admin/ and its API). Asks for a username and password,
# and stores the password hashed (scrypt, salted) in mapserver/auth/users, which isn't committed.
# Also replaces mapserver/auth/session-secret, which signs everyone out.
#
#   npm run server:password        (in a terminal: it asks as you type)
#
# Takes effect at once, with no restart. Python's standard library does the hashing.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -t 0 ]; then
  echo "This asks for a username and password as you type, so it needs a terminal:" >&2
  echo "open Terminal, cd to the project folder, and run: npm run server:password" >&2
  exit 1
fi

IFS= read -rp "Admin username: " user
[[ "$user" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || { echo "Use letters, digits, dot, dash or underscore." >&2; exit 1; }
# IFS= keeps spaces at either end: they are part of the password
IFS= read -rsp "Password (12+ characters): " pass; echo
[ "${#pass}" -ge 12 ] || { echo "Too short: use at least 12 characters." >&2; exit 1; }
IFS= read -rsp "Again: " again; echo
[ "$pass" = "$again" ] || { echo "The passwords don't match." >&2; exit 1; }

mkdir -p mapserver/auth
# The password goes to Python on stdin, never on a command line (where other users could see it)
printf '%s' "$pass" | python3 -I scripts/admin_login.py "$user"
echo "Saved for '$user' (everyone else was signed out)."

# Check it works: sign in to the running map server with it (on this machine only)
port=${MAPSERVER_PORT:-8080}
body=$(printf '%s' "$pass" | python3 -I -c 'import json,sys; print(json.dumps({"username": sys.argv[1], "password": sys.stdin.read()}))' "$user")
code=$(printf '%s' "$body" | curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
  -H 'Content-Type: application/json' -H "Origin: http://localhost:$port" --data-binary @- "http://localhost:$port/auth/login" || true)
case "$code" in
  200) echo "Checked: signing in works. Go to http://localhost:$port/admin/" ;;
  000|502|504) echo "Couldn't check: the map server isn't running (npm run server:up). Then sign in at http://localhost:$port/admin/" ;;
  429) echo "Couldn't check: too many recent sign-in attempts. Wait a minute, then sign in at http://localhost:$port/admin/" ;;
  *) echo "Warning: the map server refused this login (HTTP $code). Tell Claude, or check: docker compose logs builder" >&2 ;;
esac
