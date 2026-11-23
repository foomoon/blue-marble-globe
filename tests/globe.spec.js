// Checks on the production build: the evidence behind LICENSING.md's
// "no online services" and attribution claims.
import { existsSync } from "node:fs";
import { expect, test } from "@playwright/test";

test.beforeAll(() => {
  expect(
    existsSync("public/tiles/blue-marble/0/0/0.jpg"),
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
    if (/\/tiles\/blue-marble\/\d+\/\d+\/\d+\.jpg$/.test(res.url())) {
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
    if (r.method() === "GET" && /\/tiles\/(blue-marble|grey)\/\d+\//.test(r.url())) tileGets.push(r.url());
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
  await expect(page.getByRole("heading", { name: "6. Stay off Cesium ion" })).toBeVisible();
  await page.getByRole("tab", { name: "Serve to other maps" }).click();
  await expect(page.getByRole("heading", { name: "Serving layers to other maps" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "4. Use it from a web map" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".guide-panel")).toBeHidden();
});

test("layers control: base maps, overlays, regions; choices are remembered", async ({ page, request }) => {
  const res = await request.get("/tiles/landsat/index.json");
  const regions = res.ok() ? (await res.json()).regions : [];
  const greyBuilt = (await request.head("/tiles/grey/tiles.json")).ok();

  await page.goto("/");
  await page.getByRole("button", { name: "Layers" }).click();
  const pop = page.getByRole("dialog", { name: "Map layers" });
  await expect(pop.locator(".layers-section")).toHaveText(["Base map", "Overlays", "Regions"]);
  await expect(pop.getByRole("radio", { name: "Blue Marble" })).toBeChecked();
  await expect(pop.getByRole("radio", { name: "Grey" })).toBeVisible();
  await expect(pop.getByRole("radio", { name: "None" })).toBeVisible();
  await expect(pop.getByLabel("Country borders")).toBeChecked();
  await expect(pop.getByLabel("US states")).toBeChecked();
  await expect(pop.getByLabel("Coastlines")).not.toBeChecked(); // off by default
  // Each built region is listed under Regions (the last list)
  const regionList = pop.locator(".layers-list").last();
  for (const r of regions) await expect(regionList.getByLabel(r.title, { exact: true })).toBeVisible();
  await expect(pop.locator(".layers-row")).toHaveCount(6 + regions.length);

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

test("base map None: no base imagery is requested, overlays still load", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Layers" }).click();
  await page.getByRole("radio", { name: "None" }).check();
  await page.reload(); // start fresh on None, so nothing Blue Marble is already in flight
  const baseTiles = [];
  // GETs only: the HEAD requests are the "is this base map built?" checks, not tile downloads
  page.on("request", (r) => r.method() === "GET" && /\/tiles\/(blue-marble|grey)\/\d+\//.test(r.url()) && baseTiles.push(r.url()));
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

test("lat/lon readout follows the cursor and falls back to the view centre", async ({ page }) => {
  await page.goto("/");
  const readout = page.locator(".coords");
  const pattern = /^\d+\.\d{4}° [NS] {2}\d+\.\d{4}° [EW]$/;
  // On load: the centre of the view
  await expect(readout).toHaveText(pattern);
  await expect(readout).toHaveAttribute("title", "Centre of the view");
  const centre = await readout.textContent();
  // Over the globe, off-centre: the point under the cursor
  await page.mouse.move(560, 300);
  await expect(readout).toHaveAttribute("title", "Under the cursor");
  await expect(readout).toHaveText(pattern);
  await expect(readout).not.toHaveText(centre);
  // Off the globe (out in space): back to the centre
  await page.mouse.move(40, 400);
  await expect(readout).toHaveAttribute("title", "Centre of the view");
});

test("production build ships Cesium's licence and drops the moon texture", async ({ request }) => {
  expect((await request.get("/cesium/LICENSE.md")).status()).toBe(200);
  // vite preview answers missing files with index.html (200), so check what came back
  const moon = await request.get("/cesium/Assets/Textures/moonSmall.jpg");
  expect(moon.headers()["content-type"]).not.toContain("image/");
  const prov = await request.get("/tiles/blue-marble/PROVENANCE.json");
  expect(prov.status()).toBe(200);
  expect((await prov.json()).build.output.tile_count).toBeGreaterThan(80_000);
});
