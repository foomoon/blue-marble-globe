// The Regions "studio" API: the back end of the Regions panel. Two ways to run it:
//   - inside the Vite dev server (server/studio.js, npm run dev)
//   - standalone, in the map server's builder container (server/admin-api.js), behind nginx's login
//
//   GET    /api/regions               list saved region configs (+ build info if built)
//   PUT    /api/regions/:name         validate and save regions/<name>.json
//   DELETE /api/regions/:name         remove regions/<name>.json
//   POST   /api/regions/:name/build   start building that region -> { job }
//   GET    /api/jobs/current          the running or most recent job, or null
//   GET    /api/jobs/:id/events       Server-Sent Events: every event so far, then live
//   POST   /api/jobs/:id/cancel       stop the build (it cleans up after itself)
//   GET    /api/export?regions=a,b    download built regions as one region pack (a .tar), to import
//                                     on an air-gapped map server (scripts/region_pack.py)
//
// Builds run scripts/build_region.py as a child process on this machine, one at a
// time. The job lives in the dev server, not the page, so a reload just reconnects.
//
// This API writes files and starts processes. In dev, Vite only listens on localhost; in the
// container, nginx lets only signed-in requests through (server/auth.js). On top of that, every request whose Origin isn't
// this server is refused, so a web page in another tab can't call it.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function validateRegion(input) {
  const errors = [];
  const r = typeof input === "object" && input ? input : {};
  const num = (v) => typeof v === "number" && Number.isFinite(v);

  if (!NAME.test(r.name ?? "")) errors.push("name: 1–40 chars, lowercase letters, digits and dashes");

  // Optional polygon: [[lon, lat], …]. When present, the bbox is derived from it.
  let boundary = null;
  if (r.boundary != null) {
    const ok = Array.isArray(r.boundary) && r.boundary.length >= 3 && r.boundary.length <= 500 &&
      r.boundary.every((p) => Array.isArray(p) && p.length === 2 && num(p[0]) && num(p[1]) &&
        p[0] >= -180 && p[0] <= 180 && p[1] >= -85.05 && p[1] <= 85.05);
    if (!ok) errors.push("boundary: 3–500 [lon, lat] points within ±180° / ±85.05°");
    else {
      boundary = r.boundary.map(([lon, lat]) => [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5]);
      const lons = boundary.map((p) => p[0]), lats = boundary.map((p) => p[1]);
      r.bbox = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
    }
  }
  const [w, s, e, n] = Array.isArray(r.bbox) ? r.bbox : [];
  if (![w, s, e, n].every(num)) errors.push("bbox: [west, south, east, north] in degrees");
  else if (!(w >= -180 && e <= 180 && w < e && s >= -85.05 && n <= 85.05 && s < n))
    errors.push("bbox: must have west < east, south < north, within ±180° / ±85.05°");
  const dateOk = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d));
  if (!Array.isArray(r.dates) || !r.dates.every(dateOk) || r.dates[0] > r.dates[1])
    errors.push("dates: [start, end] as YYYY-MM-DD, start ≤ end");
  if (!Array.isArray(r.months) || !r.months.length || !r.months.every((m) => Number.isInteger(m) && m >= 1 && m <= 12))
    errors.push("months: at least one month, 1–12");
  if (!num(r.max_cloud_percent) || r.max_cloud_percent < 0 || r.max_cloud_percent > 100)
    errors.push("max_cloud_percent: 0–100");
  const [z0, z1] = Array.isArray(r.zoom) ? r.zoom : [];
  if (!Number.isInteger(z0) || !Number.isInteger(z1) || z0 < 0 || z1 > 13 || z0 > z1)
    errors.push("zoom: [min, max] integers, max ≤ 13 (13 = 15 m pan-sharpened)");
  const spl = r.scenes_per_location ?? 4;
  if (!Number.isInteger(spl) || spl < 1 || spl > 10) errors.push("scenes_per_location: 1–10");
  const terrain = r.terrain ?? true;
  if (typeof terrain !== "boolean") errors.push("terrain: true or false");
  const gamma = r.gamma ?? 1.6;
  if (!num(gamma) || gamma < 0.5 || gamma > 3) errors.push("gamma: 0.5–3");

  if (errors.length) return { errors };
  return {
    region: {
      name: r.name,
      title: typeof r.title === "string" && r.title.trim() ? r.title.trim().slice(0, 80) : r.name,
      bbox: [w, s, e, n].map((v) => Math.round(v * 1e5) / 1e5),
      ...(boundary ? { boundary } : {}),
      dates: r.dates,
      months: [...new Set(r.months)].sort((a, b) => a - b),
      max_cloud_percent: r.max_cloud_percent,
      scenes_per_location: spl,
      zoom: [z0, z1],
      terrain,
      stretch: Array.isArray(r.stretch) && r.stretch.length === 2 && r.stretch.every(num) ? r.stretch : [0, 0.3],
      gamma,
      updated_utc: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    },
  };
}

