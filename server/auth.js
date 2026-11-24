// Sign-in for the map server's admin page: checks a username and password, issues a session
// cookie, and checks that cookie for nginx (auth_request) on every admin page and API request.
//
// Files, in mapserver/auth/ (not committed; npm run server:password writes them):
//   users            one "name:scrypt$N$r$p$salt$hash" line per user (salt, hash: base64)
//   session-secret   signs session cookies; replaced with every password change, which signs
//                    everyone out
//
// Sessions are stateless: "<user>.<expiry>.<HMAC>", HttpOnly, SameSite=Strict, 12 hours.
// Node's standard library only.
import { createHmac, scrypt, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const COOKIE = "mapserver_session";
const SESSION_SECONDS = 12 * 3600;
const FAIL_DELAY_MS = 700; // every failed sign-in waits this long: slows guessing

export function createAuth({ dir }) {
  const read = (name) => {
    try {
      return readFileSync(path.join(dir, name), "utf8");
    } catch {
      return null;
    }
  };
  // Re-read on each use: a password change applies at once, without restarting anything
  const users = () =>
    new Map((read("users") ?? "").split("\n").filter((l) => l.includes(":")).map((l) => {
      const i = l.indexOf(":");
      return [l.slice(0, i), l.slice(i + 1).trim()];
    }));
  const secret = () => read("session-secret")?.trim() || null;

  const sign = (data, key) => createHmac("sha256", key).update(data).digest("base64url");

  function checkPassword(stored, password) {
    const [kind, n, r, p, salt, hash] = (stored ?? "").split("$");
    if (kind !== "scrypt") return Promise.resolve(false);
    const expected = Buffer.from(hash, "base64");
    return new Promise((resolve) =>
      scrypt(password, Buffer.from(salt, "base64"), expected.length,
        { N: Number(n), r: Number(r), p: Number(p), maxmem: 256 * 1024 * 1024 },
        (err, got) => resolve(!err && timingSafeEqual(got, expected))),
    );
  }

  function session(req) {
    const key = secret();
    const cookie = (req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
    if (!key || !cookie) return null;
    // "<user>.<expiry>.<mac>", split from the right: usernames may contain dots
    const v = decodeURIComponent(cookie.slice(COOKIE.length + 1));
    const i = v.lastIndexOf("."), j = v.lastIndexOf(".", i - 1);
    const [user, exp, mac] = [v.slice(0, j), v.slice(j + 1, i), v.slice(i + 1)];
    if (!user || !exp || !mac) return null;
    const good = Buffer.from(sign(`${user}.${exp}`, key));
    const given = Buffer.from(mac);
    if (good.length !== given.length || !timingSafeEqual(good, given)) return null;
    if (Number(exp) < Date.now() / 1000 || !users().has(user)) return null; // expired, or user removed
    return user;
  }

  const cookieFlags = (req) =>
    `Path=/; HttpOnly; SameSite=Strict${req.headers["x-forwarded-proto"] === "https" ? "; Secure" : ""}`;

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const sameOrigin = (req) => !req.headers.origin || new URL(req.headers.origin).host === req.headers.host;

  return {
    /** Handles /auth/check, /auth/login, /auth/logout, /auth/me; calls next() otherwise. */
    async handle(req, res, next) {
      const url = (req.url ?? "/").split("?")[0];
      if (url === "/auth/check") {
        // nginx's auth_request: 204 lets the request through, 401 doesn't
        const user = session(req);
        return send(res, user ? 204 : 401, undefined, user ? { "X-User": user } : {});
      }
      if (url === "/auth/me" && req.method === "GET") {
        const user = session(req);
        return send(res, user ? 200 : 401, user ? { user } : { error: "not signed in" });
      }
      if (url === "/auth/login" && req.method === "POST") {
        if (!sameOrigin(req)) return send(res, 403, { error: "cross-origin request refused" });
        let raw = "";
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 4096) return send(res, 413, { error: "too large" });
        }
        let username = "", password = "";
        try {
          ({ username = "", password = "" } = JSON.parse(raw));
        } catch {
          return send(res, 400, { error: "expected JSON" });
        }
        const key = secret();
        const all = users();
        if (!key || all.size === 0) {
          return send(res, 503, { error: "No admin login is set up yet. On the server, run: npm run server:password" });
        }
        const ok = typeof username === "string" && typeof password === "string" &&
          (await checkPassword(all.get(username), password));
        if (!ok) {
          await new Promise((r) => setTimeout(r, FAIL_DELAY_MS));
          return send(res, 401, { error: "Wrong username or password." }); // never says which
        }
        const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
        const value = `${username}.${exp}.${sign(`${username}.${exp}`, key)}`;
        return send(res, 200, { user: username },
          { "Set-Cookie": `${COOKIE}=${encodeURIComponent(value)}; Max-Age=${SESSION_SECONDS}; ${cookieFlags(req)}` });
      }
      if (url === "/auth/logout" && req.method === "POST") {
        if (!sameOrigin(req)) return send(res, 403, { error: "cross-origin request refused" });
        return send(res, 200, { signed_out: true }, { "Set-Cookie": `${COOKIE}=; Max-Age=0; ${cookieFlags(req)}` });
      }
      next();
    },
  };
}
