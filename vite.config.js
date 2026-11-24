import { copyFileSync, createReadStream, rmSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { defineConfig } from "vite";
import cesium from "vite-plugin-cesium";
import studio from "./server/studio.js";

// After the build: leave out Cesium's moon texture, whose source isn't documented as
// public domain (the app never draws the moon; see src/main.js), and ship Cesium's
// Apache-2.0 licence with its runtime. See LICENSING.md.
let outDir = "dist";
const licenceHygiene = {
  name: "licence-hygiene",
  apply: "build",
  enforce: "post",
  configResolved(config) {
    outDir = config.build.outDir; // dist/, or mapserver/globe/ for the map server's copy
  },
  closeBundle: {
    order: "post",
    sequential: true, // run after vite-plugin-cesium has copied its assets
    handler() {
      rmSync(`${outDir}/cesium/Assets/Textures/moonSmall.jpg`, { force: true });
      // Apache-2.0 requires the licence to travel with redistributed Cesium code
      copyFileSync("node_modules/cesium/LICENSE.md", `${outDir}/cesium/LICENSE.md`);
    },
  },
};

// Dev only: serve public/tiles straight from disk. Vite serves public/ from a list of files it
// keeps up to date by watching, and watching hundreds of thousands of tiles pegged the CPU, so
// tiles aren't watched (below). Without this, tiles written after the dev server started (a region
// just built in the Regions panel) would get Vite's HTML page instead.
const TILES = resolve("public/tiles");
const TYPES = { ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".json": "application/json" };
const liveTiles = {
  name: "live-tiles",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use("/tiles", (req, res, next) => {
      const path = resolve(TILES, "." + decodeURIComponent(req.url.split("?")[0]));
      if (!path.startsWith(TILES + sep) || !TYPES[extname(path)]) return next();
      let size;
      try {
        size = statSync(path).size;
      } catch {
        res.statusCode = 404;
        return res.end();
      }
      res.setHeader("Content-Type", TYPES[extname(path)]);
      res.setHeader("Content-Length", size);
      res.setHeader("Cache-Control", "no-cache");
      if (req.method === "HEAD") return res.end();
      createReadStream(path).pipe(res);
    });
  },
};

// `vite build --mode mapserver` (npm run server:globe): the globe the map server serves at /globe/.
// Relative paths, so it works wherever it's served from; no copy of public/ (the server already
// serves /tiles and /vectors); settings from .env.mapserver, which outrank .env.local.
export default defineConfig(({ mode }) => ({
  plugins: [cesium(), licenceHygiene, studio(), liveTiles],
  // `--mode admin` (npm run server:admin): the same, plus the Regions panel, for /admin/
  ...(mode === "mapserver" || mode === "admin"
    ? { base: "./", publicDir: false, build: { outDir: mode === "admin" ? "mapserver/admin" : "mapserver/globe", emptyOutDir: true } }
    : {}),
  server: {
    watch: {
      // Hundreds of thousands of tiles, and multi-GB sources: nothing there is code, and watching
      // them kept the dev server's CPU pegged (they're still served from public/, just not watched)
      ignored: ["**/public/tiles/**", "**/data/**", "**/dist/**", "**/test-results/**", "**/playwright-report/**", "**/mapserver/**"],
    },
  },
}));
