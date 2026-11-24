// A clean globe on self-hosted NASA Blue Marble tiles.
// docs/adding-a-map-layer.md walks through each step.
// LICENSING.md explains why these tiles need no licence.
import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { mountGuide } from "./guide.js";
import { mountLayers } from "./layers.js";
import { dataUrl, exists, reportingTiles, servedByMapServer } from "./data.js";
import { mountDataSource } from "./datasource.js";
import { mountCoords } from "./coords.js";

// 0. No Cesium ion. Cesium puts an ion logo in the credit bar by default, even when
//    nothing uses ion; remove it. Also blank the built-in demo token, so an
//    accidental ion request fails loudly instead of quietly working.
Cesium.CreditDisplay.cesiumCredit = undefined;
Cesium.Ion.defaultAccessToken = "";

// The credit NASA asks for, linking to the dataset and to NASA's usage terms
// (archived in provenance/terms/). Links only: nothing is fetched from NASA.
const nasaCredit = new Cesium.Credit(
  'Imagery: <a href="https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/" target="_blank" rel="noopener">NASA Earth Observatory, Blue Marble: Next Generation</a>' +
    ' · <a href="https://www.nasa.gov/nasa-brand-center/images-and-media/" target="_blank" rel="noopener">usage terms</a>',
  true, // show on screen, not only in the "Data attribution" list
);

// Work around a Cesium bug (1.147): mouse-wheel zoom with the cursor on the exact centre pixel
// asks the camera to rotate about a zero-length axis, which throws and stops rendering for good.
// Rotating about no axis is a no-op, so skip it.
const cameraRotate = Cesium.Camera.prototype.rotate;
Cesium.Camera.prototype.rotate = function (axis, angle) {
  if (Cesium.Cartesian3.magnitudeSquared(axis) < 1e-20) return;
  return cameraRotate.call(this, axis, angle);
};

// "Data: local" or "Data: map server", top right. First, before anything waits on the server.
mountDataSource();

// 1. Describe where the tiles live and how they were cut. Blue Marble is built as JPEG and,
//    optionally, WebP (smaller): use WebP when it's there (npm run build:tiles -- --format webp).
const BLUE_MARBLE = {
  webp: { url: "/tiles/blue-marble-webp/{z}/{x}/{y}.webp", probe: "/tiles/blue-marble-webp/0/0/0.webp" },
  jpeg: { url: "/tiles/blue-marble/{z}/{x}/{y}.jpg", probe: "/tiles/blue-marble/0/0/0.jpg" },
};
const blueMarbleFormat = (await exists(BLUE_MARBLE.webp.probe)) ? "webp" : "jpeg";
const blueMarble = reportingTiles(new Cesium.UrlTemplateImageryProvider({
  url: dataUrl(BLUE_MARBLE[blueMarbleFormat].url), // public/tiles/blue-marble(-webp)/, or a map server's
  tilingScheme: new Cesium.WebMercatorTilingScheme(), // gdal2tiles --xyz, EPSG:3857
  maximumLevel: 8, // highest zoom built by scripts/build_tiles.py
  credit: nasaCredit,
}));

// 2. Create the viewer with that layer as the base map, and no UI chrome.
const baseLayer = new Cesium.ImageryLayer(blueMarble);
const viewer = new Cesium.Viewer("globe", {
  baseLayer,
  animation: false,
  baseLayerPicker: false,
  fullscreenButton: false,
  geocoder: false, // the geocoder would call Cesium ion
  homeButton: false,
  infoBox: false,
  navigationHelpButton: false,
  sceneModePicker: false,
  selectionIndicator: false,
  timeline: false,
});

// 3. Optional polish: Mercator tiles stop at about ±85°, so tint the poles ocean blue.
viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString("#0b1a2e");

// 4. Don't draw Cesium's moon: its bundled texture has no clear public-domain source
//    (see LICENSING.md). The build also leaves that file out.
viewer.scene.moon.show = false;

mountGuide();

// Lat/lon readout, bottom right (with the terrain under the cursor, once Layers is up)
const coords = mountCoords(viewer);

// Vector layers (country borders) are entities; Cesium's default double-click would lock the
// camera onto whichever one is under the cursor, so switch that off.
viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

// 5. Layers control: Blue Marble plus any built Landsat regions (public/tiles/landsat/index.json)
const layers = mountLayers(viewer, baseLayer, { blueMarbleProbe: BLUE_MARBLE[blueMarbleFormat].probe });
coords.setTerrain(layers.terrainAt);

// 6. Dev and the map server's admin page (/admin/) only: the Regions studio (draw, estimate, save
//    and build regions). Vite removes this branch from other builds, so the public globe never has it.
if (import.meta.env.DEV || import.meta.env.VITE_ADMIN === "1") {
  Object.assign(window, { viewer, Cesium }); // handy in the browser console while developing
  import("./studio/studio.js").then(({ mountStudio }) => mountStudio(viewer, layers));
}
// The public globe the map server serves (/globe/): where the Regions button would be, a link to
// the admin page, where regions are added (it asks you to sign in). Only when this server has one:
// a serve-only server (MAPSERVER_ADMIN=off, e.g. on an air-gapped network) has no sign-in page.
else if (servedByMapServer) {
  fetch("../login/", { method: "HEAD" }).then((res) => {
    if (!res.ok) return;
    const admin = Object.assign(document.createElement("a"), { className: "admin-link", href: "../admin/", textContent: "Admin" });
    admin.title = "Add and build high-resolution regions (sign-in required)";
    document.body.append(admin);
  }, () => {});
}
