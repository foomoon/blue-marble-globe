#!/usr/bin/env python3
"""
The air-gapped map server's importer: its sign-in, and the admin page's Import, which adds
region packs (exported on the connected side) to the release being served. What the importer
container runs (mapserver/airgap/compose.yaml); nginx passes /auth/ and /api/ to it, and asks
/auth/check before letting any request into /admin/ or /api/. Not published on any port.

  python3 import_server.py          RELEASE (/release), AUTH_DIR (/auth), PORT (8090)

The sign-in works as server/auth.js does on the connected side (same files, cookie and rules):
  users            "name:scrypt$N$r$p$salt$hash" lines (set-password.sh writes them)
  session-secret   signs the session cookies "<user>.<expiry>.<HMAC>": HttpOnly, SameSite=Strict,
                   Secure over HTTPS, 12 hours
Standard library only.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

# region_pack.py (and the build_server.py it uses): beside this file in the importer image, in
# scripts/ when run from the project
_here = Path(__file__).resolve().parent
for _d in (_here, _here.parent.parent / "scripts"):
    if (_d / "region_pack.py").exists():
        sys.path.insert(0, str(_d))
        break
import region_pack  # noqa: E402

RELEASE = Path(os.environ.get("RELEASE", "/release"))
AUTH_DIR = Path(os.environ.get("AUTH_DIR", "/auth"))
PORT = int(os.environ.get("PORT", "8090"))
MAX_UPLOAD = int(float(os.environ.get("MAX_UPLOAD_GB", "8")) * 1e9)  # nginx allows the same

COOKIE = "mapserver_session"
SESSION_SECONDS = 12 * 3600
FAIL_DELAY = 0.7  # every failed sign-in waits this long: slows guessing
NOT_SET_UP = "No sign-in is set up on this server yet. On the server, run: ./set-password.sh"


def read(name: str) -> str | None:
    try:
        return (AUTH_DIR / name).read_text()
    except OSError:
        return None


def users() -> dict[str, str]:
    # Re-read on each use: a password change applies at once, without restarting anything
    out = {}
    for line in (read("users") or "").splitlines():
        if ":" in line:
            name, _, stored = line.partition(":")
            out[name] = stored.strip()
    return out


def secret() -> str | None:
    return (read("session-secret") or "").strip() or None


def sign(data: str, key: str) -> str:
    mac = hmac.new(key.encode(), data.encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(mac).rstrip(b"=").decode()


def check_password(stored: str | None, password: str) -> bool:
    try:
        kind, n, r, p, salt, digest = (stored or "").split("$")
        if kind != "scrypt":
            return False
        expected = base64.b64decode(digest)
        got = hashlib.scrypt(password.encode(), salt=base64.b64decode(salt), n=int(n), r=int(r), p=int(p),
                             maxmem=256 * 1024 * 1024, dklen=len(expected))
        return hmac.compare_digest(got, expected)
    except (ValueError, TypeError):
        return False


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "importer"
    sys_version = ""

    def log_message(self, fmt, *args):  # quiet: imports are logged on their own
        pass

    # ---- helpers ----
    def send(self, status: int, body: dict | None = None, headers: dict | None = None) -> None:
        data = b"" if body is None else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        try:
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass  # the browser went away (a cancelled upload): nothing to tell it

    def path_only(self) -> str:
        return urlsplit(self.path).path

    def same_origin(self) -> bool:
        origin = self.headers.get("Origin")
        return not origin or urlsplit(origin).netloc == self.headers.get("Host")

    def cookie_flags(self) -> str:
        secure = "; Secure" if self.headers.get("X-Forwarded-Proto") == "https" else ""
        return f"Path=/; HttpOnly; SameSite=Strict{secure}"

    def session(self) -> str | None:
        key = secret()
        raw = next((c for c in (self.headers.get("Cookie") or "").split(";")
                    if c.strip().startswith(COOKIE + "=")), None)
        if not key or not raw:
            return None
        v = unquote(raw.strip()[len(COOKIE) + 1:])
        user, _, rest = v.rpartition(".")  # "<user>.<expiry>.<mac>", split from the right
        user, _, exp = user.rpartition(".")
        mac = rest
        if not user or not exp or not mac:
            return None
        if not hmac.compare_digest(sign(f"{user}.{exp}", key).encode(), mac.encode()):
            return None
        try:
            if int(exp) < time.time() or user not in users():
                return None  # expired, or user removed
        except ValueError:
            return None
        return user

    def body_json(self, limit: int = 4096) -> dict | None:
        n = int(self.headers.get("Content-Length") or 0)
        if n > limit:
            return None
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            return {}

    # ---- routes ----
    def do_GET(self):
        url = self.path_only()
        if url == "/healthz":
            data = b"ok\n"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            return self.wfile.write(data)
        if url == "/auth/check":  # nginx's auth_request: 204 lets the request through, 401 doesn't
            user = self.session()
            return self.send(204 if user else 401, None, {"X-User": user} if user else {})
        if url == "/auth/me":
            user = self.session()
            return self.send(200, {"user": user}) if user else self.send(401, {"error": "not signed in"})
        return self.send(404, {"error": "not found"})

    def do_POST(self):
        url = self.path_only()
        if not self.same_origin():
            return self.send(403, {"error": "cross-origin request refused"})
        if url == "/auth/login":
            body = self.body_json()
            if body is None:
                return self.send(413, {"error": "too large"})
            username, password = body.get("username", ""), body.get("password", "")
            key, everyone = secret(), users()
            if not key or not everyone:
                return self.send(503, {"error": NOT_SET_UP})
            if not (isinstance(username, str) and isinstance(password, str)
                    and check_password(everyone.get(username), password)):
                time.sleep(FAIL_DELAY)
                return self.send(401, {"error": "Wrong username or password."})  # never says which
            exp = int(time.time()) + SESSION_SECONDS
            value = f"{username}.{exp}.{sign(f'{username}.{exp}', key)}"
            return self.send(200, {"user": username}, {
                "Set-Cookie": f"{COOKIE}={quote(value, safe='')}; Max-Age={SESSION_SECONDS}; {self.cookie_flags()}"})
        if url == "/auth/logout":
            return self.send(200, {"signed_out": True}, {"Set-Cookie": f"{COOKIE}=; Max-Age=0; {self.cookie_flags()}"})
        if url == "/api/import":
            return self.import_pack()
        return self.send(404, {"error": "not found"})

    def import_pack(self):
        user = self.session()  # nginx checked already; check again here
        if not user:
            return self.send(401, {"error": "not signed in"})
        if self.headers.get("Transfer-Encoding"):
            return self.send(411, {"error": "send the file with a Content-Length"})
        try:
            size = int(self.headers.get("Content-Length") or "")
        except ValueError:
            return self.send(411, {"error": "send the file with a Content-Length"})
        if size > MAX_UPLOAD:
            return self.send(413, {"error": f"larger than {MAX_UPLOAD / 1e9:g} GB: use add-regions.sh on the server"})
        upload_dir = RELEASE / ".import-tmp"
        upload_dir.mkdir(exist_ok=True)
        upload = upload_dir / f"upload-{secrets.token_hex(6)}.tar"
        t0 = time.monotonic()
        try:
            with open(upload, "wb") as f:
                left = size
                while left:
                    chunk = self.rfile.read(min(left, 1 << 20))
                    if not chunk:
                        return self.send(400, {"error": "the upload was cut off: try again"})
                    f.write(chunk)
                    left -= len(chunk)
            result = region_pack.import_pack(upload, RELEASE, log=lambda m: print(f"import: {m}", flush=True))
        except region_pack.PackError as e:
            print(f"import by {user} refused: {e}", flush=True)
            return self.send(409 if "another import" in str(e) else 422, {"error": str(e)})
        except OSError as e:
            print(f"import by {user} failed: {e}", flush=True)
            return self.send(500, {"error": f"couldn't write the region: {e.strerror or e}"})
        finally:
            upload.unlink(missing_ok=True)
        result["seconds"] = round(time.monotonic() - t0, 1)
        print(f"import by {user}: added {result['added']}, replaced {result['replaced']}", flush=True)
        return self.send(200, result)


def main() -> None:
    if not (RELEASE / "tiles").is_dir():
        sys.exit(f"importer: no release at {RELEASE} (expected tiles/ and www/ there)")
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"importer on :{PORT}, release {RELEASE}, sign-in {'set up' if users() else 'not set up yet'}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
