# Blue Marble Globe

A clean CesiumJS globe on self-hosted NASA Blue Marble tiles. It needs no API keys, no online map services and no licence, and every tile can be traced back to the exact NASA files it came from.

- **How to add the layer in code:** [docs/adding-a-map-layer.md](docs/adding-a-map-layer.md)
- **Why no licence is needed:** [LICENSING.md](LICENSING.md), backed by archived copies of [NASA's usage guidelines](provenance/terms/nasa-images-and-media-guidelines.md)
- **Where every tile came from:** [provenance/](provenance/)

## Quick start

Requirements: Node 26 LTS (`nvm use` reads .nvmrc), Python 3.9+, GDAL 3.9+ (`brew install gdal` on macOS).

```bash
npm install
npm run fetch:source   # ~3 GB from NASA, checksums verified against provenance/sources.json
npm run build:tiles    # ~350 MB of tiles into public/tiles/blue-marble/, zoom 0-8
npm run dev
```

`npm run verify:tiles` re-hashes the tiles and checks them against `provenance/build.json`.

`npm test` runs the Playwright browser tests (first time: `npx playwright install chromium`):
- the production globe makes **no requests outside its own origin**
- NASA's credit and terms link are on screen, and the Cesium ion logo isn't
- the Guide panel works, and the dev-only Regions studio is absent from the build
- in dev: drawing, estimating, saving and deleting a region

The HTML report, including a screenshot of the globe, is in `playwright-report/`.

### Disk space

| Path | Size | Kept? |
| --- | --- | --- |
| `data/source/` | 3.0 GB | Kept, so you can rebuild without downloading again. `npm run clean:source` removes it; `fetch:source` re-downloads and re-verifies it. |
| `data/work/` | ~4 GB | Deleted automatically after a successful build (`--keep-work` keeps it) |
| `dist/` | ~550 MB | Output of `npm run build`, including a copy of the tiles. `npm run clean` removes it and `data/work/`. |
| `public/tiles/` | ~350 MB | The tiles. Keep them. |

## Layers

The **Layers** button (top right) switches layers on and off, and the choices are remembered:
- **Blue Marble:** the global base map
- **Country borders:** Natural Earth, 1:50m, public domain. Disputed segments are dashed; see `LICENSING.md` for which boundary view this is.
- **US states:** Natural Earth, 1:50m, public domain; fainter lines under the country borders.

Both vector layers are regenerated with `npm run fetch:vectors`. To add another Natural Earth layer, add an entry to `LAYERS` in `scripts/fetch_vectors.py` and `VECTORS` in `src/layers.js`.
- **Each built Landsat region:** with an opacity slider and **Go** to fly there. A region shows from its minimum zoom inward.

The bottom-right corner shows the latitude/longitude under the cursor, or the centre of the view.

## Regions studio (dev only)

Under `npm run dev`, a **Regions** button (top left) opens a panel for planning higher-resolution regional layers:

1. Pick **Rectangle** or **Polygon**, press **New region**, and draw:
   - Rectangle: drag on the globe.
   - Polygon: click each corner. You can still move the globe between clicks. Double-click, press Enter, or click the first corner to finish; Backspace removes the last corner, Esc cancels.

   To reshape a saved region, open it from the list and use **Redraw area**.
2. Set the name, date range, months, cloud limit and zoom range. Tile counts per zoom level update live. They're exact, from the Web Mercator grid, and for a polygon they count only the tiles it touches. The size assumes ~20 KB per tile.
3. **Save region** writes `regions/<name>.json` through a small API in the dev server (`server/studio.js`).

Saved regions show as outlines; click one in the list to fly to it and edit it. The panel and its API exist only in the dev server: `npm run build` leaves both out, so the deployed globe is view-only. The API accepts requests only from the app's own page.

### Regional Landsat layers

**Save & build** (or **Build** on a saved region) turns a config into a 30 m Landsat layer over Blue Marble. The build runs on your machine, started by the dev server, and the panel shows it live:

- **Progress card:** each stage (search, download, composite, tile) with a bar and detail, elapsed time, time remaining, a log, and Cancel. It survives a page reload.
- **On the globe:** the chosen Landsat scenes' footprints appear and fill in as their pixels arrive, the composite grid lights up block by block, then the new imagery appears tile by tile.

One-time setup (Homebrew's numpy can be broken, so the project uses its own):

```bash
python3 -m venv --system-site-packages .venv   # keeps access to GDAL's Python bindings
.venv/bin/pip install --ignore-installed -r scripts/requirements.txt
```

A region can also be built from the terminal, which prints the same progress as JSON lines: `npm run build:region -- regions/<name>.json`.

How it works: scenes come from Landsat Collection 2 Level-2 (surface reflectance) via Microsoft Planetary Computer's public catalogue, with no account needed. Only the region's pixels are read from the cloud-optimised files. Clouds and shadows are masked using Landsat's own QA band, and each pixel is the median of the clear views. Tiles are WebP, so areas with no clear view, or outside a polygon boundary, stay transparent and Blue Marble shows through. Completely empty tiles aren't written; each build's `tiles.json` lists the ones that exist, so the globe never requests a tile that isn't there. Each build writes `provenance/regions/<name>.json`: every scene ID, its asset URLs, ETags and sizes, the config, timings and a tile digest.

`npm run test:build` runs an end-to-end test that builds a small area near Boulder through the panel, using the internet and taking about a minute.

Built regions show in the dev studio. Adding them to the production globe is the next step.

## Layout

```
src/main.js                 the whole app: one imagery layer on a bare viewer
src/guide.js                in-app Guide panel (renders docs/*.md)
src/studio/                 dev-only Regions panel: drawing, tile estimates
server/studio.js            dev-only API: saves regions/*.json, runs and streams builds
scripts/build_region.py     Landsat region build (search, read, composite, tile)
regions/                    saved region configs
scripts/fetch_source.py     download the NASA GeoTIFFs and record their checksums
scripts/build_tiles.py      reproject and tile with GDAL, recording every command
provenance/sources.json     NASA URLs + SHA-256 of the exact source bytes
provenance/build.json       GDAL version, commands, and a digest of all tiles
provenance/terms/           archived copies of the usage terms (NASA, Natural Earth)
provenance/vectors.json     source, checksums and conversion of each vector layer
public/vectors/             vector layers: country borders (426 KB), US states (66 KB); committed
scripts/fetch_vectors.py    fetch + convert Natural Earth vector layers
LICENSING.md                terms, quotes and conditions, with links
NOTICE                      attribution for redistribution
```

The source data (`data/`) and tiles (`public/tiles/`) are gitignored because they are large and fully reproducible. The provenance files are committed.

## Deploying

`npm run build` writes a static site to `dist/`. Copy `public/tiles/` along with it; Vite does this automatically, since the tiles live in `public/`. Any static host works.
