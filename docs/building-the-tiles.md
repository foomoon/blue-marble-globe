# Building the map data

Everything the globe shows is built on your machine from public-domain sources, and every build records what it did in `provenance/`.

| Layer | Source | Command | Time | Size |
| --- | --- | --- | --- | --- |
| **Blue Marble** base map | NASA Blue Marble: Next Generation | `npm run fetch:source` + `npm run build:tiles` | ~2 min download + ~12 min build | ~156 MB (WebP) |
| **Grey** base map | Natural Earth 1:10m land + lakes | `npm run build:grey` | ~6 min | ~150 MB on disk |
| **Terrain** | NOAA ETOPO 2022, 15″ | `npm run build:terrain` | ~13 min: 8½ to download, 4 to build | ~830 MB |
| **Borders, states, coastlines** | Natural Earth 1:50m | `npm run fetch:vectors` | seconds | ~1.8 MB (committed) |
| **Landsat regions** | USGS Landsat 8/9 | Regions panel (dev) | minutes per region | varies |

Tiles go in `public/tiles/` (gitignored, reproducible). The vector files are small, so they're committed in `public/vectors/`. Times are from an Apple Silicon Mac.

## What you need

- **Python 3.11+**. The Blue Marble, Grey and vector scripts use the standard library only; terrain and Landsat regions also need the project's `.venv` (see the README).
- **GDAL 3.6+** with WebP, the open-source toolkit that does the reprojection, rasterising and tiling: `brew install gdal` on macOS, `sudo apt install gdal-bin python3-gdal` on Ubuntu (`scripts/setup-ubuntu.sh` installs everything). Before GDAL 3.9 (Ubuntu 24.04 has 3.8), `gdal2tiles` can't write JPEG, so the Blue Marble build writes PNG and converts each tile, which adds a couple of minutes.
- `npm run doctor` checks all of it.
- **Disk:** about 8 GB free while building Blue Marble (3.2 GB of source plus a 4 GB intermediate, deleted afterwards). Terrain needs 5.2 GB for NOAA's files (kept for rebuilds) plus about 0.9 GB of tiles, and no intermediate.

## Blue Marble

```bash
npm run fetch:source   # 8 NASA GeoTIFFs, ~3.2 GB
npm run build:tiles    # -> public/tiles/blue-marble-webp/{z}/{x}/{y}.webp, zoom 0-8
npm run verify:tiles   # re-hash every tile against provenance/build.json
```

**Formats:** WebP by default, at quality 80, into `public/tiles/blue-marble-webp/`: 156 MB, about half the size of JPEG. `npm run build:tiles -- --format jpeg` builds JPEG (quality 85, 349 MB) into `public/tiles/blue-marble/` instead, for clients older than about 2020, and `--format both` builds both from one reprojection. A build in one format leaves the other's tiles and record untouched.

*Why WebP 80:* measured against the full-resolution image, it scores slightly below JPEG 85 (SSIM 0.984 against 0.991; a touch smoother on open sea), and side by side there's no visible difference. WebP 88 matches JPEG's score at 76% of its size, if that ever matters. When WebP tiles exist, the globe uses them; otherwise JPEG. The map server lists both, as `blue-marble` and `blue-marble-webp`.

**Performance profile:** every build records, per step, the wall time, CPU time, how many cores it kept busy, peak memory, output sizes and throughput, plus the machine (CPU, cores, memory) and the download's timings, in `provenance/build.json` under `profile`, and prints them as a table.

**fetch:source** downloads eight 21600 × 21600 GeoTIFFs from NASA: the August 2004 topography + bathymetry images, 500 m per pixel. Each file's URL, size and **SHA-256** go into `provenance/sources.json`. Later runs check the files against it and stop if any byte differs.

**build:tiles** runs four GDAL steps:

| Step | Tool | What it does |
| --- | --- | --- |
| Mosaic | `gdalbuildvrt` | Joins the 8 files into one virtual image, without copying pixels |
| Reproject | `gdalwarp` | Latitude/longitude (EPSG:4326) to Web Mercator (EPSG:3857), cropped to about ±85°, sized at exactly 65,536 px square (zoom 8) |
| Overviews | `gdaladdo` | Averaged smaller versions for the lower zoom levels |
| Tile | `gdal2tiles --xyz` | 256 × 256 JPEGs, zoom 0–8 |

Nothing else is done to the pixels: no colour correction and no other data. `provenance/build.json` records the GDAL version, every command, per-step timings and one SHA-256 over all tiles. The intermediate is deleted afterwards; `npm run clean:source` also removes the NASA files.

## Grey base map

```bash
npm run build:grey     # -> public/tiles/grey/{z}/{x}/{y}.png, zoom 0-9
```

This draws Natural Earth's 1:10m **land** as flat light grey (`#d6d6d6`) and leaves **water transparent**:

| Step | Tool | What it does |
| --- | --- | --- |
| Reproject | `ogr2ogr` | Land and lake outlines to Web Mercator, clipped to ±85° |
| Rasterise | `gdal_rasterize` | Land burned in as grey on the zoom-9 grid; lakes burned back to transparent |
| Overviews | `gdaladdo` | Averaged smaller versions |
| Tile | `gdal2tiles --xyz --exclude` | PNG tiles; all-water tiles aren't written at all |

**Identical tiles are stored once.** Three in four Grey tiles are the same solid grey square inland, and every small file takes a whole disk block. So after tiling, `scripts/dedupe_tiles.py` replaces each duplicate with a hard link to one copy: every tile is still an ordinary file at its usual path, but the 150,196 tiles take ~150 MB on disk instead of ~620 MB. When copying the tiles to another machine, keep the links (`rsync -H`, `cp -a` or `tar`), or they'll take the full size there.

