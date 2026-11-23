# Licensing and provenance

**Short version:** you don't need to buy, request or sign a licence to use or redistribute this globe and its map tiles. NASA's published usage guidelines already give the permission ([archived copy](provenance/terms/nasa-images-and-media-guidelines.md)). There are two obligations:

1. **Follow NASA's guidelines.** Credit NASA, imply no endorsement, use no NASA logos. The app shows "Imagery: NASA Earth Observatory, Blue Marble: Next Generation" in the credit bar.
2. **Keep CesiumJS's Apache-2.0 notice** when you redistribute the built app. This is a permissive open-source licence: no fee, no permission needed.

The rest of this page backs that up and shows how to check it.

> This document records the publishers' published terms as of **2026-11-22**. It is not legal advice. If a contract or customer depends on it, have counsel confirm it, especially for use outside the United States.

---

## 1. The map tiles: NASA Blue Marble: Next Generation

| | |
| --- | --- |
| Dataset | Blue Marble: Next Generation (BMNG), topography + bathymetry, August 2004, 500 m/pixel |
| Producer | Reto Stöckli, NASA Earth Observatory (NASA Goddard Space Flight Center) |
| Landing page | <https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/> |
| Exact files | 8 GeoTIFFs. URLs, sizes and SHA-256 are in [`provenance/sources.json`](provenance/sources.json) |

### What NASA says

NASA's usage terms are archived in this repo, so the wording relied on here can't drift out from under it:

| Page | Archived copy | Live page |
| --- | --- | --- |
| NASA Images and Media Usage Guidelines | [`provenance/terms/nasa-images-and-media-guidelines.md`](provenance/terms/nasa-images-and-media-guidelines.md) | <https://www.nasa.gov/nasa-brand-center/images-and-media/> |
| Blue Marble: Next Generation (credit line) | [`provenance/terms/nasa-blue-marble-next-generation.md`](provenance/terms/nasa-blue-marble-next-generation.md) | <https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/> |

Each archive holds the page's text plus the exact HTML as served (`provenance/terms/raw/`), with its SHA-256 and retrieval time in [`provenance/terms/terms.json`](provenance/terms/terms.json). Run `npm run fetch:terms` to refresh them; git history then shows whether NASA's wording changed.

**Not "public domain", but no licence needed.** The guidelines open by saying that NASA's insignia, logotype, identifiers *and imagery* "are not in the public domain," and that imagery "is made available for use consistent with Media Usage Guidelines." So the accurate claim is not that the imagery is public domain. It is that NASA's published guidelines already grant the permission, and this project follows them. The relevant grants, quoted from the archived copy:

> NASA content – images, … and media files used in the rendition of 3-dimensional models, such as texture maps and polygon data in any format – generally are not subject to copyright in the United States.

> You may use this material for educational or informational purposes, including photo collections, textbooks, public exhibits, computer graphical simulations and Internet Web pages.

> NASA content used in a factual manner that does not imply endorsement may be used without needing explicit permission.

A 3D globe textured with NASA imagery and published as a web page fits this wording directly: "texture maps", "computer graphical simulations", "Internet Web pages". The underlying reason is US copyright law: works made by federal employees as part of their duties aren't protected by copyright (17 U.S.C. § 105).

From the BMNG page, under Credits:

> Anyone using or republishing Blue Marble: Next Generation please credit "NASA Earth Observatory."

### The conditions that do apply

- **Credit:** "NASA Earth Observatory". This is done in `src/main.js` through the imagery provider's `credit` option. Keep the credit bar visible.
- **No endorsement:** don't present the app, or anything built on it, as endorsed by NASA. For commercial use, NASA says its content "must not explicitly or implicitly convey NASA's endorsement of commercial goods or services."
- **No NASA logos:** the NASA insignia ("meatball"), logotype and other identifiers are protected separately and are *not* covered by the points above. This project uses none of them; don't add them.
- **Outside the US:** NASA's wording is "not subject to copyright *in the United States*." Other countries may treat US government works differently. That's the main reason to get counsel's confirmation for non-US distribution.

### What was done to the imagery

Only geometric processing, recorded command by command in [`provenance/build.json`](provenance/build.json):

1. the 8 source tiles were mosaicked
2. reprojected from EPSG:4326 to Web Mercator (EPSG:3857), with bilinear resampling
3. cropped to about ±85.05° latitude, the edge of the Web Mercator map
4. resampled to zoom levels 0–8 and encoded as JPEG, quality 85

There is **no colour correction, no compositing with any other dataset, and no labels**. The tiles contain NASA's pixels and nothing else, so no third-party rights come in with them.

## 1b. Regional layers: Landsat 8/9 (optional)

