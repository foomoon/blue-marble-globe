// The dev-only Regions studio: draw a rectangle, see the estimate, save the config.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { expect, test } from "@playwright/test";

const NAME = "playwright-test";
const FILE = `regions/${NAME}.json`;

test.afterEach(() => rmSync(FILE, { force: true }));

test("draw a region, see its estimate, save and delete it", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Regions" }).click();
  await page.getByRole("button", { name: "New region" }).click();

  // Drag a rectangle across the middle of the globe
  const box = await page.locator(".cesium-widget canvas").boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx - 60, cy - 40);
  await page.mouse.down();
  await page.mouse.move(cx + 60, cy + 40, { steps: 8 });
  await page.mouse.up();

  const total = page.locator(".studio-estimate .total");
  await expect(total).toContainText("tiles ≈");
  await expect(page.locator(".studio-bbox")).toContainText("km²");

  await page.getByLabel("Name").fill(NAME);
  await page.getByLabel("Title").fill("Playwright test");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".studio-status")).toHaveText(`Saved ${FILE}`);

  const saved = JSON.parse(readFileSync(FILE, "utf8"));
  expect(saved.name).toBe(NAME);
  expect(saved.bbox[0]).toBeLessThan(saved.bbox[2]);
  expect(saved.months).toEqual([6, 7, 8, 9]);
  // the highlighted month buttons must match the config (J J A S = June–September)
  await expect(page.locator(".studio-month.on")).toHaveCount(4);
  expect(await page.locator(".studio-month.on").evaluateAll((bs) => bs.map((b) => b.title))).toEqual([
    "June", "July", "August", "September",
  ]);

  // Starting another new region must not reuse this one's name (it would overwrite it)
  await expect(page.locator(".studio-mode")).toHaveText("Editing Playwright test");
  await page.getByRole("button", { name: "New region" }).click();
  await page.mouse.move(cx - 30, cy - 20);
  await page.mouse.down();
  await page.mouse.move(cx + 30, cy + 20, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator(".studio-mode")).toHaveText("New region");
  await expect(page.getByLabel("Name")).toHaveValue("");
  await page.getByLabel("Name").fill(NAME);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".studio-status")).toContainText("already a saved region");

  const item = page.locator(".studio-item", { hasText: "Playwright test" });
  await expect(item).toBeVisible();

  // Clicking a saved region only flies to it; Edit is what opens its settings
  await page.getByRole("button", { name: "Close the form without saving" }).click();
  await expect(page.locator(".studio-form")).toBeHidden();
  await item.locator(".studio-open").click();
  await expect(page.locator(".studio-form")).toBeHidden();
  await item.getByRole("button", { name: "Edit" }).click();
  await expect(page.locator(".studio-mode")).toHaveText("Editing Playwright test");
  await item.getByRole("button", { name: "Delete" }).click();
  await item.getByRole("button", { name: "Confirm" }).click();
  await expect(item).toHaveCount(0);
  expect(existsSync(FILE)).toBe(false);
});

test("draw a polygon by clicking corners, then save it", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Regions" }).click();
  await page.getByRole("button", { name: "Polygon" }).click();
  await page.getByRole("button", { name: "New region" }).click();

  const box = await page.locator(".cesium-widget canvas").boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  for (const [dx, dy] of [[-60, -40], [60, -50], [70, 40]]) await page.mouse.click(cx + dx, cy + dy);
  await page.mouse.dblclick(cx - 50, cy + 45); // fourth corner, and finish

  await expect(page.locator(".studio-bbox")).toContainText("Polygon · 4 corners");
  await expect(page.locator(".studio-estimate .total")).toContainText("tiles ≈");
  await page.getByLabel("Name").fill(NAME);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".studio-status")).toHaveText(`Saved ${FILE}`);

  const saved = JSON.parse(readFileSync(FILE, "utf8"));
  expect(saved.boundary).toHaveLength(4);
  const lons = saved.boundary.map((p) => p[0]);
  expect(saved.bbox[0]).toBeCloseTo(Math.min(...lons), 4); // bbox derived from the polygon
  expect(saved.bbox[2]).toBeCloseTo(Math.max(...lons), 4);
});

