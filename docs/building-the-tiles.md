# Building the tiles

The map is made of **87,381 JPEG tiles** (about 350 MB), cut from NASA's Blue Marble: Next Generation imagery. Three commands go from NASA's files to tiles the globe can load. Each one records what it did, so the result can be traced back to the source.

## What you need

- **Python 3.9+**, standard library only
- **GDAL 3.9+**, the open-source toolkit that does the reprojection and tiling: `brew install gdal` on macOS, `apt install gdal-bin python3-gdal` on Debian/Ubuntu
- About **8 GB of free disk**: 3.2 GB of source files, a 4 GB intermediate file, and 350 MB of tiles

## 1. Download the source

```bash
npm run fetch:source
```

This downloads eight 21600 × 21600 GeoTIFFs (each about 400 MB) from NASA. Together they cover the world at 500 m per pixel. They're NASA's August 2004 *topography + bathymetry* images: true-colour land with shaded ocean depth.

The script writes each file's URL, size and **SHA-256** to `provenance/sources.json`. If that file already exists, each download is checked against it, and the script stops if any byte differs. So a rebuild provably starts from the same data.

## 2. Build the tiles

```bash
npm run build:tiles
```

The script runs four GDAL steps:

| Step | Tool | What it does |
| --- | --- | --- |
| Mosaic | `gdalbuildvrt` | Joins the 8 files into one virtual image, without copying any pixels |
| Reproject | `gdalwarp` | Converts latitude/longitude (EPSG:4326) to Web Mercator (EPSG:3857), the projection web maps use. Crops to about ±85° latitude and sizes the image at exactly 65,536 px square, the zoom-8 resolution. |
| Overviews | `gdaladdo` | Precomputes averaged half-, quarter- and smaller-size versions for the lower zoom levels |
| Tile | `gdal2tiles --xyz` | Cuts 256 × 256 JPEGs into `public/tiles/blue-marble/{z}/{x}/{y}.jpg` for zoom 0–8 |

Nothing else is done to the pixels: no colour correction and no other data mixed in.

It took **about 8½ minutes** on an Apple Silicon Mac. Reprojection takes most of that time, and tiling takes about 1½ minutes. Each run writes its per-step wall-clock times to `provenance/build.json`, along with the GDAL version, every command it ran, and a single SHA-256 digest of all the tiles.

## 3. Verify

```bash
npm run verify:tiles
```

This re-hashes every tile and compares the result with `provenance/build.json`. A copy of the full record also ships with the tiles, at `/tiles/blue-marble/PROVENANCE.json`.

## Making your own tileset

`scripts/build_tiles.py` is short and its settings are at the top:

- **More detail:** raise `MAX_ZOOM`. Each extra level roughly quadruples the tile count. The NASA source has enough detail for about zoom 8; beyond that, Cesium just enlarges the tiles.
- **Different imagery:** any GeoTIFF with a coordinate system works. Point the inputs at it, and set the layer's `url` and `maximumLevel` to match (see *Add the layer*).
- **PNG instead of JPEG:** use PNG when you need transparency, for example an overlay layer. Change `--tiledriver` and the file extension in the `url`.
