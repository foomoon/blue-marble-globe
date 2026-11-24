# Serving layers to other maps

The **map server** shares the layers you've built with any web map: Leaflet, MapLibre, OpenLayers, Cesium, or a desktop GIS such as QGIS. It's a small Docker container that serves standard **XYZ tiles**, **TileJSON** and **GeoJSON**, plus the provenance and licensing to go with them.

## 1. Start it

You need Docker running (on a Mac, open Docker Desktop). Then:

```bash
npm run server:up      # build and start on http://localhost:8080: the map server and the builder
npm run test:server    # optional: check it end to end
npm run server:down    # stop it
```

Open **http://localhost:8080**. It lists every layer you've built, each with a preview, its attribution, and copy-paste code for Leaflet, MapLibre, OpenLayers and Cesium.

To use a different port: `MAPSERVER_PORT=9000 npm run server:up`.

## 2. After building a layer

Nothing to do. The container reads `public/tiles/` and `public/vectors/` directly (mounted read-only, not copied), so new or rebuilt tiles are served straight away. And every build (Blue Marble, Grey, terrain, vectors, and each region, including from the Regions panel) refreshes the server's home page, catalog and TileJSON as its last step, so the new layer is listed too. No restart.

That refresh only runs once the server is set up (after the first `npm run server:up`), and it keeps a published address (`--base-url`). To refresh by hand, after deleting a layer's tiles for example:

```bash
npm run server:build
```

## 3. What it serves

| URL | What you get |
| --- | --- |
| `/` | The index page: previews and code for every layer |
| `/catalog.json` | Every layer, machine-readable: id, kind, URLs, zoom range, bounds, attribution, licence, provenance |
| `/tiles/<layer>/tilejson.json` | TileJSON 3.0.0: tile URL, zoom range, bounds and attribution in one file. Most web maps can take this alone. |
| `/tiles/<layer>/{z}/{x}/{y}.<ext>` | The tiles: Web Mercator, XYZ order, 256 px |
| `/tiles/terrain/{z}/{x}/{y}.webp` | Elevation tiles (global terrain): colours encode height; see *MapLibre: 3D terrain* below |
| `/tiles/landsat/<region>/terrain/{z}/{x}/{y}.webp` | A region's own elevation tiles (USGS 3DEP 10 m or NASADEM 30 m) |
| `/vectors/<name>.geojson` | Borders, US states, coastlines, unchanged |
| `/provenance/` | Every build record and archived terms |
| `/licensing`, `/notice` | `LICENSING.md` and `NOTICE` |

Layer ids are `blue-marble`, `grey`, `landsat/<region>` (for example `landsat/everest`), `terrain` and `landsat/<region>/terrain` for elevation, and `country-borders`, `us-states`, `coastlines` for the vectors. Only layers you've built appear.

**Missing imagery tiles answer `204 No Content`, not `404`.** Grey has no ocean tiles and a region has none outside its area; those were skipped on purpose. `204` tells a web map "blank here" without logging an error.

**Missing terrain tiles answer a flat sea-level tile.** The terrain builds skip tiles that are all sea, but MapLibre's 3D terrain needs a real tile everywhere: a `204` there makes it fail with "dem dimension mismatch".

## 4. Use it from a web map

Replace `localhost:8080` with the server's address.

### Pick your layers

A map needs **one base map** underneath, then any overlays on top:

| Layer | Role | URL | Zooms |
| --- | --- | --- | --- |
| Blue Marble | base map | `/tiles/blue-marble-webp/{z}/{x}/{y}.webp` (the default build), or `/tiles/blue-marble/{z}/{x}/{y}.jpg` if built as JPEG | 0–8 |
| Grey | base map (transparent water: give the map a dark background) | `/tiles/grey/{z}/{x}/{y}.png` | 0–9 |
| Landsat region | detail overlay for one area | `/tiles/landsat/<region>/{z}/{x}/{y}.webp` | per region, e.g. Everest 8–12 |
| Terrain | elevation, for 3D and hillshading | `/tiles/terrain/{z}/{x}/{y}.webp` | 0–8 |
| A region's terrain | sharper elevation for one area | `/tiles/landsat/<region>/terrain/{z}/{x}/{y}.webp` | per region, e.g. Everest 8–12 |
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
  url: `${SERVER}/tiles/blue-marble-webp/{z}/{x}/{y}.webp`, // or blue-marble/…jpg if built as JPEG
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
  url: `${SERVER}/tiles/landsat/everest/{z}/{x}/{y}.webp`,
  tilingScheme: new Cesium.WebMercatorTilingScheme(),
  minimumLevel: 8,
  maximumLevel: 12,
  rectangle: Cesium.Rectangle.fromDegrees(86.87716, 27.74999, 87.21799, 28.04424),
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

