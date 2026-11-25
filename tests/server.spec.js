// The map server (Docker): run it first with `npm run server:up`, then `npm run test:server`.
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import https from "node:https";
import { expect, test } from "@playwright/test";

const BASE = process.env.MAPSERVER_URL ?? "http://localhost:8080"; // playwright.config.js picks it
test.skip(!process.env.SERVER_TEST, "start the server (npm run server:up), then npm run test:server");

const url = (path) => (path.startsWith("http") ? path : BASE + path);
const expectCors = (res) => expect(res.headers()["access-control-allow-origin"]).toBe("*");

// The XYZ tile containing the centre of a layer's bounds, at a given zoom
function centreTile([w, s, e, n], z) {
  const lon = (w + e) / 2;
  const lat = (((s + n) / 2) * Math.PI) / 180;
  const k = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * k);
  const y = Math.floor(((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * k);
  return [z, x, y];
}

test("health check and index page", async ({ request, page }) => {
  expect((await request.get(url("/healthz"))).status()).toBe(200);
  await page.goto(url("/"));
  await expect(page.getByRole("heading", { name: "Map server" })).toBeVisible();
  await expect(page.locator("article")).not.toHaveCount(0);
});

test("catalog lists every layer, each tiled layer has valid TileJSON", async ({ request }) => {
  const res = await request.get(url("/catalog.json"));
  expect(res.status()).toBe(200);
  expectCors(res);
  expect(res.headers()["cache-control"]).toBe("no-cache");
  const { layers } = await res.json();
  expect(layers.length).toBeGreaterThan(0);
  for (const layer of layers) expect(layer.tilejson ?? layer.url, layer.id).toMatch(new RegExp(`^${BASE}/`));

  // The same server reached by another name puts that name in its URLs
  const other = await request.get(url("/catalog.json"), { headers: { Host: "maps.lan:8080" } });
  expect((await other.json()).layers[0].provenance).toMatch(new RegExp(`^${new URL(BASE).protocol}//maps\\.lan:8080/`));

  for (const layer of layers.filter((l) => l.kind === "raster" || l.kind === "terrain")) {
    const tj = await request.get(url(layer.tilejson));
    expect(tj.status(), layer.id).toBe(200);
    expect(tj.headers()["content-type"]).toContain("application/json");
    const doc = await tj.json();
    expect(doc.tilejson).toBe("3.0.0");
    // Absolute, so a web map on another site can use them, and on the address we asked
    expect(doc.tiles[0]).toBe(`${BASE}/tiles/${layer.id}/{z}/{x}/{y}.${layer.format}`);
    expect(doc.attribution, `${layer.id} carries its attribution`).toBeTruthy();
    expect(doc.bounds).toHaveLength(4);
    // Terrain says how its colours encode height, for MapLibre's raster-dem
    if (layer.kind === "terrain") expect(doc.encoding).toBe("terrarium");
  }
});

test("tiles: real tiles are served with CORS and caching; skipped tiles answer 204", async ({ request }) => {
  const { layers } = await (await request.get(url("/catalog.json"))).json();
  const types = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

  for (const layer of layers.filter((l) => l.kind === "raster" || l.kind === "terrain")) {
    // A tile that exists: the build's own tile list says so; without one, the tile at the
    // centre of the layer's bounds at its top zoom
    let have = centreTile(layer.bounds, layer.maxzoom);
    let missing = null;
    const index = await request.get(url(`/tiles/${layer.id}/tiles.json`));
    if (index.ok()) {
      const { tiles, same } = await index.json();
      // Copies of a repeated tile (Grey's "same" groups) are real files too
      for (const copies of Object.values(same ?? {}))
        for (const [z, xs] of Object.entries(copies)) for (const [x, ys] of Object.entries(xs)) ((tiles[z] ??= {})[x] ??= []).push(...ys);
      const z = Object.keys(tiles).map(Number).sort((a, b) => b - a)[0];
      const x = Object.keys(tiles[z])[0];
      have = [z, Number(x), tiles[z][x][0]];
      // And one inside the grid that was skipped
      const n = 2 ** z;
      for (let y = 0; y < n && !missing; y++) if (!tiles[z][x].includes(y)) missing = [z, Number(x), y];
    }
    const tile = (zxy) => url(layer.tiles.replace("{z}", zxy[0]).replace("{x}", zxy[1]).replace("{y}", zxy[2]));

    const res = await request.get(tile(have));
    expect(res.status(), `${layer.id} ${have}`).toBe(200);
    expect(res.headers()["content-type"]).toBe(types[layer.format]);
    expect(res.headers()["cache-control"]).toBe("public, max-age=86400");
    expectCors(res);

    if (missing) {
      const gap = await request.get(tile(missing));
      expectCors(gap);
      if (layer.kind === "terrain") {
        // Terrain: a flat sea-level tile, since MapLibre's terrain needs a real tile everywhere
        expect(gap.status(), `${layer.id} sea tile ${missing}`).toBe(200);
        expect(gap.headers()["content-type"]).toBe("image/webp");
      } else expect(gap.status(), `${layer.id} skipped tile ${missing}`).toBe(204);
    }
  }
});

test("vector layers, provenance and licensing are served", async ({ request }) => {
  const { layers } = await (await request.get(url("/catalog.json"))).json();
  for (const layer of layers.filter((l) => l.kind === "vector")) {
    const res = await request.get(url(layer.url));
    expect(res.status(), layer.id).toBe(200);
    expect(res.headers()["content-type"]).toBe("application/geo+json");
    expectCors(res);
    expect((await res.json()).features).toHaveLength(layer.features);
  }
  const prov = await request.get(url("/provenance/"));
  expect(prov.status()).toBe(200);
  expect(await prov.text()).toContain("sources.json");

  const licensing = await request.get(url("/licensing"));
  expect(licensing.status()).toBe(200);
  expect(await licensing.text()).toBe(readFileSync("LICENSING.md", "utf8"));
});

test("a page on another origin can load tiles (CORS in a real browser)", async ({ page, request }) => {
  const { layers } = await (await request.get(url("/catalog.json"))).json();
  const raster = layers.find((l) => l.kind === "raster");
  test.skip(!raster, "no tiled layers built");
  // A real page on another origin. It's on localhost too: Chrome never lets a public site
  // reach localhost, whatever the server says (Private Network Access).
  const site = createServer((_, res) => res.end("<!doctype html><title>Another site</title>"));
  await new Promise((done) => site.listen(0, "127.0.0.1", done));
  await page.goto(`http://127.0.0.1:${site.address().port}/`);
  test.info().attach("origin", { body: page.url() });
  const tileUrl = url(raster.tiles.replace("{z}", raster.minzoom).replace("{x}", "0").replace("{y}", "0"));
  const status = await page.evaluate(async (u) => (await fetch(u)).status, tileUrl);
  site.close();
  expect([200, 204]).toContain(status);
});

test("CORS preflights, including Chrome's private-network check, are answered", async ({ request }) => {
  const res = await request.fetch(url("/catalog.json"), {
    method: "OPTIONS",
    headers: {
      Origin: "https://example.org",
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Private-Network": "true",
    },
  });
  expect(res.status()).toBe(204);
  expectCors(res);
  expect(res.headers()["access-control-allow-private-network"]).toBe("true");
});

test("a globe set to use the map server (VITE_MAP_SERVER_URL) takes all its map data from it", async ({ page }) => {
  const server = new URL(BASE).origin;
  const fromServer = [], fromSite = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (/^\/(tiles|vectors)\//.test(u.pathname)) (u.origin === server ? fromServer : fromSite).push(u.pathname);
  });
  await page.goto("http://localhost:5175/");
  await page.waitForFunction(() => window.viewer?.scene.globe.tilesLoaded, null, { timeout: 60_000 });
  const badge = page.locator(".data-source");
  await expect(badge).toHaveText("Server");
  await expect(badge).toHaveAttribute("data-state", "online");
  await expect(badge).toHaveAttribute("title", new RegExp(server));
  expect(fromServer.length, "map data requests to the map server").toBeGreaterThan(10);
  expect(fromSite, "map data requests to the globe's own site").toEqual([]);
});

