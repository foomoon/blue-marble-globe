# Adding layers in code

Cesium has two kinds of layer, and this project uses both:

- **Imagery layers** are tiles draped over the globe: Blue Marble, Grey and the Landsat regions. Each one is an **imagery provider** (where the tiles are, how they're laid out) wrapped in an **imagery layer** (puts it on the globe).
- **Vector layers** are lines drawn on top: borders, states and coastlines. Each one is a GeoJSON file loaded as a **data source** of entities.

The viewer setup is in [`src/main.js`](../src/main.js). Base maps, overlays and regions are in [`src/layers.js`](../src/layers.js).

## 1. Put the files where the browser can reach them

Vite serves everything in `public/` from the site root:

```
public/tiles/blue-marble/3/4/2.jpg      →   /tiles/blue-marble/3/4/2.jpg
public/vectors/country-borders.geojson  →   /vectors/country-borders.geojson
```

*Build the map data* covers the commands that write them there.

## 2. An imagery layer: describe the tiles with a provider

```js
import * as Cesium from "cesium";

const blueMarble = new Cesium.UrlTemplateImageryProvider({
  url: "/tiles/blue-marble/{z}/{x}/{y}.jpg",
  tilingScheme: new Cesium.WebMercatorTilingScheme(),
  maximumLevel: 8,
  credit: "Imagery: NASA Earth Observatory, Blue Marble: Next Generation",
});
```

Each option has to match how the tiles were built:

| Option         | Why |
| -------------- | --- |
| `url`          | Cesium fills in `{z}` (zoom), `{x}` (column) and `{y}` (row). The folder and file extension must match what's on disk. |
| `tilingScheme` | The tiles are Web Mercator (EPSG:3857) in XYZ order (`gdal2tiles --xyz`), so use `WebMercatorTilingScheme`. With the wrong scheme, the map is stretched or tiles land in the wrong place. |
| `maximumLevel` | The highest zoom built. Past it, Cesium enlarges the top-level tiles instead of requesting tiles that don't exist. |
| `credit`       | Shown in the credit bar. A plain string works; `main.js` passes a `Cesium.Credit` with HTML instead, so the credit links to NASA's dataset page and usage terms. |

## 3. Put the imagery layer on the globe

**As the base map when you create the viewer.** This also stops Cesium from loading its default ion imagery, which needs an account and an access token.

```js
const viewer = new Cesium.Viewer("globe", {
  baseLayer: new Cesium.ImageryLayer(blueMarble),
  geocoder: false,        // the geocoder also calls Cesium ion
  baseLayerPicker: false, // the picker lists ion and Bing layers
});
```

**On a viewer that already exists**, to stack a layer on top or switch between maps:

```js
const layer = new Cesium.ImageryLayer(provider);
viewer.imageryLayers.add(layer);   // add() returns nothing: keep your own reference
layer.show = false;                // switch it off
layer.alpha = 0.8;                 // blend with the layers beneath
```

Layers draw in order, with index 0 at the bottom; `add(layer, 1)` inserts just above the base map. `viewer.imageryLayers.addImageryProvider(provider)` is a shortcut that does return the layer. Mixing the two up is an easy way to lose your handle on a layer, which this project did once.

## 4. A land-only base map (how Grey works)

Grey's tiles contain only land; water is transparent. The ocean is the globe's own colour, showing through:

```js
viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString("#3b3f45"); // the "ocean"
const grey = new Cesium.ImageryLayer(
  new Cesium.UrlTemplateImageryProvider({
    url: "/tiles/grey/{z}/{x}/{y}.png",
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
    maximumLevel: 9,
  }),
);
viewer.imageryLayers.add(grey, 1);
viewer.imageryLayers.get(0).show = false; // hide Blue Marble
```

All-water tiles were never written, so requesting them would only produce 404 errors. `src/layers.js` reads the build's `tiles.json` (the list of tiles that exist) and hands Cesium a shared blank tile for anything not on it. The Landsat regions work the same way.

**"None"** is the same idea with no tiles at all: hide every base layer and set `baseColor`.

## 5. A vector layer: GeoJSON lines

```js
const borders = await Cesium.GeoJsonDataSource.load("/vectors/country-borders.geojson");
const white = new Cesium.ColorMaterialProperty(Cesium.Color.WHITE.withAlpha(0.75));
for (const entity of borders.entities.values) {
  if (!entity.polyline) continue;
  entity.polyline.width = 1.25;
  entity.polyline.material = white;                 // one material shared by every line
  entity.polyline.arcType = Cesium.ArcType.GEODESIC; // follow the globe's curve
}
await viewer.dataSources.add(borders);
borders.show = false; // switch it off
```

- **Draw order:** data sources added later draw on top. `src/layers.js` adds them bottom to top (coastlines, then states, then country borders) and uses `viewer.dataSources.raiseToTop()` when one is switched on later.
- **Per-feature styling:** each entity carries its GeoJSON properties. The disputed borders are dashed based on `entity.properties.kind`:

  ```js
  new Cesium.PolylineDashMaterialProperty({ color: Cesium.Color.WHITE, dashLength: 10 });
  ```

- **Changing colours later**, for example white on Blue Marble and dark grey on Grey: change the shared material's colour (`white.color = …`). Don't assign a new material to every line: Cesium then rebuilds all of their geometry, and they vanish for seconds.

## 6. Stay off Cesium ion

Cesium is built to work with Cesium ion, its hosted data service. This app uses none of it. Two lines at the top of `main.js`, before the viewer is created, make that explicit:

```js
Cesium.CreditDisplay.cesiumCredit = undefined; // remove the ion logo Cesium adds by default
Cesium.Ion.defaultAccessToken = "";            // any accidental ion request now fails
```

Together with `baseLayer` (no default ion imagery), `geocoder: false` and `baseLayerPicker: false`, every request the app makes goes to its own server; `npm test` checks this.

## 7. Two Cesium pitfalls this project works around

- **Don't toggle `globe.showGroundAtmosphere` at runtime.** It recompiles the globe's shaders, and vector lines disappear for several seconds. To hide the blue haze (Grey and None do), push its distance range out of reach instead:

  ```js
  globe.lightingFadeInDistance = globe.lightingFadeOutDistance = Number.MAX_VALUE;
  ```

- **Mouse-wheel zoom with the cursor on the exact centre pixel** can stop rendering (Cesium 1.147). `main.js` patches `Camera.prototype.rotate` to skip a rotation about a zero-length axis, which is a no-op anyway.

Also: don't hide the credit bar (`creditContainer`). NASA's and USGS's credits appear there.

## Troubleshooting

- **The globe is blank or one colour.** Open the browser's Network tab. If tile requests return 404, the `url` doesn't match the folder layout on disk.
- **Tiles are offset vertically or flipped.** They're in TMS order (y counts from the bottom). Use `{reverseY}` in place of `{y}`, or rebuild with `--xyz`.
- **Imagery goes blurry when you zoom in.** That's expected past `maximumLevel`. Build more zoom levels for more detail.
- **A GeoJSON layer loads but draws nothing.** Check that its features have geometry: `"geometry": null` loads without error and draws nothing. `fetch_vectors.py` refuses to write such a file for exactly this reason.
