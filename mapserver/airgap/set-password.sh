#!/usr/bin/env bash
# Set the sign-in for this map server's admin page (/admin/: importing region packs). Asks for a
# username and password, and stores the password hashed (scrypt, salted) in auth/users, readable
# only by you. Also replaces auth/session-secret, which signs everyone out.
#
#   ./set-password.sh           (in a terminal: it asks as you type)
#
# Takes effect at once, with no restart. This server's login is its own: not the connected side's.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)

if [ ! -t 0 ]; then
  echo "This asks for a username and password as you type, so it needs a terminal." >&2
  exit 1
fi
[ -e "$here/current" ] || { echo "No map server installed in $here: run the bundle's install.sh first." >&2; exit 1; }

IFS= read -rp "Admin username: " user
[[ "$user" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || { echo "Use letters, digits, dot, dash or underscore." >&2; exit 1; }
# IFS= keeps spaces at either end: they are part of the password
IFS= read -rsp "Password (12+ characters): " pass; echo
[ "${#pass}" -ge 12 ] || { echo "Too short: use at least 12 characters." >&2; exit 1; }
IFS= read -rsp "Again: " again; echo
[ "$pass" = "$again" ] || { echo "The passwords don't match." >&2; exit 1; }

mkdir -p "$here/auth" && chmod 700 "$here/auth"
# The password goes to the importer on stdin, never on a command line (where others could see it)
printf '%s' "$pass" | docker compose -f "$here/compose.yaml" --project-directory "$here" \
  run --rm -T --no-deps importer python3 -I /app/admin_login.py "$user"
echo "Saved for '$user' (everyone else was signed out). Sign in at https://<this server's name>/admin/"
