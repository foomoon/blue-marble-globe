# Adding a map layer from your own tiles

A Cesium map layer has two parts:

- an **imagery provider**, which says where the tiles are and how they're laid out
- an **imagery layer**, which puts that provider on the globe

The whole working app is [`src/main.js`](../src/main.js).

## 1. Put the tiles where the browser can reach them

Vite serves everything in `public/` from the site root, so

```
public/tiles/blue-marble/3/4/2.jpg   →   /tiles/blue-marble/3/4/2.jpg
```

`npm run build:tiles` writes them there.

## 2. Describe the tiles with a provider

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
| `maximumLevel` | The highest zoom built (8). Past it, Cesium enlarges level-8 tiles instead of requesting tiles that don't exist. |
| `credit`       | NASA asks to be credited. Cesium shows this in the credit bar. A plain string works; `main.js` passes a `Cesium.Credit` with HTML instead, so the credit links to the dataset page and NASA's usage terms. |

## 3. Put the layer on the globe

**As the base map when you create the viewer.** This is the usual case. It also stops Cesium from loading its default ion imagery, which needs an account and an access token.

```js
const viewer = new Cesium.Viewer("globe", {
  baseLayer: new Cesium.ImageryLayer(blueMarble),
  geocoder: false,        // the geocoder also calls Cesium ion
  baseLayerPicker: false, // the picker lists ion and Bing layers
});
```

**On a viewer that already exists**, for example to stack a layer on top or to switch between maps:

```js
const layer = viewer.imageryLayers.addImageryProvider(blueMarble);
layer.alpha = 0.8; // optional: blend with the layers beneath it
```

Layers draw in order: index 0 is at the bottom. Use `viewer.imageryLayers.remove(layer)` to take a layer off, and `raiseToTop` / `lowerToBottom` to reorder layers.

## 4. Stay off Cesium ion

Cesium is built to work with Cesium ion, its hosted data service. This app uses none of it. Two lines at the top of `main.js`, before the viewer is created, make that explicit:

```js
Cesium.CreditDisplay.cesiumCredit = undefined; // remove the ion logo Cesium adds by default
Cesium.Ion.defaultAccessToken = "";            // any accidental ion request now fails
```

Together with `baseLayer` (no default ion imagery), `geocoder: false` and `baseLayerPicker: false`, every request the app makes goes to its own server. Check the browser's Network tab to see this for yourself.

## 5. Optional polish

```js
// Web Mercator stops at about ±85° latitude; colour the uncovered poles
viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString("#0b1a2e");
```

Don't hide the credit bar (`creditContainer`). It's where the NASA credit appears.

## Troubleshooting

- **The globe is blue or blank.** Open the browser's Network tab. If tile requests return 404, the `url` doesn't match the folder layout on disk.
- **The tiles are offset vertically or flipped.** The tiles are in TMS order (y counts from the bottom). Use `{reverseY}` in place of `{y}`, or rebuild them with `--xyz`.
- **Imagery goes blurry when you zoom in.** That's expected past `maximumLevel`. Build more zoom levels to get more detail.
