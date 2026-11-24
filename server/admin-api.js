// The Regions panel's API and the admin sign-in, standalone: what the map server's builder container
// runs (compose.yaml). nginx passes /api/ and /auth/ to it, and asks /auth/check before letting any
// request into /admin/ or /api/. It isn't published on any port itself.
//
//   node server/admin-api.js        (PROJECT_ROOT, PORT, STUDIO_PYTHON optional)
//
// Node's standard library only.
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAuth } from "./auth.js";
import { createStudioApi } from "./studio-api.js";

const projectRoot = process.env.PROJECT_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT ?? 8090);
const api = createStudioApi({ projectRoot });
const auth = createAuth({ dir: path.join(projectRoot, "mapserver", "auth") }); // the sign-in (/auth/...)

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") return res.end("ok\n");
  auth.handle(req, res, () => api.handle(req, res, () => {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "not found" }));
  }));
});
server.listen(port, "0.0.0.0", () => console.log(`admin API on :${port}, project ${projectRoot}`));

// docker stop: stop a running build cleanly first
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    api.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 25_000).unref();
  });
}