test("the map server serves the globe at /globe/, which takes everything from the same server", async ({ page, request }) => {
  test.skip(!existsSync("mapserver/globe/index.html"), "the server's globe isn't built (npm run server:globe)");
  expect((await request.get(url("/globe"), { maxRedirects: 0 })).status()).toBe(301);
  const origins = new Set();
  page.on("request", (r) => r.url().startsWith("http") && origins.add(new URL(r.url()).origin));
  await page.goto(url("/globe/"));
  await page.waitForFunction(() => window.Cesium && document.querySelector(".cesium-widget canvas"), null, { timeout: 60_000 });
  const badge = page.locator(".data-source");
  await expect(badge).toHaveText("Server");
  await expect(badge).toHaveAttribute("data-state", "online");
  await expect(page.locator(".cesium-widget-credits")).toContainText("NASA Earth Observatory");
  expect([...origins], "everything from the map server itself").toEqual([new URL(BASE).origin]);
  // And the home page links to it
  expect(await (await request.get(url("/"))).text()).toContain("Open the globe");
});

test("the admin page and its API need a signed-in session", async ({ request }) => {
  const admin = await request.get(url("/admin/"), { maxRedirects: 0 });
  expect(admin.status()).toBe(302);
  // Relative: the browser keeps the address and port it used (behind port 80, nginx's own 8080 is wrong)
  expect(admin.headers().location).toBe("/login/?next=/admin/");
  expect((await request.get(url("/api/regions"))).status()).toBe(401);
  expect((await request.get(url("/login/"))).status()).toBe(200);
  // A made-up session cookie doesn't get in
  const forged = await request.get(url("/api/regions"), { headers: { Cookie: "mapserver_session=admin.9999999999.AAAA" } });
  expect(forged.status()).toBe(401);
  // Nor a sign-in from another site
  const evil = await request.post(url("/auth/login"), { headers: { Origin: "http://evil.example" }, data: {} });
  expect(evil.status()).toBe(403);
});

