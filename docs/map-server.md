# Serving layers to other maps

The **map server** shares the layers you've built with any web map: Leaflet, MapLibre, OpenLayers, Cesium, or a desktop GIS such as QGIS. It's a small Docker container that serves standard **XYZ tiles**, **TileJSON** and **GeoJSON**, plus the provenance and licensing to go with them.

## 1. Start it

You need Docker running (on a Mac, open Docker Desktop). Then:

```bash
npm run server:up      # build and start on http://localhost:8080
npm run test:server    # optional: check it end to end
npm run server:down    # stop it
```

Open **http://localhost:8080**. It lists every layer you've built, each with a preview, its attribution, and copy-paste code for Leaflet, MapLibre, OpenLayers and Cesium.

To use a different port: `MAPSERVER_PORT=9000 npm run server:up`.

## 2. After building a layer

```bash
npm run server:build   # refresh the catalog; no restart needed
```

The container reads `public/tiles/` and `public/vectors/` directly (mounted read-only, not copied), so new or rebuilt tiles are served straight away. This command only updates the list of layers and their TileJSON.

## 3. What it serves

| URL | What you get |
| --- | --- |
| `/` | The index page: previews and code for every layer |
| `/catalog.json` | Every layer, machine-readable: id, kind, URLs, zoom range, bounds, attribution, licence, provenance |
| `/tiles/<layer>/tilejson.json` | TileJSON 3.0.0: tile URL, zoom range, bounds and attribution in one file. Most web maps can take this alone. |
| `/tiles/<layer>/{z}/{x}/{y}.<ext>` | The tiles: Web Mercator, XYZ order, 256 px |
| `/vectors/<name>.geojson` | Borders, US states, coastlines, unchanged |
| `/provenance/` | Every build record and archived terms |
| `/licensing`, `/notice` | `LICENSING.md` and `NOTICE` |

Layer ids are `blue-marble`, `grey`, `landsat/<region>` (for example `landsat/guam`), and `country-borders`, `us-states`, `coastlines` for the vectors. Only layers you've built appear.

**Missing tiles answer `204 No Content`, not `404`.** Grey has no ocean tiles and a region has none outside its area; those were skipped on purpose. `204` tells a web map "blank here" without logging an error.

## 4. Use it from a web map

Replace `localhost:8080` with the server's address.

### Pick your layers

A map needs **one base map** underneath, then any overlays on top:

| Layer | Role | URL | Zooms |
| --- | --- | --- | --- |
| Blue Marble | base map | `/tiles/blue-marble/{z}/{x}/{y}.jpg` | 0–8 |
| Grey | base map (transparent water: give the map a dark background) | `/tiles/grey/{z}/{x}/{y}.png` | 0–9 |
| Landsat region | detail overlay for one area | `/tiles/landsat/<region>/{z}/{x}/{y}.webp` | per region, e.g. Guam 8–12 |
| Borders, US states, coastlines | line overlays | `/vectors/<name>.geojson` | any |

**About zoom.** A layer's top zoom is how much detail its source has, not a limit on the map. Blue Marble is 500 m per pixel, and zoom 8 already shows all of it. You can keep zooming in; the library enlarges the zoom-8 tiles, so they just get softer. Tell it the top zoom (`maximumLevel` in Cesium, `maxNativeZoom` in Leaflet; MapLibre and OpenLayers read it from the TileJSON), or it will ask for tiles that don't exist. For sharp imagery closer in, lay a **Landsat region** (30 m, to zoom 12) over the base map. Build one in the Regions panel and it appears on the server.

### Cesium

A complete viewer. Cesium doesn't read TileJSON, so the zoom range and credit go in the code. The credit's `true` shows it on screen rather than only in the credits pop-up.

```js
const SERVER = "http://localhost:8080";
Cesium.Ion.defaultAccessToken = "";          // use nothing from Cesium ion...
Cesium.CreditDisplay.cesiumCredit = undefined; // ...so drop the ion logo too

// 1. The base map: Blue Marble...
const blueMarble = new Cesium.UrlTemplateImageryProvider({
  url: `${SERVER}/tiles/blue-marble/{z}/{x}/{y}.jpg`,
  tilingScheme: new Cesium.WebMercatorTilingScheme(),
  maximumLevel: 8,
  credit: new Cesium.Credit("Imagery: NASA Earth Observatory, Blue Marble: Next Generation", true),
});

// ...or Grey. Its water is transparent, so the globe's own colour is the ocean:
//   url: `${SERVER}/tiles/grey/{z}/{x}/{y}.png`, maximumLevel: 9, credit: "Natural Earth"
//   and after creating the viewer: viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString("#3b3f45");

const viewer = new Cesium.Viewer("globe", {
  baseLayer: new Cesium.ImageryLayer(blueMarble), // without this, Cesium loads ion imagery
  geocoder: false,
  baseLayerPicker: false,
});

// 2. More detail in one area: a Landsat region on top. minimumLevel and rectangle (from the
//    index page) make Cesium ask only for tiles inside the region, at zooms it has.
viewer.imageryLayers.addImageryProvider(new Cesium.UrlTemplateImageryProvider({
  url: `${SERVER}/tiles/landsat/guam/{z}/{x}/{y}.webp`,
  tilingScheme: new Cesium.WebMercatorTilingScheme(),
  minimumLevel: 8,
  maximumLevel: 12,
  rectangle: Cesium.Rectangle.fromDegrees(144.51267, 13.18326, 145.04981, 13.7013),
  credit: new Cesium.Credit("Landsat imagery courtesy of the U.S. Geological Survey", true),
}));

// 3. Vector overlays: each GeoJSON file becomes a data source of lines
const lines = [
  ["coastlines", "#9ec9ff", 1],
  ["us-states", "#ffffff", 1],
  ["country-borders", "#ffffff", 1.5],
];
for (const [name, colour, width] of lines) {
  viewer.dataSources.add(Cesium.GeoJsonDataSource.load(`${SERVER}/vectors/${name}.geojson`, {
    stroke: Cesium.Color.fromCssColorString(colour).withAlpha(0.8),
    strokeWidth: width,
    credit: "Natural Earth",
  }));
}
```