test("switching a built region off in Layers really hides its layer", async ({ page, request }) => {
  const res = await request.get("/tiles/landsat/index.json");
  const regions = res.ok() ? (await res.json()).regions : [];
  test.skip(!regions.length, "no built regions on this machine");
  const r = regions[0];

  await page.goto("/");
  await page.getByRole("button", { name: "Layers" }).click();
  const box = page.getByRole("dialog", { name: "Map layers" }).getByLabel(r.title, { exact: true });
  const shown = () =>
    page.evaluate((name) => {
      const L = window.viewer.imageryLayers;
      for (let i = 0; i < L.length; i++) {
        const l = L.get(i);
        if (String(l.imageryProvider.url).includes(`/tiles/landsat/${name}/`)) return l.show;
      }
      return null;
    }, r.name);
  await box.check();
  await expect.poll(shown).toBe(true);
  await box.uncheck();
  await expect.poll(shown).toBe(false);
  await box.check(); // leave it as found
});

test("studio API refuses other origins", async ({ request }) => {
  const res = await request.delete(`/api/regions/${NAME}`, { headers: { Origin: "https://example.com" } });
  expect(res.status()).toBe(403);
});

test("tiles written after the dev server started are served (a region just built)", async ({ request }) => {
  // The dev server doesn't watch public/tiles (too many files); vite.config.js serves them from disk
  const dir = "public/tiles/landsat/_new-tile-probe/9/1/2.webp";
  mkdirSync("public/tiles/landsat/_new-tile-probe/9/1", { recursive: true });
  try {
    copyFileSync("mapserver/sea-level.webp", dir);
    const res = await request.get(`/tiles/landsat/_new-tile-probe/9/1/2.webp?b=x`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("image/webp");
    expect((await request.get("/tiles/landsat/_new-tile-probe/9/1/3.webp")).status()).toBe(404);
  } finally {
    rmSync("public/tiles/landsat/_new-tile-probe", { recursive: true, force: true });
  }
});

test("export a built region as a region pack, and it imports into a release", async ({ page, request }, info) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Regions" }).click();
  const box = page.locator(".studio-export");
  await expect(box).toBeVisible();
  await box.locator("summary").click();
  const btn = page.locator(".studio-exportbtn");
  await expect(btn).toHaveText("Choose regions");
  await box.getByLabel("Mount Everest").check();
  await expect(btn).toHaveText(/Download 1 region · ≈ [\d.]+ MB/); // imagery + terrain
  await expect(btn).toHaveAttribute("href", "/api/export?regions=everest");

  const [download] = await Promise.all([page.waitForEvent("download"), btn.click()]);
  expect(download.suggestedFilename()).toMatch(/^regions-everest-\d{8}-\d{6}\.tar$/);
  const pack = info.outputPath("everest.tar");
  await download.saveAs(pack);
  // A tar whose first file is the manifest
  expect(readFileSync(pack).subarray(0, 100).toString()).toMatch(/region-pack\.json|PaxHeader/);

  // Round trip: import it into an empty stand-in release
  const release = info.outputPath("release");
  for (const d of ["tiles", "www", "provenance"]) mkdirSync(`${release}/${d}`, { recursive: true });
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync("python3", ["-I", "scripts/region_pack.py", "import", pack, "--release", release], { encoding: "utf8" });
  expect(r.stderr).toBe("");
  expect(r.stdout).toContain("added: everest");
  const index = JSON.parse(readFileSync(`${release}/tiles/landsat/index.json`, "utf8"));
  expect(index.regions.map((x) => x.name)).toEqual(["everest"]);
  expect(existsSync(`${release}/www/tilejson/landsat/everest.json`)).toBe(true);

  // Only built regions, only good names
  expect((await request.get("/api/export?regions=not-built-here")).status()).toBe(404);
  expect((await request.get("/api/export?regions=../etc")).status()).toBe(400);
});
