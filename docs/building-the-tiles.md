# Building the map data

Everything the globe shows is built on your machine from public-domain sources, and every build records what it did in `provenance/`.

| Layer | Source | Command | Time | Size |
| --- | --- | --- | --- | --- |
| **Blue Marble** base map | NASA Blue Marble: Next Generation | `npm run fetch:source` + `npm run build:tiles` | ~8½ min | ~350 MB |
| **Grey** base map | Natural Earth 1:10m land + lakes | `npm run build:grey` | ~6 min | ~600 MB on disk |
| **Borders, states, coastlines** | Natural Earth 1:50m | `npm run fetch:vectors` | seconds | ~1.8 MB (committed) |
| **Landsat regions** | USGS Landsat 8/9 | Regions panel (dev) | minutes per region | varies |

Tiles go in `public/tiles/` (gitignored, reproducible). The vector files are small, so they're committed in `public/vectors/`. Times are from an Apple Silicon Mac.

## What you need

- **Python 3.9+**, standard library only. Landsat regions also need the project's `.venv`; see the README.
- **GDAL 3.9+**, the open-source toolkit that does the reprojection, rasterising and tiling: `brew install gdal` on macOS, `apt install gdal-bin python3-gdal` on Debian/Ubuntu.
- **Disk:** about 8 GB free while building Blue Marble (3.2 GB of source plus a 4 GB intermediate, deleted afterwards).

## Blue Marble

```bash
npm run fetch:source   # 8 NASA GeoTIFFs, ~3.2 GB
npm run build:tiles    # -> public/tiles/blue-marble/{z}/{x}/{y}.jpg, zoom 0-8
npm run verify:tiles   # re-hash every tile against provenance/build.json
```

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

The ocean colour isn't in the tiles. The globe's base colour (`#3b3f45`) shows wherever there's no land tile, which is why ocean tiles never need to exist. `tiles.json` lists the tiles that do exist, so the globe never requests one that doesn't. `provenance/grey.json` records both downloads' checksums, the commands and a tile digest.

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

Higher-resolution (30 m) regional layers are drawn and built in the **Regions** panel, which only exists under `npm run dev`. The README covers setup and how a build works. Each build records every Landsat scene it used in `provenance/regions/<name>.json`.

## Making your own tileset

`scripts/build_tiles.py` and `scripts/build_grey.py` are short, with their settings at the top:

- **More detail:** raise `MAX_ZOOM`. Each level roughly quadruples the tile count. Blue Marble's source has enough detail for about zoom 8.
- **Different imagery:** any GeoTIFF with a coordinate system works. Set the layer's `url` and `maximumLevel` to match.
- **Other colours for Grey:** change `LAND_GREY` in `build_grey.py` and `baseColor` in `src/layers.js`.
- **PNG or WebP instead of JPEG:** use them when you need transparency, as Grey and Landsat regions do.