const summary = (job) =>
  job && { id: job.id, region: job.region, state: job.state, started: job.started, ended: job.ended ?? null };

/**
 * The API. Returns { handle(req, res, next), close() }: `handle` answers /api/regions... and
 * /api/jobs... and calls next() for anything else.
 * python: the interpreter for builds (default: the project's .venv, else STUDIO_PYTHON or python3).
 */
export function createStudioApi({ projectRoot, dir = "regions", python } = {}) {
  const root = path.resolve(projectRoot, dir);
  const venv = path.join(projectRoot, ".venv", "bin", "python");
  python ??= process.env.STUDIO_PYTHON || (existsSync(venv) ? venv : "python3");
  mkdirSync(root, { recursive: true });
  const jobs = new Map();
  let current = null;

  // ---- jobs ----
  function startJob(name) {
    const job = { id: randomUUID().slice(0, 8), region: name, state: "running", started: Date.now(), events: [], clients: new Set() };
    const push = (ev) => {
      ev.seq = job.events.length;
      job.events.push(ev);
      for (const c of job.clients) c.write(`data: ${JSON.stringify(ev)}\n\n`);
    };
    const child = spawn(python, ["-u", "scripts/build_region.py", path.join(dir, `${name}.json`)], {
      cwd: projectRoot,
      detached: true, // own process group, so cancel also stops gdal2tiles
      stdio: ["ignore", "pipe", "pipe"],
    });
    job.child = child;
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        push(JSON.parse(line));
      } catch {
        push({ type: "log", message: line });
      }
    });
    readline.createInterface({ input: child.stderr }).on("line", (line) => {
      // GDAL warnings can include signed URLs: drop the access token
      if (line.trim()) push({ type: "log", message: line.replace(/\?st=[^\s'"]*/g, "?<token>"), stream: "stderr" });
    });
    child.on("error", (err) => push({ type: "error", message: `couldn't start the build: ${err.message}` }));
    child.on("close", (code) => {
      job.state = job.cancelRequested ? "cancelled" : code === 0 ? "done" : "failed";
      job.ended = Date.now();
      delete job.child;
      push({ type: "end", state: job.state, code });
      for (const c of job.clients) c.end();
      job.clients.clear();
    });
    jobs.set(job.id, job);
    current = job;
    return job;
  }

  const signal = (job, sig) => {
    try {
      process.kill(-job.child.pid, sig); // the whole process group, gdal2tiles included
    } catch {
      job.child?.kill(sig);
    }
  };
  const killJob = (job) => {
    if (!job?.child || job.cancelRequested) return;
    job.cancelRequested = true;
    signal(job, "SIGTERM"); // the build stops and cleans up after itself
    // Safety net: if it hasn't exited in 20 s, force it and do its cleanup here
    setTimeout(() => {
      if (!job.child) return;
      job.forced = true;
      signal(job, "SIGKILL");
      rmSync(path.join(projectRoot, "data", "regions-work", job.region), { recursive: true, force: true });
      // Only remove tiles if this build had started writing them; otherwise they're the previous build's
      if (job.events.some((e) => e.type === "stage" && e.stage === "tile")) {
        rmSync(path.join(projectRoot, "public", "tiles", "landsat", job.region), { recursive: true, force: true });
      }
    }, 20_000).unref();
  };

  function buildInfo(name) {
    const rec = path.join(projectRoot, "provenance", "regions", `${name}.json`);
    const tiles = path.join(projectRoot, "public", "tiles", "landsat", name);
    if (!existsSync(rec) || !existsSync(tiles)) return null;
    const p = JSON.parse(readFileSync(rec, "utf8"));
    return {
      built_utc: p.built_utc,
      seconds: p.wall_clock_seconds?.total,
      tiles: p.output?.tile_count,
      bytes: p.output?.bytes,
      total_bytes: (p.output?.bytes ?? 0) + (p.terrain?.bytes ?? 0), // imagery + terrain: a region pack's size
      scenes: p.scenes?.length,
      url: `/tiles/landsat/${name}/{z}/{x}/{y}.webp`,
    };
  }

  // ---- helpers ----
  const send = (res, status, body) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  };
  const sameOrigin = (req) => !req.headers.origin || new URL(req.headers.origin).host === req.headers.host;

  // ---- /api/regions ----
  async function regionsApi(req, res, rest) {
    if (!sameOrigin(req)) return send(res, 403, { error: "cross-origin request refused" });
    const parts = (rest || "/").split("?")[0].split("/").filter(Boolean).map(decodeURIComponent);
    const [name, action] = parts;
    try {
      if (req.method === "GET" && !name) {
        const regions = readdirSync(root)
          .filter((f) => f.endsWith(".json"))
          .map((f) => JSON.parse(readFileSync(path.join(root, f), "utf8")))
          .map((r) => ({ ...r, build: buildInfo(r.name) }));
        return send(res, 200, { regions });
      }
      if (!NAME.test(name ?? "")) return send(res, 400, { error: "invalid region name" });
      const file = path.join(root, `${name}.json`);

      if (action === "build" && req.method === "POST") {
        if (current?.state === "running") return send(res, 409, { error: `already building ${current.region}`, job: summary(current) });
        if (!existsSync(file)) return send(res, 404, { error: "save the region before building it" });
        if (python.includes("/") && !existsSync(python)) return send(res, 500, { error: "missing .venv; see README (Regional Landsat layers)" });
        return send(res, 202, { job: summary(startJob(name)) });
      }
      if (action) return send(res, 404, { error: "unknown action" });

      if (req.method === "PUT") {
        if (!String(req.headers["content-type"]).startsWith("application/json"))
          return send(res, 415, { error: "expected application/json" });
        let raw = "";
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 10_000) return send(res, 413, { error: "config too large" });
        }
        const { region, errors } = validateRegion({ ...JSON.parse(raw), name });
        if (errors) return send(res, 422, { errors });
        writeFileSync(file, JSON.stringify(region, null, 2) + "\n");
        return send(res, 200, { region: { ...region, build: buildInfo(name) } });
      }
      if (req.method === "DELETE") {
        if (current?.state === "running" && current.region === name) return send(res, 409, { error: "region is building" });
        rmSync(file, { force: true });
        return send(res, 200, { deleted: name });
      }
      return send(res, 405, { error: "method not allowed" });
    } catch (err) {
      return send(res, 500, { error: String(err.message || err) });
    }
  }

  // ---- /api/export ----
  function exportApi(req, res, rest) {
    if (!sameOrigin(req)) return send(res, 403, { error: "cross-origin request refused" });
    if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
    const names = [...new Set((new URL(rest, "http://x").searchParams.get("regions") ?? "").split(",").filter(Boolean))];
    if (!names.length) return send(res, 400, { error: "name the regions: ?regions=a,b" });
    const bad = names.find((n) => !NAME.test(n));
    if (bad) return send(res, 400, { error: `invalid region name: ${bad}` });
    const unbuilt = names.find((n) => !buildInfo(n));
    if (unbuilt) return send(res, 404, { error: `${unbuilt} isn't built` });
    if (current?.state === "running" && names.includes(current.region))
      return send(res, 409, { error: `${current.region} is building: export it when the build is done` });

    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const shown = names.slice(0, 3).join("-") + (names.length > 3 ? `-and-${names.length - 3}-more` : "");
    const child = spawn(python, ["-I", "scripts/region_pack.py", "export", "--stdout", ...names], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    // Headers go with the first bytes: until then a failure can still be a proper error
    child.stdout.once("data", () => {
      res.writeHead(200, {
        "Content-Type": "application/x-tar",
        "Content-Disposition": `attachment; filename="regions-${shown}-${stamp}.tar"`,
        "Cache-Control": "no-store",
      });
    });
    child.stdout.pipe(res, { end: false });
    child.on("close", (code) => {
      if (code === 0 && res.headersSent) return res.end();
      if (!res.headersSent) return send(res, 500, { error: err.trim().split("\n").pop() || `export failed (${code})` });
      res.destroy(); // cut off: the importer refuses an incomplete pack
    });
    res.on("close", () => child.exitCode === null && child.kill()); // the download was cancelled
  }

  // ---- /api/jobs ----
  function jobsApi(req, res, rest) {
    if (!sameOrigin(req)) return send(res, 403, { error: "cross-origin request refused" });
    const [id, action] = (rest || "/").split("?")[0].split("/").filter(Boolean);
    if (id === "current" && req.method === "GET") return send(res, 200, { job: summary(current) });
    const job = jobs.get(id);
    if (!job) return send(res, 404, { error: "no such job" });

    if (action === "events" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const since = Number(new URL(rest, "http://x").searchParams.get("since") ?? 0);
      for (const ev of job.events.slice(since)) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      if (job.state !== "running") return res.end();
      job.clients.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
      req.on("close", () => {
        clearInterval(ping);
        job.clients.delete(res);
      });
      return;
    }
    if (action === "cancel" && req.method === "POST") {
      killJob(job);
      return send(res, 202, { job: summary(job) });
    }
    return send(res, 405, { error: "method not allowed" });
  }

  return {
    handle(req, res, next) {
      const url = req.url || "/";
      for (const [prefix, api] of [["/api/regions", regionsApi], ["/api/jobs", jobsApi], ["/api/export", exportApi]]) {
        if (url === prefix || url.startsWith(prefix + "/") || url.startsWith(prefix + "?")) {
          return api(req, res, url.slice(prefix.length) || "/");
        }
      }
      next();
    },
    /** Stop a running build (it cleans up after itself). */
    close() {
      killJob(current);
    },
  };
}
