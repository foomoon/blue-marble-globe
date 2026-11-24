#!/usr/bin/env python3
"""
Build global terrain: NOAA ETOPO 2022 (15 arc-second, about 450 m) as elevation tiles.

Each tile is a 256 x 256 lossless WebP image whose colours encode height ("Terrarium"):

    height_m = R * 256 + G + B / 256 - 32768

The same tiles work in Cesium (src/terrain.js decodes them) and in MapLibre (raster-dem,
encoding "terrarium"). Land only: heights below sea level are set to 0 and tiles that are
all sea aren't written, so the globe's own surface is the sea. Heights are rounded to
whole metres; finer digits are noise that would double the size.

Source: ETOPO 2022 v1, 15", surface elevation (ice surface, not bedrock), from NOAA NCEI.
Not subject to copyright, and waived worldwide under CC0 1.0 (provenance/terms/noaa-etopo-2022-metadata.md).

Writes:
  data/source/etopo/<file>.tif                 the unmodified downloads, 288 files, 5.2 GB (gitignored)
  public/tiles/terrain/{z}/{x}/{y}.webp        zoom 0-8, land only (gitignored, reproducible)
  public/tiles/terrain/tiles.json              which tiles exist (the globe treats the rest as sea level)
  provenance/terrain.json                      sources + checksums, method, timings, tile digest
  public/tiles/terrain/PROVENANCE.json         a copy shipped with the tiles

  npm run build:terrain                 download (about 30 min, resumable) and build
  npm run build:terrain -- --fetch      download and verify only
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import datetime as dt
import hashlib
import json
import math
import multiprocessing as mp
import os
import platform
import re
import shutil
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = ROOT / "data" / "source" / "etopo"
OUT = ROOT / "public" / "tiles" / "terrain"
RECORD = ROOT / "provenance" / "terrain.json"
BASE = "https://www.ngdc.noaa.gov/mgg/global/relief/ETOPO2022/data/15s/15s_surface_elev_gtif/"
FILE_RE = re.compile(r"ETOPO_2022_v1_15s_[NS]\d\d[EW]\d\d\d_surface\.tif")
USER_AGENT = "blue-marble-globe/1.0"

MAX_ZOOM = 8   # 256 px at zoom 8 is ~611 m at the equator: as fine as the 450 m source supports
CHUNK_ZOOM = 4  # work in zoom-4 squares: 16 x 16 zoom-8 tiles, 4096 px, ~64 MB of heights each
HALF = 20037508.342789244
NODATA = -99999.0


# ---------------------------------------------------------------- download

def listing() -> list[str]:
    req = urllib.request.Request(BASE, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as r:
        names = sorted(set(FILE_RE.findall(r.read().decode())))
    if len(names) < 200:
        sys.exit(f"Expected 288 files in NOAA's listing, found {len(names)}: {BASE}")
    return names


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def remote_size(name: str) -> int:
    req = urllib.request.Request(BASE + name, method="HEAD", headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as r:
        return int(r.headers["Content-Length"])


def download(name: str, path: Path) -> dict:
    """Download to a .part file, check the byte count against the server's, then rename."""
    part = path.with_suffix(".part")
    for attempt in range(5):
        try:
            req = urllib.request.Request(BASE + name, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=120) as r, part.open("wb") as f:
                headers = {k.lower(): v for k, v in r.headers.items()}
                shutil.copyfileobj(r, f, 1 << 20)
            expected = int(headers.get("content-length", -1))
            got = part.stat().st_size
            if expected >= 0 and got != expected:  # the connection closed early, without an error
                raise OSError(f"got {got:,} of {expected:,} bytes")
            part.rename(path)
            return headers
        except OSError as e:
            if attempt == 4:
                raise
            print(f"  retry {name}: {e}", flush=True)
            time.sleep(2 * (attempt + 1))