Regions built in the dev studio use **Landsat 8–9 Collection 2 Level-2** imagery from the **U.S. Geological Survey**. Landsat data is a US government work, distributed by USGS without copyright restrictions. USGS asks for a credit line, which the app shows on screen whenever a Landsat layer is present: "Landsat imagery courtesy of the U.S. Geological Survey".

The scenes are *read* through Microsoft Planetary Computer's public catalogue. That service has its own terms of use for access, but they don't change the data's status. Each build records exactly which scenes it used in `provenance/regions/<name>.json`.

> USGS's terms aren't archived in `provenance/terms/` yet, unlike NASA's. Do that before relying on this section, in the same way (`scripts/fetch_terms.py`).

## 1c. Country borders and US states: Natural Earth

Both vector layers come from **Natural Earth**, version 5.1.0, at 1:50m, converted to GeoJSON by `scripts/fetch_vectors.py`:
- **Country borders:** Admin 0 land boundary lines
- **US states:** Admin 1 state/province lines, filtered to the United States

For each layer, [`provenance/vectors.json`](provenance/vectors.json) records the download URL, its SHA-256, the conversion command and the output's SHA-256.

**Public domain.** From Natural Earth's terms of use ([archived copy](provenance/terms/natural-earth-terms-of-use.md)):

> All versions of Natural Earth raster + vector map data found on this website are in the public domain.

The same page says no permission is needed and crediting is unnecessary, so the app shows no credit for these layers.

**Which borders are shown.** Every boundary dataset takes a position on disputed territory. The country-borders layer uses **Natural Earth's default edition, which shows de facto control** (who actually administers an area). Segments Natural Earth classes as disputed, indefinite or a line of control are kept and **drawn dashed**. Natural Earth also publishes country-specific "point of view" editions (e.g. the US view). If this globe is used where an official position matters, choose that edition deliberately and change `scripts/fetch_vectors.py`.

## 2. The software

| Component | Licence | Notes |
| --- | --- | --- |
| [CesiumJS](https://github.com/CesiumGS/cesium) | Apache-2.0 | Keep its `LICENSE.md` with redistributed builds; see [`NOTICE`](NOTICE). `npm run build` copies Cesium's runtime into `dist/cesium/`. |
| Vite, vite-plugin-cesium | MIT | Build tools only; not shipped. |
| GDAL | MIT | Used offline to make the tiles; not shipped. |

### Assets bundled with Cesium

The Cesium runtime includes some images of its own. Their sources come from Cesium's `LICENSE.md`:

| Asset | Source | Used here? |
| --- | --- | --- |
| Sky box (stars) | NASA (JPL / Goddard SVS) | Yes, the default starfield |
| Natural Earth II | Natural Earth, public domain | No (shipped by Cesium, never loaded) |
| `moonSmall.jpg` | Not clearly documented. Cesium's licence credits a copyrighted texture site ("JHT's Planetary Pixel Emporium"). | **No.** The app turns the moon off, and `vite.config.js` deletes the file from the build. |

### No online services

The app makes no requests to Cesium ion, Bing, Google or any other tile or terrain service: no API keys, no accounts, no terms of service. In `src/main.js`:

- the default ion imagery is replaced by `baseLayer`, and the geocoder and base layer picker, which call ion and Bing, are off
- the Cesium ion logo, which Cesium shows by default even when ion isn't used, is removed (`CreditDisplay.cesiumCredit = undefined`)
- Cesium's built-in demo ion token is blanked (`Ion.defaultAccessToken = ""`), so a stray ion request would fail rather than quietly depend on ion

`npm test` checks this automatically. It loads the production build in a browser, records every request, and **fails if any request leaves the app's own origin**. It also checks that the NASA credit and its terms link are on screen, that the ion logo isn't, that Cesium's licence ships, and that the moon texture doesn't. You can also look in the browser's Network tab yourself.

## 3. Verifying the chain yourself

```bash
npm run fetch:source   # downloads from NASA; fails if any file's SHA-256 differs from provenance/sources.json
npm run build:tiles    # rebuilds the tiles and rewrites provenance/build.json
npm run verify:tiles   # re-hashes public/tiles/ and compares with provenance/build.json
npm run fetch:terms    # re-archives the usage terms into provenance/terms/
npm run fetch:vectors  # re-downloads the borders; fails if the download differs from provenance/vectors.json
npm test               # browser test: no external requests, correct attribution
```

- `provenance/sources.json` ties each NASA URL to the exact bytes downloaded (SHA-256, size, HTTP ETag and Last-Modified, retrieval time).
- `provenance/build.json` ties those inputs to the output: GDAL version, every command with its arguments, and one SHA-256 digest covering all tiles.
- A copy of both files is shipped *with* the tiles, at `public/tiles/blue-marble/PROVENANCE.json`, so the record travels with any deployment.

The tile digest is exact for one GDAL version. A different GDAL release can encode JPEGs slightly differently, so after rebuilding with another version, compare the source checksums and the command list rather than the tile digest.
