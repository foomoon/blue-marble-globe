// The dev-only Regions studio: draw a rectangle, see the estimate, save the config.
import { existsSync, readFileSync, rmSync } from "node:fs";
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

test("studio API refuses other origins", async ({ request }) => {
  const res = await request.delete(`/api/regions/${NAME}`, { headers: { Origin: "https://example.com" } });
  expect(res.status()).toBe(403);
});
