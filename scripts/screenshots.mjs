// Regenerates the README screenshots in docs/images/.
//
//   npm run dev            (in another terminal; the Regions shot needs the dev server)
//   npm run server:up      (for the map server shot; skipped if it isn't running)
//   npm run screenshots
//   npm run screenshots -- --regions    also walk through creating a region: draws, saves and
//                                       really builds a small demo region (needs the internet,
//                                       ~2 min), then deletes it again
//   npm run screenshots -- --regions-only   just the region walkthrough
//
// Needs the Blue Marble, Grey and terrain tiles built, and the Guam region for its shots.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "@playwright/test";

const APP = process.env.APP_URL ?? "http://localhost:5173";
const SERVER = process.env.MAPSERVER_URL ?? "http://localhost:8080";
const OUT = "docs/images";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });

/** Open the app with given layer choices and camera view, the dev Regions button hidden. */
async function app(prefs, view) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript((p) => localStorage.setItem("layers", JSON.stringify(p)), prefs);
  await page.goto(APP);
  await page.addStyleTag({ content: ".studio-toggle { display: none !important; }" });
  await page.waitForFunction(() => window.viewer);
  await page.evaluate(([lon, lat, h, heading = 0, pitch = -90]) => {
    const { Cartesian3, Math: M } = window.Cesium;
    window.viewer.camera.setView({
      destination: Cartesian3.fromDegrees(lon, lat, h),
      orientation: { heading: M.toRadians(heading), pitch: M.toRadians(pitch), roll: 0 },
    });
  }, view);
  await settle(page);
  return page;
}