// The rest needs the login: MAPSERVER_ADMIN=user:password npm run test:server
const ADMIN = process.env.MAPSERVER_ADMIN?.match(/^([^:]+):(.+)$/);

test.describe("admin page (signed in)", () => {
  test.skip(!ADMIN, "set MAPSERVER_ADMIN=user:password to test the admin page");

  test("signing in on the sign-in page leads to the admin page; signing out ends it", async ({ page }) => {
    const origins = new Set();
    page.on("request", (r) => r.url().startsWith("http") && origins.add(new URL(r.url()).origin));
    await page.goto(url("/admin/"));
    await expect(page).toHaveURL(/\/login\/\?next=%2Fadmin%2F|\/login\/\?next=\/admin\//);
    await page.getByLabel("Username").fill(ADMIN[1]);
    await page.getByLabel("Password").fill("wrong password here");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator(".message")).toHaveText("Wrong username or password.");
    await page.getByLabel("Password").fill(ADMIN[2]);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(url("/admin/"));
    await page.getByRole("button", { name: "Regions" }).click();
    await expect(page.locator(".studio-badge")).toHaveText("admin");
    await expect(page.locator(".studio-list")).toContainText("Mount Everest");
    await expect(page.locator(".data-source")).toHaveText("Server");
    expect([...origins]).toEqual([new URL(BASE).origin]);
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login\//);
    expect((await page.request.get(url("/api/regions"))).status()).toBe(401);
  });

  test("saving and deleting a region goes through to the builder", async ({ request }) => {
    const origin = new URL(BASE).origin;
    const signin = await request.post(url("/auth/login"), { headers: { Origin: origin }, data: { username: ADMIN[1], password: ADMIN[2] } });
    expect(signin.status()).toBe(200);
    const headers = { Origin: origin };
    const name = "server-test-region";
    const put = await request.put(url(`/api/regions/${name}`), {
      headers,
      data: { bbox: [-105.3, 39.98, -105.2, 40.05], dates: ["2023-06-01", "2024-09-30"], months: [7], max_cloud_percent: 20, zoom: [10, 12] },
    });
    expect(put.status()).toBe(200);
    expect(existsSync(`regions/${name}.json`), "written to the project by the builder").toBe(true);
    const list = await (await request.get(url("/api/regions"))).json();
    expect(list.regions.map((r) => r.name)).toContain(name);
    expect((await request.delete(url(`/api/regions/${name}`), { headers })).status()).toBe(200);
    expect(existsSync(`regions/${name}.json`)).toBe(false);
    // And it still refuses another site, signed in or not
    const evil = await request.put(url(`/api/regions/${name}`), { headers: { Origin: "http://evil.example" }, data: {} });
    expect(evil.status()).toBe(403);
  });
});