def fetch_one(name: str, previous: dict | None) -> dict:
    path = SRC_DIR / name
    headers = {}
    # A file with no recorded checksum yet is only trusted if it's as long as the server's copy
    if path.exists() and not previous and path.stat().st_size != remote_size(name):
        print(f"  {name} is incomplete; downloading it again", flush=True)
        path.unlink()
    if not path.exists():
        headers = download(name, path)
    digest = sha256(path)
    if previous and previous["sha256"] != digest:
        sys.exit(f"CHECKSUM MISMATCH for {name}\n  recorded {previous['sha256']}\n  actual   {digest}\n"
                 f"Delete it and run again to re-download, or investigate the change at NOAA.")
    return previous or {
        "file": name, "bytes": path.stat().st_size, "sha256": digest,
        "http_etag": headers.get("etag"), "http_last_modified": headers.get("last-modified"),
        "retrieved_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def fetch_all(previous: dict) -> dict:
    SRC_DIR.mkdir(parents=True, exist_ok=True)
    names = listing()
    have = sum((SRC_DIR / n).exists() for n in names)
    print(f"ETOPO 2022 15\": {len(names)} files, {have} already downloaded", flush=True)
    sources, done, t = {}, 0, time.perf_counter()
    with cf.ThreadPoolExecutor(6) as pool:
        futures = {pool.submit(fetch_one, n, previous.get(n)): n for n in names}
        for f in cf.as_completed(futures):
            sources[futures[f]] = f.result()
            done += 1
            if done % 12 == 0 or done == len(names):
                mb = sum(s["bytes"] for s in sources.values()) / 1e6
                print(f"  {done}/{len(names)} files verified, {mb:,.0f} MB, {time.perf_counter() - t:.0f} s", flush=True)
    return dict(sorted(sources.items()))


# ---------------------------------------------------------------- tiles

def encode(h):
    """Heights (metres, already rounded) -> Terrarium RGB."""
    import numpy as np
    v = h.astype(np.int32) + 32768
    return np.stack([v >> 8, v & 255, np.zeros_like(v)]).astype(np.uint8)


def write_tile(h, z: int, x: int, y: int) -> int | None:
    """Write one tile unless it's all sea. Returns its size in bytes."""
    import numpy as np
    from osgeo import gdal
    h = np.rint(h)
    if not (h > 0).any():
        return None
    rgb = encode(h)
    mem = gdal.GetDriverByName("MEM").Create("", 256, 256, 3, gdal.GDT_Byte)
    for i in range(3):
        mem.GetRasterBand(i + 1).WriteArray(rgb[i])
    path = OUT / str(z) / str(x) / f"{y}.webp"
    path.parent.mkdir(parents=True, exist_ok=True)
    gdal.GetDriverByName("WEBP").CreateCopy(str(path), mem, options=["LOSSLESS=TRUE"])
    return path.stat().st_size


def halve(a):
    """2 x 2 average: the next zoom level out."""
    return (a[0::2, 0::2] + a[1::2, 0::2] + a[0::2, 1::2] + a[1::2, 1::2]) / 4


def horizontal(path):
    """The source's horizontal reference only. ETOPO declares "WGS 84 + EGM2008 height"; given
    that, GDAL converts the heights to the WGS84 ellipsoid on reprojection, adding the geoid
    height (+64 m in Iceland, -106 to +85 m worldwide). Heights must stay above sea level, as the
    globe and the regional terrain take them."""
    from osgeo import gdal
    srs = gdal.Open(path).GetSpatialRef().Clone()
    srs.StripVertical()
    return srs.ExportToWkt()


def chunk(args):
    """One zoom-4 square: reproject its heights once at zoom 8, then build zoom 8 down to 4."""
    import numpy as np
    from osgeo import gdal
    gdal.UseExceptions()
    vrt, cx, cy = args
    n = 2 ** (MAX_ZOOM - CHUNK_ZOOM)  # tiles per side at zoom 8
    size = 2 * HALF / 2 ** CHUNK_ZOOM
    bounds = (-HALF + cx * size, HALF - (cy + 1) * size, -HALF + (cx + 1) * size, HALF - cy * size)
    # Where a zoom-8 pixel is bigger than a source pixel (lower latitudes), average; elsewhere interpolate
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (cy + 0.5) / 2 ** CHUNK_ZOOM))))
    alg = "average" if 611.5 * math.cos(math.radians(lat)) > 463 else "bilinear"
    ds = gdal.Warp("", vrt, format="MEM", srcSRS=horizontal(vrt), dstSRS="EPSG:3857", outputBounds=bounds,
                   width=n * 256, height=n * 256, resampleAlg=alg, outputType=gdal.GDT_Float32,
                   srcNodata=NODATA, dstNodata=NODATA)
    h = ds.GetRasterBand(1).ReadAsArray()
    h = np.where(h == NODATA, 0, np.maximum(h, 0))  # land only: the sea (and below-sea-level land) at 0
    written, size_bytes = [], 0
    if (h > 0.5).any():
        for z in range(MAX_ZOOM, CHUNK_ZOOM - 1, -1):
            k = 2 ** (z - CHUNK_ZOOM)
            for j in range(k):
                for i in range(k):
                    b = write_tile(h[j * 256:(j + 1) * 256, i * 256:(i + 1) * 256], z, cx * k + i, cy * k + j)
                    if b:
                        written.append((z, cx * k + i, cy * k + j))
                        size_bytes += b
            if z > CHUNK_ZOOM:
                h = halve(h)
    else:
        h = np.zeros((256, 256), np.float32)
    return cx, cy, h.astype(np.float32), written, size_bytes, alg