/** Wait until Cesium has loaded the tiles for this view and built the vector lines. */
async function settle(page) {
  await page.waitForFunction(
    () => {
      const v = window.viewer;
      const lines = [...Array(v.dataSources.length).keys()].map((i) => v.dataSources.get(i));
      return v.scene.globe.tilesLoaded && v.dataSourceDisplay.ready && lines.every((d) => !d.isLoading);
    },
    null,
    { timeout: 60_000 },
  );
  await page.waitForTimeout(1500); // vector lines and the last tiles fade in
}

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.jpg`, type: "jpeg", quality: 82 });
  console.log(`  ${OUT}/${name}.jpg`);
}

const lines = { "country-borders": { on: true }, "us-states": { on: true }, coastlines: { on: false } };

const regionsOnly = process.argv.includes("--regions-only");
let page;
if (!regionsOnly) {
// 1. Blue Marble with borders and states
page = await app({ base: "blue-marble", ...lines }, [-98, 36, 11_000_000]);
await shot(page, "globe-blue-marble");

// 2. The Layers menu
await page.getByRole("button", { name: "Layers" }).click();
await page.waitForTimeout(400);
await shot(page, "layers-menu");
await page.close();

// 3. Grey with coastlines and borders
page = await app({ base: "grey", ...lines, coastlines: { on: true } }, [12, 30, 9_000_000]);
await shot(page, "globe-grey");
await page.close();

// Terrain: the Himalaya on Blue Marble, tilted; and Grey's relief shading from above
page = await app({ base: "blue-marble", ...lines }, [86.5, 26.3, 70_000, 10, -12]);
await shot(page, "terrain-everest");
await page.close();
page = await app({ base: "grey", ...lines }, [84, 31, 2_500_000]);
await shot(page, "terrain-grey");
await page.close();

// 4. The Guide
page = await app({ base: "blue-marble", ...lines }, [10, 20, 16_000_000]);
await page.getByRole("button", { name: "Guide" }).click();
await page.getByRole("tab", { name: "Add layers in code" }).click();
await page.waitForTimeout(400);
await shot(page, "guide");
await page.close();

// 5. A Landsat region (Guam) over Blue Marble, and the dev Regions studio beside it
page = await app({ base: "blue-marble", ...lines }, [144.79, 13.45, 75_000]);
await shot(page, "region-guam");
await page.evaluate(() => document.querySelector(".studio-toggle").style.setProperty("display", "block", "important"));
await page.getByRole("button", { name: "Regions" }).click();
await page.waitForTimeout(800);
await settle(page);
await shot(page, "regions-studio");
await page.close();

// 6. The map server's index page
page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
try {
  await page.goto(SERVER, { timeout: 3000 });
  await page.waitForLoadState("networkidle");
  await shot(page, "map-server");
} catch {
  console.log(`  (map server not running at ${SERVER}: skipped map-server.jpg)`);
}

}
if (regionsOnly || process.argv.includes("--regions")) await regionWalkthrough();

await browser.close();

// ---- Creating a region, step by step ----
async function regionWalkthrough() {
  const NAME = "grand-canyon-demo";
  const cleanup = () => {
    for (const p of [`regions/${NAME}.json`, `provenance/regions/${NAME}.json`, `public/tiles/landsat/${NAME}`]) {
      rmSync(p, { recursive: true, force: true });
    }
    execFileSync(".venv/bin/python", ["scripts/build_region.py", "--index"]); // and from the layer list
  };
  cleanup();
  try {
    const page = await app({ base: "blue-marble", ...lines }, [-112.02, 36.13, 70_000]);
    await page.evaluate(() => document.querySelector(".studio-toggle").style.setProperty("display", "block", "important"));
    await page.getByRole("button", { name: "Regions" }).click();
    const panel = page.locator(".studio-panel");

    // 1. Draw a polygon: click each corner (slowly, so no two clicks make a double-click)
    await panel.getByRole("button", { name: "Polygon" }).click();
    await panel.getByRole("button", { name: "New region" }).click();
    const corners = [[560, 250], [800, 190], [1060, 300], [1100, 520], [880, 640], [600, 560]];
    for (const [x, y] of corners) {
      await page.mouse.click(x, y);
      await page.waitForTimeout(450);
    }
    await page.mouse.move(520, 420); // the rubber-band edge to the cursor
    await page.waitForTimeout(500);
    await shot(page, "region-1-draw");
    await page.keyboard.press("Enter");

    // 2. Settings, with the live tile estimate
    const form = panel.locator(".studio-form");
    await form.getByLabel("Name").fill(NAME);
    await form.getByLabel("Title").fill("Grand Canyon (demo)");
    await form.locator('select[name="z0"]').selectOption("9");
    await page.waitForTimeout(400);
    await form.locator(".studio-estimate").scrollIntoViewIfNeeded();
    await shot(page, "region-2-settings");

    // 3. Save & build, and catch the progress card and the globe mid-build
    await form.getByRole("button", { name: "Save & build" }).click();
    const card = panel.locator(".studio-job");
    await card.waitFor();
    await form.getByRole("button", { name: "Close the form without saving" }).click(); // room for the card
    // Back off so the Landsat scene footprints (185 km across) fit around the region
    await page.evaluate(() => window.viewer.camera.setView({
      destination: window.Cesium.Cartesian3.fromDegrees(-112.02, 36.13, 420_000),
    }));
    let caught = false;
    const deadline = Date.now() + 8 * 60_000;
    while (Date.now() < deadline) {
      const state = await card.getAttribute("data-state");
      if (state && state !== "running") break;
      const stage = await card.locator('.job-stages li[data-status="running"] .name').allTextContents();
      if (!caught && stage[0] === "Composite") {
        await card.scrollIntoViewIfNeeded();
        await shot(page, "region-3-building");
        caught = true;
      }
      await page.waitForTimeout(300);
    }
    if ((await card.getAttribute("data-state")) !== "done") throw new Error("demo build didn't finish");

    await page.close();

    // 4. The finished layer. The app adds it by itself when the build ends; a fresh page just
    //    means the shot can't race that (it fetches the region list, then its tile list).
    const done = await app({ base: "blue-marble", ...lines }, [-112.02, 36.13, 70_000]);
    // The region arrives after the page settles: its layer, then its terrain (which reloads the
    // globe's tiles). The readout names 3DEP once that's in place.
    await done.waitForFunction(() => document.querySelector(".coords-terrain")?.textContent.includes("3DEP"), null, { timeout: 60_000 });
    await settle(done);
    await shot(done, "region-4-done");
    await done.close();
  } finally {
    cleanup();
  }
}