- **Switch a layer off:** `addImageryProvider` returns the layer (`layer.show = false`). `dataSources.add` returns a promise of the data source (`(await promise).show = false`).
- **Order:** imagery layers stack in the order added. Data sources added later draw on top, which is why the list above runs coastlines, states, borders.
- **Vector detail:** the lines are Natural Earth 1:50m, made for country- and continent-scale views. Up close, over a Landsat region, they visibly cut corners.
- **Disputed borders** have `kind: "disputed"` in their properties. *Add layers in code* shows how this app draws them dashed.

### MapLibre

Reads the TileJSON, so the zoom range and attribution come with it:

```js
map.addSource("grey", { type: "raster", url: "http://localhost:8080/tiles/grey/tilejson.json", tileSize: 256 });
map.addLayer({ id: "grey", type: "raster", source: "grey" });

map.addSource("borders", { type: "geojson", data: "http://localhost:8080/vectors/country-borders.geojson" });
map.addLayer({ id: "borders", type: "line", source: "borders", paint: { "line-color": "#555", "line-width": 1 } });
```

### Leaflet

```js
L.tileLayer("http://localhost:8080/tiles/blue-marble/{z}/{x}/{y}.jpg", {
  maxNativeZoom: 8, // enlarge zoom 8 beyond it
  maxZoom: 12,
  attribution: "Imagery: NASA Earth Observatory, Blue Marble: Next Generation",
}).addTo(map);

fetch("http://localhost:8080/vectors/us-states.geojson")
  .then((r) => r.json())
  .then((data) => L.geoJSON(data, { style: { color: "#fff", weight: 1 } }).addTo(map));
```

### OpenLayers

```js
new ol.layer.Tile({
  source: new ol.source.TileJSON({ url: "http://localhost:8080/tiles/grey/tilejson.json" }),
});
new ol.layer.Vector({
  source: new ol.source.Vector({ url: "http://localhost:8080/vectors/coastlines.geojson", format: new ol.format.GeoJSON() }),
});
```

### Others

**QGIS:** *Layer → Add Layer → Add XYZ Layer*, with the tile URL above, and *Add Vector Layer* with a GeoJSON URL.

**Grey has transparent water.** Give the map a dark background for the ocean (Grey's globe uses `#3b3f45`): Cesium's `globe.baseColor`, MapLibre's `background` layer, or CSS on Leaflet's or OpenLayers' map container.

## 5. Running it beyond your machine

- **Any site may load the layers.** The server sends CORS headers allowing every origin, and answers Chrome's private-network check, so pages on your LAN can use it.
- **But Chrome won't let a page on the public internet load from `localhost` or a private IP**, whatever the server allows. For a public website, run the server at a public address.
- **Addresses.** URLs in the catalog and TileJSON are absolute and built from the address each client used, so `localhost`, a LAN IP and a hostname all work. Behind a reverse proxy or CDN, publish one fixed address instead:

  ```bash
  python3 scripts/build_server.py --base-url https://maps.example.com
  ```

  Let the proxy handle HTTPS; the server honours its `X-Forwarded-Proto` header.
- **Caching.** Tiles are cached for a day. The catalog and TileJSON are always revalidated, so a refreshed catalog shows up immediately.

## 6. Attribution travels with the layers

Every layer's TileJSON and catalog entry carries its attribution, and MapLibre, OpenLayers and Leaflet (with the `attribution` option) show it in the map's corner. Keep it there: NASA and USGS ask for credit, and neither endorses the maps. Natural Earth is public domain and asks for nothing. The details are in `LICENSING.md`, which the server also serves at `/licensing`.

## How it's built

| File | Role |
| --- | --- |
| `scripts/build_server.py` | Reads the provenance records and writes the catalog, TileJSON and index page to `mapserver/www/` |
| `mapserver/nginx.conf` | The URL routes, `204` for skipped tiles, caching, gzip |
| `mapserver/cors.conf`, `origin.conf` | Cross-origin headers; filling in the server's own address |
| `mapserver/Dockerfile` | `nginx` on Alpine, with a health check at `/healthz` |
| `compose.yaml` | Port and the read-only mounts of tiles, vectors, provenance and licensing |
| `tests/server.spec.js` | End-to-end checks, including loading tiles from a page on another origin |
