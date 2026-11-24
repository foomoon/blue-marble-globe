# Backlog

Ideas and deferred work, roughly in priority order within each section.

## Next up

### Chunked, resumable region builds (needed for CONUS)

Today's build reads every scene before compositing, keeps all of it on disk, and deletes everything if it fails. A CONUS build (~2,500 scenes) would need ~565 GB of scratch space and ~10+ hours, with no way to resume.

- Split the region into chunks of about 160 km (one zoom-8 tile each, ~330 for CONUS).
- Each chunk downloads only its scenes, composites, tiles, then deletes its scratch data, so disk use stays at a few GB.
- Record each finished chunk, so a restart resumes where it left off.
- Run chunks in parallel, using all CPU cores.
- Globe progress: show chunks filling in across the region.

## Ideas

### Regional terrain for big regions

`scripts/region_terrain.py` reads a region's elevation onto its zoom-14 grid in one scratch file (capped at 600 million pixels; bigger regions stop a zoom earlier). Fine for parks and cities; a state-sized region would want the same chunking as the imagery build.

### Terrain at the edge of regional tiles in Cesium

In Cesium, a terrain tile partly covered by a region's tiles takes neighbouring heights from the nearest pixel it has, which is fine because the region has blended into the global heights by its edge. Thin lines are sometimes visible along terrain tile seams on steep slopes; probably Cesium's skirts. Worth a look if it bothers anyone.

### Heights relative to the ellipsoid (geoid correction)

ETOPO heights are above mean sea level (EGM2008 geoid); Cesium places them on the WGS84 ellipsoid unchanged, so they're off by up to about 100 m, depending on place. Correcting means adding the geoid height (NGA's EGM2008 grid, public domain), but then the sea (flattened to 0) would need the same correction or coasts would show a step. Only worth it if someone needs true heights.

### Land below sea level

The terrain build flattens everything below 0 m, which also flattens the Dead Sea shore, Death Valley and the Caspian depression. A land mask (Natural Earth land, already downloaded for Grey) would let them keep their real heights while the sea stays flat.

### Fade open ocean to Blue Marble in regional layers

**Problem:** Landsat's ocean is darker than Blue Marble's, so a region's edge shows as a visible square over open water, mostly between zoom 8 and 10. Cosmetic only.

**Approach:** use Landsat's own water flag, `QA_PIXEL` bit 7, already read by the build:
1. A pixel counts as water if it's flagged water in most of the scenes that saw it clearly (evens out errors and tides).
2. `gdal.ComputeProximity` gives every water pixel its distance to the nearest land pixel.
3. Alpha fades from fully visible within ~2 km of shore to transparent by ~4 km. Lakes, reefs and coastal shallows stay sharp; open ocean shows Blue Marble.

Fits naturally into the chunked build (per chunk).

**Known weak spots:**
- Murky or shallow water and wet sand can be misjudged; the fade band hides a few pixels of error.
- Dark land (fresh lava, deep shadow, burn scars) may be flagged as water. It stays visible near land, but large dark areas could get holes.
- Big lakes (e.g. the Great Lakes) would go transparent in the middle; Blue Marble shows water there, so that's acceptable.

**Fallback if the flag is too noisy:** mask with the **Natural Earth** coastline (public domain, ~1 km accuracy). **Not** OpenStreetMap: its ODbL licence would break the no-licence claim in `LICENSING.md`.

**Cheaper alternatives in the meantime:**
- Draw region polygons close to the coast (no code).
- Fade every region's edges over a few km (fades land too).

### Smaller Grey base map (skip solid tiles)

The Grey map is 150,196 tiles: 102 MB of data but **592 MB on disk**, since every small file takes at least 4 KB. 73% of tiles are at zoom 9, and most of those are identical solid-grey inland squares. Skip writing solid tiles: list them in `tiles.json` as "solid", and have the globe draw a shared grey tile for them, as it already uses a shared empty tile for missing ones. That would cut the file count by about two-thirds with no visual change. Alternatively, stop at zoom 8 (~40k tiles).

### Suggest months from the region's latitude

When a region is drawn, pre-fill the months: tropics: all months; northern mid-latitudes: June–September; southern mid-latitudes: December–March. Still editable.

### Clearer "Scenes/spot" label

Rename to "Scenes per area" and add a tooltip explaining Landsat path/rows and why 3–5 is the sweet spot.

## Housekeeping

- **Homebrew numpy is broken** on the dev Mac (missing `__init__.py`); the project uses `.venv` to avoid it. `brew reinstall numpy` would fix it system-wide.
