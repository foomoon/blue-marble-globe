// Regenerates the README screenshots in docs/images/.
//
//   npm run dev            (in another terminal; the Regions shot needs the dev server)
//   npm run server:up      (for the map server shot; skipped if it isn't running)
//   npm run screenshots
//
// Needs the Blue Marble and Grey tiles built, and the Guam region for its shots.
import { mkdirSync } from "node:fs";
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

// 1. Blue Marble with borders and states
let page = await app({ base: "blue-marble", ...lines }, [-98, 36, 11_000_000]);
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

await browser.close();
