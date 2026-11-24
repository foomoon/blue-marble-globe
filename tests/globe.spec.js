// Checks on the production build: the evidence behind LICENSING.md's
// "no online services" and attribution claims.
import { existsSync } from "node:fs";
import { expect, test } from "@playwright/test";

test.beforeAll(() => {
  expect(
    existsSync("public/tiles/blue-marble-webp/0/0/0.webp") || existsSync("public/tiles/blue-marble/0/0/0.jpg"),
    "No tiles found. Build them first: npm run fetch:source && npm run build:tiles",
  ).toBe(true);
});

test("globe loads every resource from its own origin, with NASA credit and no ion", async ({ page, baseURL }, info) => {
  const origin = new URL(baseURL).origin;
  const external = [];
  const tileStatuses = [];
  const errors = [];
  let lastTile = Date.now();

  page.on("request", (req) => {
    const url = req.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    if (new URL(url).origin !== origin) external.push(url);
  });
  page.on("response", (res) => {
    if (/\/tiles\/blue-marble(-webp)?\/\d+\/\d+\/\d+\.(jpg|webp)$/.test(res.url())) {
      tileStatuses.push(res.status());
      lastTile = Date.now();
    }
  });
  page.on("pageerror", (err) => errors.push(err.message));
  let bordersLoaded = false;
  let statesLoaded = false;
  page.on("response", (res) => {
    if (res.url() === `${origin}/vectors/country-borders.geojson` && res.ok()) bordersLoaded = true;
    if (res.url() === `${origin}/vectors/us-states.geojson` && res.ok()) statesLoaded = true;
  });

  await page.goto("/");

  // Tiles arrive, then settle (no new tile for 2 s)
  await expect.poll(() => tileStatuses.length, { timeout: 45_000 }).toBeGreaterThan(4);
  await expect.poll(() => Date.now() - lastTile, { timeout: 45_000 }).toBeGreaterThan(2_000);

  await info.attach("globe.png", { body: await page.screenshot(), contentType: "image/png" });
  expect(bordersLoaded, "country borders GeoJSON loaded from the app's own origin").toBe(true);
  expect(statesLoaded, "US states GeoJSON loaded from the app's own origin").toBe(true);

  expect(tileStatuses.every((s) => s === 200), `tile statuses: ${[...new Set(tileStatuses)]}`).toBe(true);
  expect(external, "requests that left the app's own origin").toEqual([]);
  expect(errors, "uncaught page errors").toEqual([]);

  // Attribution: NASA credit on screen, with its terms link; Cesium ion logo absent
  await expect(page.getByText("NASA Earth Observatory, Blue Marble: Next Generation")).toBeVisible();
  await expect(page.getByRole("link", { name: "usage terms" })).toHaveAttribute(
    "href",
    "https://www.nasa.gov/nasa-brand-center/images-and-media/",
  );
  await expect(page.locator('img[src*="ion-credit"]')).toHaveCount(0);

  // Tiles are built here, so no first-run notice
  await expect(page.getByText("No base map built yet")).toBeHidden();

  // The dev-only studio must not ship
  await expect(page.getByRole("button", { name: "Regions" })).toHaveCount(0);
});

test("coastlines file holds real line geometry", async ({ request }) => {
  const geo = await (await request.get("/vectors/coastlines.geojson")).json();
  expect(geo.features.length).toBeGreaterThan(1000);
  expect(geo.features.every((f) => /LineString/.test(f.geometry?.type ?? ""))).toBe(true);
});

test("US states file holds real line geometry", async ({ request }) => {
  const geo = await (await request.get("/vectors/us-states.geojson")).json();
  expect(geo.features.length).toBeGreaterThan(100);
  expect(geo.features.every((f) => /LineString/.test(f.geometry?.type ?? ""))).toBe(true);
});

test("country borders file holds real line geometry", async ({ request }) => {
  const geo = await (await request.get("/vectors/country-borders.geojson")).json();
  expect(geo.features.length).toBeGreaterThan(300);
  const lines = geo.features.filter((f) => /LineString/.test(f.geometry?.type ?? ""));
  expect(lines.length, "features with LineString geometry").toBe(geo.features.length);
  expect(geo.features.some((f) => f.properties.kind === "disputed")).toBe(true);
});