### MapLibre: 3D terrain

The terrain tiles are a `raster-dem` source in the "terrarium" encoding. MapLibre raises the map with them and can shade them too:

```js
map.addSource("dem", { type: "raster-dem", url: "http://localhost:8080/tiles/terrain/tilejson.json",
                       tileSize: 256, encoding: "terrarium" });
map.setTerrain({ source: "dem", exaggeration: 2 });                 // 3D
map.addLayer({ id: "hills", type: "hillshade", source: "dem" });   // shaded relief
```

For one region, use its terrain instead (`/tiles/landsat/everest/terrain/tilejson.json`). It covers the region's box. Inside its outline it's the region's own 10 m or 30 m data, blending into the global heights at the edge, so it has no cliff there. MapLibre takes one terrain source at a time.

### Leaflet

```js
L.tileLayer("http://localhost:8080/tiles/blue-marble-webp/{z}/{x}/{y}.webp", {
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

### This project's globe

**It's on the server:** http://localhost:8080/globe/, built by `npm run server:up` (or `npm run server:globe`). Same address as the data, so it just works. Its **Server** light (top right) is green while the server answers, red when it doesn't, and its **Admin** pill (top left) leads to the admin page.

**Or run it separately** and point it at the server: set the server's address when starting or building the globe: `VITE_MAP_SERVER_URL=http://localhost:8080 npm run dev`. It then takes every tile, terrain tile, region and line from the server, and its **Server** light (top right) shows whether the server is answering. Without the setting, it reads its own files, and has no light.

### The admin page: building regions on the server

http://localhost:8080/admin/ is the globe with the **Regions** panel: draw a region, build it, watch it come in. Set its login once with `npm run server:password`, **in a terminal** (a username and a 12+ character password). Visiting `/admin/` then shows the app's own **sign-in page** (`/login/`); once signed in you stay signed in for 12 hours, or until **Sign out** in the Regions panel. Without a login set up, nobody can sign in.

How it's protected:

- **The password** is stored as a salted scrypt hash in `mapserver/auth/users` (not committed, readable only by you). Changing it applies at once and signs everyone out.
- **Sessions** are a signed cookie (HttpOnly, SameSite=Strict, and Secure behind HTTPS). nginx asks the builder to check it (`auth_request`) on every request to `/admin/` and `/api/`: pages without a valid session go to the sign-in page, API calls get 401.
- **Guessing** is slowed: each wrong password waits about a second, and nginx allows 10 attempts a minute per address (then 429).

Builds run in the **builder** container (`mapserver/builder/Dockerfile`): GDAL, Python, numpy and Node, with the region build scripts and the Regions API (`server/admin-api.js`) mounted from the project. nginx passes `/api/` and `/auth/` to it, the first only with a signed-in session; it's not reachable any other way. It writes regions, tiles, provenance and the catalog into the project, owned by you; it's limited to 4 CPUs and 6 GB of memory by default (`BUILDER_CPUS`, `BUILDER_MEMORY`). If it's stopped, the map server carries on serving; only the admin page's API stops answering.

## 5. Running it beyond your machine

- **Any site may load the layers.** The server sends CORS headers allowing every origin, and answers Chrome's private-network check, so pages on your LAN can use it.
- **But Chrome won't let a page on the public internet load from `localhost` or a private IP**, whatever the server allows. For a public website, run the server at a public address.
- **Addresses.** URLs in the catalog and TileJSON are absolute and built from the address each client used, so `localhost`, a LAN IP and a hostname all work. Behind a reverse proxy or CDN, publish one fixed address instead:

  ```bash
  python3 scripts/build_server.py --base-url https://maps.example.com
  ```

  Let the proxy handle HTTPS; the server honours its `X-Forwarded-Proto` header.
- **The admin page over the network:** on anything but your own machine, use HTTPS (below), or the password and session cookie travel unencrypted.
- **Copying the tiles to another machine:** use `rsync -aH` (or `cp -a`, or `tar`), which keeps hard links. Grey stores its identical tiles once as hard links; a plain copy expands it from ~150 MB to ~620 MB. No tile has more than 60,000 links, so they fit Linux's ext4 limit (65,000).
- **Caching.** Tiles are cached for a day. The catalog and TileJSON are always revalidated, so a refreshed catalog shows up immediately.

## 6. HTTPS

The map server serves HTTPS itself as soon as it has a certificate: put `server.crt` (with any intermediate certificates after it) and `server.key` in `mapserver/tls/`, and restart (`npm run server:up`). Plain HTTP then redirects to HTTPS. HTTPS is on port **8443** here (`MAPSERVER_HTTPS_PORT` to change), **443** in an offline install.

