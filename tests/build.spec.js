// End-to-end: build a small Landsat region through the Regions panel and watch the
// progress UI. Uses the real Landsat catalogue over the internet and takes about a
// minute, so it's opt-in:  npm run test:build
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { expect, test } from "@playwright/test";

const NAME = "e2e-boulder";
test.skip(!process.env.BUILD_TEST, "set BUILD_TEST=1 (npm run test:build) to run the networked build test");

const cleanup = () => {
  for (const p of [`regions/${NAME}.json`, `provenance/regions/${NAME}.json`, `public/tiles/landsat/${NAME}`]) {
    rmSync(p, { recursive: true, force: true });
  }
  execFileSync(".venv/bin/python", ["scripts/build_region.py", "--index"]); // drop it from the layer list too
};
test.beforeAll(cleanup);
test.afterAll(cleanup);

test("build a region from the panel with live progress", async ({ page, request }, info) => {
  test.setTimeout(6 * 60_000);
  const put = await request.put(`/api/regions/${NAME}`, {
    data: {
      title: "Boulder (e2e)",
      bbox: [-105.35, 39.95, -105.15, 40.1],
      boundary: [[-105.35, 39.95], [-105.15, 39.95], [-105.35, 40.1]], // a triangle: exercises masking
      dates: ["2023-06-01", "2024-09-30"],
      months: [6, 7, 8, 9],
      max_cloud_percent: 20,
      scenes_per_location: 3,
      zoom: [9, 12],
    },
  });
  expect(put.ok()).toBe(true);

  await page.goto("/");
  await page.getByRole("button", { name: "Regions" }).click();
  const item = page.locator(".studio-item", { hasText: "Boulder (e2e)" });
  await item.locator(".studio-open").click(); // fly there first, so the globe visuals are in view
  await page.waitForTimeout(1500);
  await item.getByRole("button", { name: "Build" }).click();

  const card = page.locator(".studio-job");
  await expect(card).toBeVisible();
  await expect(card.locator(".job-state")).toHaveText("● building");

  // Snapshot the progress UI as it moves through the stages
  const seen = new Set();
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const state = await card.getAttribute("data-state");
    const running = await card.locator('.job-stages li[data-status="running"] .name').allTextContents();
    const key = state === "running" ? running[0] : state;
    if (key && !seen.has(key)) {
      seen.add(key);
      await info.attach(`progress-${seen.size}-${key}.png`, { body: await page.screenshot(), contentType: "image/png" });
    }
    if (state !== "running") break;
    await page.waitForTimeout(400);
  }

  await expect(card.locator(".job-state")).toHaveText("✓ done");
  await expect(card.locator(".job-message")).toContainText("tiles");
  // By exact stage name: "Tile" would also match the Terrain row's "89 tiles"
  const stageRow = (name) => card.locator(".job-stages li").filter({ has: page.locator(".name", { hasText: new RegExp(`^${name}$`) }) });
  for (const stage of ["Search", "Download", "Composite", "Tile", "Terrain"]) {
    await expect(stageRow(stage)).toHaveAttribute("data-status", "done");
  }
  expect(existsSync(`provenance/regions/${NAME}.json`)).toBe(true);
  expect(existsSync(`public/tiles/landsat/${NAME}/12`)).toBe(true);
  expect(existsSync(`public/tiles/landsat/${NAME}/tiles.json`)).toBe(true);
  // Boulder is in the US: 10 m terrain from USGS 3DEP
  await expect(stageRow("Terrain")).toContainText("USGS 3DEP, 10 m");
  expect(existsSync(`public/tiles/landsat/${NAME}/terrain/tiles.json`)).toBe(true);
  // With the map server set up, the build lists the new region on it by itself
  if (existsSync("mapserver/www/catalog.json")) {
    const ids = JSON.parse(readFileSync("mapserver/www/catalog.json", "utf8")).layers.map((l) => l.id);
    expect(ids).toEqual(expect.arrayContaining([`landsat/${NAME}`, `landsat/${NAME}/terrain`]));
  }
  await expect(item).toContainText("built");

  // The finished layer on the globe
  await item.locator(".studio-open").click();
  await page.waitForTimeout(4000);
  await info.attach("result.png", { body: await page.screenshot(), contentType: "image/png" });
});