test("fresh clone (no tiles built): falls back to None, explains how to build, no tile 404s", async ({ page }) => {
  await page.route("**/tiles/**", (r) => r.fulfill({ status: 404, body: "not found" }));
  const tileGets = [];
  page.on("request", (r) => {
    if (r.method() === "GET" && /\/tiles\/(blue-marble|blue-marble-webp|grey)\/\d+\//.test(r.url())) tileGets.push(r.url());
  });
  await page.goto("/");

  const notice = page.getByRole("status").filter({ hasText: "No base map built yet" });
  await expect(notice).toBeVisible();
  await page.getByRole("button", { name: "Layers" }).click();
  const pop = page.getByRole("dialog", { name: "Map layers" });
  await expect(pop.getByRole("radio", { name: "None" })).toBeChecked();
  await expect(pop.getByRole("radio", { name: "Blue Marble" })).toBeDisabled();
  await expect(pop.locator(".layers-row", { hasText: "Blue Marble" })).toContainText("npm run fetch:source && npm run build:tiles");
  await expect(pop.getByRole("radio", { name: "Grey" })).toBeDisabled();
  await expect(pop.getByRole("checkbox", { name: "Terrain" })).toBeDisabled();
  await expect(pop.locator(".layers-row", { hasText: "Terrain" })).toContainText("npm run build:terrain");
  await page.keyboard.press("Escape");

  // No NASA credit for imagery that isn't there, and no tile requests beyond the existence checks
  await expect(page.getByText("NASA Earth Observatory, Blue Marble: Next Generation")).toHaveCount(0);
  expect(tileGets).toEqual([]);

  // "How to build it" opens the Guide on the right tab
  await notice.getByRole("button", { name: "How to build it" }).click();
  await expect(page.getByRole("tab", { name: "Build the map data" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Building the map data" })).toBeVisible();
});

test("guide panel shows all three docs", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Guide" }).click();
  await expect(page.getByRole("tab", { name: "Build the map data" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Grey base map" })).toBeVisible();
  await page.getByRole("tab", { name: "Add layers in code" }).click();
  await expect(page.getByRole("heading", { name: "5. A vector layer: GeoJSON lines" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "7. Stay off Cesium ion" })).toBeVisible();
  await page.getByRole("tab", { name: "Serve to other maps" }).click();
  await expect(page.getByRole("heading", { name: "Serving layers to other maps" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "4. Use it from a web map" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".guide-panel")).toBeHidden();
});

test("layers control: base maps, terrain, overlays, regions; choices are remembered", async ({ page, request }) => {
  const res = await request.get("/tiles/landsat/index.json");
  const regions = res.ok() ? (await res.json()).regions : [];
  const greyBuilt = (await request.head("/tiles/grey/tiles.json")).ok();

  await page.goto("/");
  await page.getByRole("button", { name: "Layers" }).click();
  const pop = page.getByRole("dialog", { name: "Map layers" });
  await expect(pop.locator(".layers-section")).toHaveText(["Base map", "Terrain", "Overlays", "Regions"]);
  await expect(pop.getByRole("radio", { name: "Blue Marble" })).toBeChecked();
  await expect(pop.getByRole("radio", { name: "Grey" })).toBeVisible();
  await expect(pop.getByRole("radio", { name: "None" })).toBeVisible();
  await expect(pop.getByLabel("Country borders")).toBeChecked();
  await expect(pop.getByLabel("US states")).toBeChecked();
  await expect(pop.getByLabel("Coastlines")).not.toBeChecked(); // off by default
  // Each built region is listed under Regions (the last list)
  const regionList = pop.locator(".layers-list").last();
  for (const r of regions) await expect(regionList.getByLabel(r.title, { exact: true })).toBeVisible();
  await expect(pop.locator(".layers-row")).toHaveCount(7 + regions.length); // 3 base maps, terrain, 3 overlays

  // Coastlines load only when first switched on
  const coast = page.waitForResponse((r) => r.url().endsWith("/vectors/coastlines.geojson") && r.ok());
  await pop.getByLabel("Coastlines").check();
  await coast;

  // Overlay choices are remembered across a reload
  await pop.getByLabel("US states").uncheck();
  if (greyBuilt) {
    // Switching base map loads that map's tiles, and is remembered too
    const greyTile = page.waitForResponse((r) => /\/tiles\/grey\/\d+\/\d+\/\d+\.png$/.test(r.url()) && r.ok());
    await pop.getByRole("radio", { name: "Grey" }).check();
    await greyTile;
  }
  await page.reload();
  await page.getByRole("button", { name: "Layers" }).click();
  const pop2 = page.getByRole("dialog", { name: "Map layers" });
  await expect(pop2.getByLabel("US states")).not.toBeChecked();
  await expect(pop2.getByLabel("Coastlines")).toBeChecked();
  if (greyBuilt) await expect(pop2.getByRole("radio", { name: "Grey" })).toBeChecked();

  // Clicking elsewhere closes it
  await page.mouse.click(640, 400);
  await expect(pop2).toBeHidden();
});

test("terrain: tiles decode to real heights; toggle and exaggeration are remembered", async ({ page, request }) => {
  test.skip(!existsSync("public/tiles/terrain/tiles.json"), "terrain not built (npm run build:terrain)");
  const { zoom, tiles } = await (await request.get("/tiles/terrain/tiles.json")).json();
  expect(zoom).toEqual([0, 8]);
  const tileAt = (lon, lat, z) => {
    const k = 2 ** z, r = (lat * Math.PI) / 180;
    return [Math.floor(((lon + 180) / 360) * k), Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * k)];
  };
  const has = (z, [x, y]) => tiles[z]?.[x]?.includes(y) ?? false;
  const everest = tileAt(86.925, 27.988, 8);
  expect(has(8, everest), "the tile with Everest exists").toBe(true);
  expect(has(8, tileAt(-140, 0, 8)), "mid-Pacific: all sea, so no tile").toBe(false);

  const terrainGets = [];
  page.on("response", (r) => /\/tiles\/terrain\/\d+\//.test(r.url()) && terrainGets.push(r.status()));
  await page.goto("/");

  // Decode the Everest tile the way src/terrain.js does: its highest point is Everest's summit
  // area, averaged over a ~550 m pixel, so a little under 8,849 m
  const highest = await page.evaluate(async (url) => {
    const blob = await (await fetch(url)).blob();
    const bmp = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    const ctx = new OffscreenCanvas(256, 256).getContext("2d");
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, 256, 256).data;
    let max = -Infinity;
    for (let i = 0; i < d.length; i += 4) max = Math.max(max, d[i] * 256 + d[i + 1] + d[i + 2] / 256 - 32768);
    return max;
  }, `/tiles/terrain/8/${everest[0]}/${everest[1]}.webp`);
  expect(highest).toBeGreaterThan(8000);
  expect(highest).toBeLessThan(8849);

  // On by default at 2x, with NOAA's credit; the globe loads terrain tiles
  await page.getByRole("button", { name: "Layers" }).click();
  const pop = page.getByRole("dialog", { name: "Map layers" });
  const box = pop.getByRole("checkbox", { name: "Terrain" });
  const slider = pop.getByRole("slider", { name: "Terrain exaggeration" });
  await expect(box).toBeChecked();
  await expect(slider).toHaveValue("2");
  await expect(page.getByText("NOAA NCEI, ETOPO 2022")).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => terrainGets.length, { timeout: 30_000 }).toBeGreaterThan(0);
  expect(terrainGets.every((s) => s === 200), `terrain tile statuses: ${terrainGets}`).toBe(true);

  // Change both, reload: remembered; and with terrain off, no NOAA credit
  await slider.fill("3.5");
  await expect(pop.locator(".layers-value")).toHaveText("3.5×");
  await box.uncheck();
  await expect(slider).toBeDisabled();
  await page.reload();
  await page.getByRole("button", { name: "Layers" }).click();
  await expect(box).not.toBeChecked();
  await expect(slider).toHaveValue("3.5");
  await expect(page.getByText("NOAA NCEI, ETOPO 2022")).toHaveCount(0);
  await expect(page.locator(".coords-terrain")).toBeHidden(); // nor the terrain line in the readout
  await expect(page.locator(".coords-alt")).toHaveText(""); // and no altitude
});

test("terrain heights are above sea level, and regional terrain agrees with the global terrain", async ({ page }) => {
  test.skip(!existsSync("public/tiles/terrain/tiles.json"), "terrain not built (npm run build:terrain)");
  await page.goto("/");
  // Height at a point, decoded from a tile the way src/terrain.js does (nearest pixel)
  const heightAt = (root, z, lon, lat, shareInBlue) =>
    page.evaluate(async ({ root, z, lon, lat, shareInBlue }) => {
      const k = 2 ** z, r = (lat * Math.PI) / 180;
      const fx = ((lon + 180) / 360) * k, fy = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * k;
      const res = await fetch(`${root}/${z}/${Math.floor(fx)}/${Math.floor(fy)}.webp`);
      if (!res.ok) return null;
      const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
      const ctx = new OffscreenCanvas(256, 256).getContext("2d");
      ctx.drawImage(bmp, 0, 0);
      const [R, G, B] = ctx.getImageData(Math.floor((fx % 1) * 256), Math.floor((fy % 1) * 256), 1, 1).data;
      return R * 256 + G + (shareInBlue ? 0 : B / 256) - 32768;
    }, { root, z, lon, lat, shareInBlue });
  // Guam International Airport: ~80 m in both ETOPO and 3DEP. Guam is where it shows most: the geoid
  // is ~55 m above the ellipsoid there, so heights converted to the ellipsoid would read ~135 m.
  const global = await heightAt("/tiles/terrain", 8, 144.796, 13.4834, false);
  expect(global, "global terrain at Guam's airport").toBeGreaterThan(60);
  expect(global).toBeLessThan(100);
  if (existsSync("public/tiles/landsat/guam/terrain/tiles.json")) {
    for (const [lon, lat] of [[144.796, 13.4834], [144.93, 13.584], [144.84, 13.52]]) {
      const regional = await heightAt("/tiles/landsat/guam/terrain", 14, lon, lat, true);
      const g = await heightAt("/tiles/terrain", 8, lon, lat, false);
      expect(Math.abs(regional - g), `3DEP ${regional} m vs ETOPO ${g} m at ${lon}, ${lat}`).toBeLessThan(15);
    }
  }
});

test("base map None: no base imagery is requested, overlays still load", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Layers" }).click();
  await page.getByRole("radio", { name: "None" }).check();
  await page.reload(); // start fresh on None, so nothing Blue Marble is already in flight
  const baseTiles = [];
  // GETs only: the HEAD requests are the "is this base map built?" checks, not tile downloads
  page.on("request", (r) => r.method() === "GET" && /\/tiles\/(blue-marble|blue-marble-webp|grey)\/\d+\//.test(r.url()) && baseTiles.push(r.url()));
  const borders = page.waitForResponse((r) => r.url().endsWith("/vectors/country-borders.geojson"));
  await page.reload();
  await borders;
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: "Layers" }).click();
  await expect(page.getByRole("radio", { name: "None" })).toBeChecked();
  expect(baseTiles, "base map tiles requested while None is selected").toEqual([]);
});

test("zooming with the cursor on the exact centre pixel doesn't stop rendering (Cesium bug workaround)", async ({ page }) => {
  await page.goto("/");
  await page.waitForTimeout(2500);
  const { width, height } = page.viewportSize();
  await page.mouse.move(width / 2, height / 2);
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(1500);
  await expect(page.locator(".cesium-widget-errorPanel")).toHaveCount(0);
  await expect(page.locator(".coords")).not.toContainText("NaN");
});

test("data source indicator: the production build reads its own files", async ({ page }) => {
  await page.goto("/");
  const badge = page.locator(".data-source");
  await expect(badge).toHaveText("Data: local");
  await expect(badge).toHaveAttribute("data-state", "local");
});

test("lat/lon/alt readout follows the cursor and falls back to the view centre; terrain source above it", async ({ page }) => {
  await page.goto("/");
  const readout = page.locator(".coords > div").last(); // the position line
  const terrainBuilt = existsSync("public/tiles/terrain/tiles.json");
  // lat, lon, and with terrain (on by default) the altitude there
  // Labelled with what they're measured against: WGS84 (the ellipsoid) and MSL (mean sea level)
  const pattern = terrainBuilt
    ? /^WGS84 {2}\d+\.\d{4}° [NS] {2}\d+\.\d{4}° [EW] +[\d,]+ m MSL$/
    : /^WGS84 {2}\d+\.\d{4}° [NS] {2}\d+\.\d{4}° [EW]$/;
  // On load: the centre of the view
  await expect(readout).toHaveText(pattern);
  await expect(readout).toHaveAttribute("title", "Centre of the view");
  const centre = await readout.textContent();
  // Over the globe, off-centre: the point under the cursor
  await page.mouse.move(560, 300);
  await expect(readout).toHaveAttribute("title", "Under the cursor");
  await expect(readout).toHaveText(pattern);
  await expect(readout).not.toHaveText(centre);
  await expect(page.locator(".coords-datum")).toHaveAttribute("title", /WGS84 ellipsoid/);
  await expect(page.locator(".coords-alt")).toHaveAttribute("title", /mean sea level/);
  // With terrain: where the altitude comes from and its detail, on the line above
  if (terrainBuilt) {
    await expect(page.locator(".coords-terrain")).toHaveText(/^NOAA ETOPO 2022 · (sea level|≈[\d,]+ m detail)$/);
  }
  // Off the globe (out in space): back to the centre
  await page.mouse.move(40, 400);
  await expect(readout).toHaveAttribute("title", "Centre of the view");
});

test("production build ships Cesium's licence and drops the moon texture", async ({ request }) => {
  expect((await request.get("/cesium/LICENSE.md")).status()).toBe(200);
  // vite preview answers missing files with index.html (200), so check what came back
  const moon = await request.get("/cesium/Assets/Textures/moonSmall.jpg");
  expect(moon.headers()["content-type"]).not.toContain("image/");
  // Blue Marble's record ships with its tiles: WebP (the default), or JPEG
  const webp = existsSync("public/tiles/blue-marble-webp/PROVENANCE.json");
  const prov = await request.get(webp ? "/tiles/blue-marble-webp/PROVENANCE.json" : "/tiles/blue-marble/PROVENANCE.json");
  expect(prov.status()).toBe(200);
  const build = (await prov.json()).build;
  expect((webp ? build.output_webp : build.output).tile_count).toBeGreaterThan(80_000);
});