def build(sources: dict) -> dict:
    import numpy as np
    from osgeo import gdal
    gdal.UseExceptions()
    shutil.rmtree(OUT, ignore_errors=True)
    OUT.mkdir(parents=True)
    timings = []

    t = time.perf_counter()
    vrt = str(SRC_DIR / "etopo.vrt")
    gdal.BuildVRT(vrt, [str(SRC_DIR / n) for n in sources])
    timings.append({"step": "mosaic (VRT)", "seconds": round(time.perf_counter() - t, 1)})

    # Zoom 8 to 4, one zoom-4 square per task, in parallel
    t = time.perf_counter()
    k4 = 2 ** CHUNK_ZOOM
    top = np.zeros((k4 * 256, k4 * 256), np.float32)  # zoom 4, mosaicked, for zooms 3 to 0
    tiles, size, algs = [], 0, {}
    jobs = [(vrt, cx, cy) for cy in range(k4) for cx in range(k4)]
    with mp.get_context("spawn").Pool(os.cpu_count() or 4) as pool:
        for done, (cx, cy, h4, written, b, alg) in enumerate(pool.imap_unordered(chunk, jobs), 1):
            top[cy * 256:(cy + 1) * 256, cx * 256:(cx + 1) * 256] = h4
            tiles += written
            size += b
            algs[alg] = algs.get(alg, 0) + 1
            if done % 16 == 0:
                print(f"  zoom {MAX_ZOOM}-{CHUNK_ZOOM}: {done}/{len(jobs)} squares, {len(tiles):,} tiles, "
                      f"{size / 1e6:,.0f} MB, {time.perf_counter() - t:.0f} s", flush=True)
    timings.append({"step": f"reproject + tile zoom {MAX_ZOOM}-{CHUNK_ZOOM}", "seconds": round(time.perf_counter() - t, 1)})

    # Zoom 3 to 0, from the zoom-4 mosaic
    t = time.perf_counter()
    for z in range(CHUNK_ZOOM - 1, -1, -1):
        top = halve(top)
        for y in range(2 ** z):
            for x in range(2 ** z):
                b = write_tile(top[y * 256:(y + 1) * 256, x * 256:(x + 1) * 256], z, x, y)
                if b:
                    tiles.append((z, x, y))
                    size += b
    timings.append({"step": f"tile zoom {CHUNK_ZOOM - 1}-0", "seconds": round(time.perf_counter() - t, 1)})
    Path(vrt).unlink(missing_ok=True)
    return {"timings": timings, "resampling": algs}