`tiles.json` also lists those groups (`"same"`: one representative tile, then its copies), so **the globe downloads each repeated tile once** and reuses it: over inland views, Grey's downloads drop by about two-thirds, and at zoom 9 nearly to nothing. Other web maps don't need to know: every tile is still served as its own file. `npm run build:grey -- --reindex` rewrites `tiles.json` from existing tiles.

The ocean colour isn't in the tiles. The globe's base colour (`#3b3f45`) shows wherever there's no land tile, which is why ocean tiles never need to exist. `tiles.json` lists the tiles that do exist, so the globe never requests one that doesn't. `provenance/grey.json` records both downloads' checksums, the commands and a tile digest.

## Terrain

```bash
npm run build:terrain  # -> public/tiles/terrain/{z}/{x}/{y}.webp, zoom 0-8
```

This needs the project's `.venv` (numpy and GDAL's Python bindings; setup is in the README under *Higher-resolution regions*).

**Source:** NOAA's **ETOPO 2022** global relief model at 15 arc-seconds (about 450 m): 288 GeoTIFFs, 5.2 GB, downloaded six at a time into `data/source/etopo/` and kept for rebuilds. Each file's SHA-256 goes into `provenance/terrain.json`; later runs check the files against it and stop if any byte differs. An interrupted download resumes where it stopped. `npm run build:terrain -- --fetch` only downloads and verifies.

**Build:**

| Step | What it does |
| --- | --- |
| Mosaic | Joins the 288 files into one virtual image (`gdalbuildvrt`, no copying) |
| Reproject | One zoom-4 square at a time, in parallel: reprojects that square's heights to the zoom-8 Web Mercator grid (4,096 px). Averages where a grid cell is bigger than a source cell (lower latitudes), interpolates elsewhere. |
| Land only | Heights below 0 become 0, so the sea is the globe's own smooth surface. That includes land below sea level, such as the Dead Sea shore and Death Valley. |
| Tiles | Zoom 8, then 2 × 2 averages for each zoom out to 0. Heights are rounded to whole metres and encoded as lossless WebP. Tiles with no land aren't written; `tiles.json` lists those that are. |

**Why the encoding matters:** finer than a metre, the digits are noise that doesn't compress, and keeping them doubled the size in testing. Lossless WebP is about 30% smaller than PNG. Lossy compression isn't an option: it would change the heights.

**Heights are relative to sea level** (ETOPO uses the EGM2008 geoid), placed on Cesium's WGS84 ellipsoid without correction. Depending on the place, the difference is up to about 100 m. That's invisible on a globe, but this terrain isn't the thing to measure precise heights against.

The build has to take care to *keep* them relative to sea level. ETOPO's files declare their reference as "WGS 84 + EGM2008 height", and given that, GDAL converts heights to the ellipsoid on reprojection, adding the local geoid height (+55 m at Guam). The build reprojects with the horizontal reference only, so heights pass through unchanged. The regional terrain does the same, so the two agree (a test checks this at Guam).

**Result:** 42,469 tiles, 828 MB (about 880 MB on disk), built in 4 min 14 s using 15 processes on an Apple Silicon Mac, after an 8½-minute download. Only about 40% of zoom-8 tiles have land, which is why it's far smaller than all 87,381.

`provenance/terrain.json` records all 288 files' checksums, the encoding, the method, per-step timings and a digest of every tile.

## Vector layers

```bash
npm run fetch:vectors  # -> public/vectors/*.geojson
```

| File | Natural Earth dataset | Lines |
| --- | --- | --- |
| `country-borders.geojson` | Admin 0 land boundary lines, 1:50m | 390 (35 disputed, drawn dashed) |
| `us-states.geojson` | Admin 1 state/province lines, 1:50m, US only | 125 |
| `coastlines.geojson` | Coastline, 1:50m | 1,428 |

`ogr2ogr` converts each shapefile to compact GeoJSON (coordinates to 4 decimals, about 11 m) and keeps only the fields the globe uses. The script refuses to write a file with empty geometry. `provenance/vectors.json` records each download's checksum, the exact conversion and each output's checksum.

**Adding another Natural Earth layer** (e.g. Canadian provinces) takes one entry in `LAYERS` in `scripts/fetch_vectors.py` (dataset, filter, fields) and one in `VECTORS` in `src/layers.js` (title, colour role). See *Add layers in code*.

## Landsat regions (dev)

Higher-resolution (30 m) regional layers are drawn and built in the **Regions** panel, which only exists under `npm run dev`. Each also gets its own terrain: USGS 3DEP at 10 m in the US, NASADEM at 30 m elsewhere (`scripts/region_terrain.py`), blended into the global terrain at its edge. The README covers setup and how a build works. Each build records every Landsat scene and elevation file it used in `provenance/regions/<name>.json`.

## Making your own tileset

`scripts/build_tiles.py` and `scripts/build_grey.py` are short, with their settings at the top:

- **More detail:** raise `MAX_ZOOM`. Each level roughly quadruples the tile count. Blue Marble's source has enough detail for about zoom 8.
- **Different imagery:** any GeoTIFF with a coordinate system works. Set the layer's `url` and `maximumLevel` to match.
- **Other colours for Grey:** change `LAND_GREY` in `build_grey.py` and `baseColor` in `src/layers.js`.
- **PNG or WebP instead of JPEG:** use them when you need transparency, as Grey and Landsat regions do.