test("the public globe has an Admin pill that leads to the sign-in page", async ({ page }) => {
  await page.goto(url("/globe/"));
  await expect(page.getByRole("button", { name: "Regions" })).toHaveCount(0);
  await page.getByRole("link", { name: "Admin" }).click();
  await expect(page).toHaveURL(/\/login\/\?next=\/admin\//);
});

test("the server light turns red when the server stops answering, and green again when it's back", async ({ page }) => {
  await page.goto(url("/globe/"));
  const light = page.locator(".data-source");
  await expect(light).toHaveText("Server");
  await expect(light).toHaveAttribute("data-state", "online");
  // The server goes quiet (for this page only: the requests are dropped in the browser)
  await page.route(/\/(healthz|tiles\/|vectors\/)/, (route) => route.abort("connectionrefused"));
  const zoomIn = async () => {
    await page.mouse.move(640, 360);
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -500), await page.waitForTimeout(150); // new tiles needed
  };
  await zoomIn();
  await expect(light).toHaveText("Server offline", { timeout: 15000 });
  await expect(light).toHaveAttribute("data-state", "offline");
  // It's back: the next tiles that arrive light it green, no need to wait for the 30 s check
  await page.unroute(/\/(healthz|tiles\/|vectors\/)/);
  await page.mouse.move(640, 360), await page.mouse.down(), await page.mouse.move(300, 200, { steps: 8 }), await page.mouse.up();
  await zoomIn();
  await expect(light).toHaveText("Server", { timeout: 15000 });
  await expect(light).toHaveAttribute("data-state", "online");
});

// HTTPS, when the server has a certificate (npm run server:cert): checked properly here, against
// the project's CA, where the browser tests above just accept it
test("HTTPS: a certificate the project's CA vouches for, and HTTP redirects to it", async ({ request }) => {
  test.skip(!BASE.startsWith("https:"), "no certificate in mapserver/tls/ (npm run server:cert)");
  const status = await new Promise((resolve, reject) =>
    https.get(`${BASE}/healthz`, { ca: readFileSync("mapserver/tls/ca.crt") }, (res) => resolve(res.statusCode)).on("error", reject));
  expect(status).toBe(200); // the connection fails if the certificate isn't valid for this name
  const plain = await request.get("http://localhost:8080/globe/", { maxRedirects: 0 });
  expect(plain.status()).toBe(301);
  expect(plain.headers().location).toBe(`${BASE}/globe/`);
  expect((await request.get("http://localhost:8080/healthz", { maxRedirects: 0 })).status()).toBe(200);
});