def index_and_digest() -> dict:
    idx, lines, size = {}, [], 0
    for p in sorted(OUT.rglob("*.webp")):
        z, x, y = p.relative_to(OUT).with_suffix("").parts
        idx.setdefault(z, {}).setdefault(x, []).append(int(y))
        b = p.read_bytes()
        size += len(b)
        lines.append(f"{p.relative_to(OUT).as_posix()} {hashlib.sha256(b).hexdigest()}")
    for xs in idx.values():
        for ys in xs.values():
            ys.sort()
    (OUT / "tiles.json").write_text(json.dumps({"zoom": [0, MAX_ZOOM], "tiles": idx}, separators=(",", ":")))
    return {"path": "public/tiles/terrain/{z}/{x}/{y}.webp", "zoom": [0, MAX_ZOOM], "tile_count": len(lines),
            "bytes": size, "tiles_sha256": hashlib.sha256("\n".join(lines).encode()).hexdigest()}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--fetch", action="store_true", help="download and verify the source files only")
    a = ap.parse_args()
    try:
        from osgeo import gdal
        import numpy  # noqa: F401
    except ImportError:
        sys.exit("Needs GDAL's Python bindings and numpy: run with .venv/bin/python (see README, Regions setup).")
    gdal.UseExceptions()
    if "WEBP" not in [gdal.GetDriver(i).ShortName for i in range(gdal.GetDriverCount())]:
        sys.exit("This GDAL has no WebP driver.")

    previous = json.loads(RECORD.read_text())["sources"]["files"] if RECORD.exists() else {}
    started = dt.datetime.now(dt.timezone.utc)
    t_all = time.perf_counter()
    t = time.perf_counter()
    files = fetch_all(previous)
    fetch_s = round(time.perf_counter() - t, 1)
    if a.fetch:
        print(f"All {len(files)} files present and verified ({fetch_s:.0f} s).")
        return

    print(f"\nBuilding zoom 0-{MAX_ZOOM} on {os.cpu_count()} processes ...", flush=True)
    result = build(files)
    output = index_and_digest()
    record = {
        "description": "Global terrain: NOAA ETOPO 2022 surface elevation as Terrarium-encoded elevation tiles, land only.",
        "licence": "Public domain. NOAA: 'not subject to copyright protection in the United States', and waived "
                   "worldwide under CC0 1.0. See provenance/terms/noaa-etopo-2022-metadata.md",
        "citation": "NOAA National Centers for Environmental Information. 2022: ETOPO 2022 15 Arc-Second Global "
                    "Relief Model. NOAA National Centers for Environmental Information. "
                    "https://doi.org/10.25921/fd45-gt74",
        "encoding": {
            "format": "Terrarium: height_m = R * 256 + G + B / 256 - 32768",
            "image": "256 x 256 WebP, lossless",
            "heights": "metres above mean sea level (ETOPO's EGM2008 geoid), rounded to whole metres, unchanged: the "
                       "reprojection uses ETOPO's horizontal reference only, so GDAL doesn't convert them to the "
                       "WGS84 ellipsoid. They sit on Cesium's ellipsoid relative to sea level (up to about 100 m "
                       "from true ellipsoid heights, depending on place).",
            "sea": "Heights below 0 are set to 0, including land below sea level (e.g. the Dead Sea shore, Death "
                   "Valley). Tiles with no height above 0 aren't written; tiles.json lists those that are.",
            "resampling": f"Reprojected once to the zoom-{MAX_ZOOM} Web Mercator grid ('average' where a grid cell is "
                          "larger than a source cell, otherwise 'bilinear'), then 2 x 2 averages for each zoom out.",
        },
        "sources": {
            "dataset": "ETOPO 2022 v1, 15 arc-second, surface elevation, GeoTIFF",
            "producer": "NOAA National Centers for Environmental Information (NCEI)",
            "doi": "10.25921/fd45-gt74",
            "url": BASE,
            "file_count": len(files),
            "bytes": sum(f["bytes"] for f in files.values()),
            "files": files,
        },
        "built_utc": started.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "environment": {"gdal": gdal.__version__, "numpy": numpy.__version__, "python": platform.python_version(),
                        "platform": platform.platform(), "processes": os.cpu_count()},
        "wall_clock_seconds": {"total": round(time.perf_counter() - t_all, 1),
                               "steps": [{"step": "download + verify", "seconds": fetch_s}] + result["timings"]},
        "resampling_squares": result["resampling"],
        "output": output,
    }
    RECORD.write_text(json.dumps(record, indent=2) + "\n")
    (OUT / "PROVENANCE.json").write_text(json.dumps(record, indent=2) + "\n")
    print(f"\n{output['tile_count']:,} tiles, {output['bytes'] / 1e6:,.0f} MB in {record['wall_clock_seconds']['total']:.0f} s")
    for s in record["wall_clock_seconds"]["steps"]:
        print(f"  {s['step']:<28} {s['seconds']:>8.1f} s")

    # The new layer on the map server's home page and catalog, if the server is set up
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from build_server import refresh
    refresh()


if __name__ == "__main__":
    main()
