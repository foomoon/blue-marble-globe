// The map server (Docker): run it first with `npm run server:up`, then `npm run test:server`.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { expect, test } from "@playwright/test";

const BASE = process.env.MAPSERVER_URL ?? "http://localhost:8080";
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
  expect((await other.json()).layers[0].provenance).toMatch(/^http:\/\/maps\.lan:8080\//);

  for (const layer of layers.filter((l) => l.kind === "raster")) {
    const tj = await request.get(url(layer.tilejson));
    expect(tj.status(), layer.id).toBe(200);
    expect(tj.headers()["content-type"]).toContain("application/json");
    const doc = await tj.json();
    expect(doc.tilejson).toBe("3.0.0");
    // Absolute, so a web map on another site can use them, and on the address we asked
    expect(doc.tiles[0]).toBe(`${BASE}/tiles/${layer.id}/{z}/{x}/{y}.${layer.format}`);
    expect(doc.attribution, `${layer.id} carries its attribution`).toBeTruthy();
    expect(doc.bounds).toHaveLength(4);
  }
});

test("tiles: real tiles are served with CORS and caching; skipped tiles answer 204", async ({ request }) => {
  const { layers } = await (await request.get(url("/catalog.json"))).json();
  const types = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

  for (const layer of layers.filter((l) => l.kind === "raster")) {
    // A tile that exists: the build's own tile list says so; without one, the tile at the
    // centre of the layer's bounds at its top zoom
    let have = centreTile(layer.bounds, layer.maxzoom);
    let missing = null;
    const index = await request.get(url(`/tiles/${layer.id}/tiles.json`));
    if (index.ok()) {
      const { tiles } = await index.json();
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
      expect(gap.status(), `${layer.id} skipped tile ${missing}`).toBe(204);
      expectCors(gap);
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
