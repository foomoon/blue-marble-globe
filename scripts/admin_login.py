#!/usr/bin/env python3
"""
Write an admin login for the map server: mapserver/auth/users and a new session-secret.

  printf '%s' "$password" | python3 scripts/admin_login.py <username>

Called by scripts/admin-password.sh. The password arrives on stdin, never as an argument.
Replaces any other users (one admin login). Standard library only.
"""
import base64, hashlib, os, re, secrets, sys
from pathlib import Path

# mapserver/auth/, or MAPSERVER_AUTH_DIR (the importer container on an air-gapped server: set-password.sh)
AUTH = Path(os.environ.get("MAPSERVER_AUTH_DIR") or Path(__file__).resolve().parents[1] / "mapserver" / "auth")
N, R, P = 2**15, 8, 1  # scrypt cost: ~32 MB and a fraction of a second per check

user = sys.argv[1] if len(sys.argv) == 2 else ""
if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", user):
    sys.exit("usage: printf '%s' PASSWORD | admin_login.py USERNAME")
password = sys.stdin.read()
if len(password) < 12:
    sys.exit("password: at least 12 characters")

salt = os.urandom(16)
digest = hashlib.scrypt(password.encode(), salt=salt, n=N, r=R, p=P, maxmem=64 * 1024 * 1024, dklen=32)
line = f"{user}:scrypt${N}${R}${P}${base64.b64encode(salt).decode()}${base64.b64encode(digest).decode()}\n"

AUTH.mkdir(parents=True, exist_ok=True)
for name, text in [("users", line), ("session-secret", secrets.token_hex(32) + "\n")]:
    tmp = AUTH / (name + ".tmp")
    tmp.write_text(text)
    os.chmod(tmp, 0o600)  # yours only: the builder (or importer), which checks sign-ins, runs as you
    os.replace(tmp, AUTH / name)
(AUTH / "htpasswd").unlink(missing_ok=True)  # the old basic-auth file, if any