Where the certificate comes from:

- **Your network's own certificate authority (CA)**, if it has one: its devices already trust it. Ask for a certificate for the server's name and IP address.
- **The project's private CA**, if not: `npm run server:cert -- maps.example.internal 10.20.0.5` (the names and IP addresses devices will use). The first run creates the CA in `mapserver/ca/` (keep its key safe, off any air-gapped network: it's only needed to issue the next certificate); each run writes `mapserver/tls/server.crt` and `server.key` (valid 825 days, the most Apple devices accept) and `ca.crt`, which each device must trust once (commands in the bundle's README.txt). None of these are committed.
- **Behind a reverse proxy** that handles HTTPS, leave `mapserver/tls/` empty: the server honours its `X-Forwarded-Proto` header.

**Names without DNS:** add a line to each device's hosts file (`/etc/hosts`; Windows: `C:\Windows\System32\drivers\etc\hosts`), e.g. `10.20.0.5  maps.example.internal`. The name must be one the certificate was made for.

## 7. Air-gapped networks: offline bundles

Build and update on a network with internet, then carry the result to the air-gapped one, where it runs **serve-only**: the globe and the layers, with no admin page, builder or sign-in (region builds need the internet). The globe makes no requests anywhere but the map server, so it works fully offline.

On the connected side:

```bash
npm run maps        # the map data (and regions, from the admin page, as usual)
npm run bundle      # bundles/blue-marble-globe-<date>/, for linux/amd64 (--platform linux/arm64 for ARM)
```

The bundle (about 1.3 GB today) holds the map server image (25 MB), the map data, `install.sh`, `README.txt`, `ca.crt` if you made a private CA, and `SHA256SUMS`. Never the admin login, the HTTPS key or the CA's key.

On the air-gapped server (Linux with Docker and its compose plugin; nothing else, and no internet):

```bash
./install.sh                     # into /opt/blue-marble-globe (or give another folder)
```

It checks every file against `SHA256SUMS` (a damaged copy is refused before anything changes), loads the image, unpacks the data as a new release, switches to it and restarts. The previous release is kept, for going back. **Updates** are the same: a new bundle, carried across, `./install.sh`. For HTTPS, put `server.crt` and `server.key` in `/opt/blue-marble-globe/tls/` once and run `install.sh` again; ports are in `.env` there (80 and 443). The bundle's `README.txt` has the details, including trusting the CA on each device.

Tested in a simulated air-gapped x86-64 Linux server (Docker inside Docker, networking off): install, HTTPS by name and IP, an update, and a damaged bundle being refused.

## 8. Attribution travels with the layers

Every layer's TileJSON and catalog entry carries its attribution, and MapLibre, OpenLayers and Leaflet (with the `attribution` option) show it in the map's corner. Keep it there: NASA and USGS ask for credit, and neither endorses the maps. Natural Earth is public domain and asks for nothing. The details are in `LICENSING.md`, which the server also serves at `/licensing`.

## How it's built

| File | Role |
| --- | --- |
| `scripts/build_server.py` | Reads the provenance records and writes the catalog, TileJSON and index page to `mapserver/www/` |
| `mapserver/site.conf` | The URL routes, `204` for skipped tiles, caching, gzip |
| `mapserver/admin.conf` | The admin page, sign-in and API routes, all handled by the builder |
| `mapserver/http.conf` | Settings outside the server: the address scheme, the sign-in rate limit |
| `mapserver/mapserver-config.sh` | At start-up, puts these together: HTTPS if there's a certificate, admin routes unless `MAPSERVER_ADMIN=off` |
| `mapserver/builder/Dockerfile` | The builder: GDAL, Python, numpy and Node, for map and region builds |
| `server/admin-api.js`, `auth.js`, `studio-api.js` | The builder's API: sign-in and sessions, regions and build jobs |
| `mapserver/login/` | The sign-in page |
| `mapserver/airgap/` | What an offline bundle carries: its compose file, `install.sh`, `README.txt` |
| `scripts/bundle.sh`, `make-cert.sh` | `npm run bundle`, `npm run server:cert` |
| `mapserver/cors.conf`, `origin.conf` | Cross-origin headers; filling in the server's own address |
| `mapserver/Dockerfile` | `nginx` on Alpine, with a health check at `/healthz` |
| `compose.yaml` | Port and the read-only mounts of tiles, vectors, provenance and licensing |
| `tests/server.spec.js` | End-to-end checks, including loading tiles from a page on another origin |
