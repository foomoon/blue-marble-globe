#!/usr/bin/env python3
"""
Build the "Grey" base map: flat light-grey land, transparent water.

The ocean colour isn't in the tiles: the globe's base colour shows through wherever
there's no land, so ocean tiles never need to exist (that's what keeps this small).

Source: Natural Earth 1:10m land and lakes (public domain; terms archived in
provenance/terms/natural-earth-terms-of-use.md).

Writes:
  data/source/naturalearth/<zip>              the unmodified downloads (gitignored)
  public/tiles/grey/{z}/{x}/{y}.png            zoom 0-9, land only (gitignored, reproducible)
  public/tiles/grey/tiles.json                 which tiles exist (the globe skips the rest)
  provenance/grey.json                         sources + checksums, commands, timings, tile digest
  public/tiles/grey/PROVENANCE.json            a copy shipped with the tiles

  python3 scripts/build_grey.py              (needs GDAL)
  python3 scripts/build_grey.py --reindex    only rewrite tiles.json from the tiles already built
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = ROOT / "data" / "source" / "naturalearth"
WORK = ROOT / "data" / "work" / "grey"
OUT = ROOT / "public" / "tiles" / "grey"
RECORD = ROOT / "provenance" / "grey.json"
BASE = "https://naciscdn.org/naturalearth/10m/physical"
SOURCES = ["ne_10m_land", "ne_10m_lakes"]

LAND_GREY = 214  # #d6d6d6
MAX_ZOOM = 9
R = 20037508.342789244
PX = 256 * 2**MAX_ZOOM  # the zoom-9 grid, so tiles are cut at native resolution

commands, timings = [], []


def run(step, cmd):
    print("\n$ " + " ".join(cmd), flush=True)
    commands.append([a if not a.startswith(str(ROOT)) else os.path.relpath(a, ROOT) for a in cmd])
    t = time.perf_counter()
    subprocess.run(cmd, check=True)
    timings.append({"step": step, "seconds": round(time.perf_counter() - t, 1)})


def fetch(name, previous):
    path = SRC_DIR / f"{name}.zip"
    url = f"{BASE}/{name}.zip"
    headers = {}
    if not path.exists():
        print(f"GET  {url}")
        req = urllib.request.Request(url, headers={"User-Agent": "blue-marble-globe/1.0"})
        with urllib.request.urlopen(req, timeout=120) as r:
            path.write_bytes(r.read())
            headers = {k.lower(): v for k, v in r.headers.items()}
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if previous and previous["sha256"] != digest:
        sys.exit(f"CHECKSUM MISMATCH for {path.name}\n  recorded {previous['sha256']}\n  actual   {digest}")
    with zipfile.ZipFile(path) as z:
        version = z.read(f"{name}.VERSION.txt").decode().strip()
    return path, previous or {
        "url": url, "file": path.name, "bytes": path.stat().st_size, "sha256": digest,
        "natural_earth_version": version,
        "http_etag": headers.get("etag"), "http_last_modified": headers.get("last-modified"),
        "retrieved_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def write_index() -> tuple[list[str], int]:
    """tiles.json: which tiles exist, so the globe never requests one that doesn't, and which are
    identical, so it downloads each repeated tile once ("same": a representative tile, then the
    tiles that are copies of it, listed like "tiles"). Returns the digest lines and total bytes."""
    by_hash, lines, size = {}, [], 0
    for p in sorted(OUT.rglob("*.png")):
        b = p.read_bytes()
        size += len(b)
        digest = hashlib.sha256(b).hexdigest()
        by_hash.setdefault(digest, []).append(p.relative_to(OUT).with_suffix("").parts)
        lines.append(f"{p.relative_to(OUT).as_posix()} {digest}")
    tiles, same = {}, {}
    for group in by_hash.values():
        z, x, y = group[0]
        tiles.setdefault(z, {}).setdefault(x, []).append(int(y))  # each distinct tile once
        if len(group) > 1:
            copies = same.setdefault(f"{z}/{x}/{y}", {})
            for z2, x2, y2 in group[1:]:
                copies.setdefault(z2, {}).setdefault(x2, []).append(int(y2))
    for xs in [*tiles.values(), *(c for copies in same.values() for c in copies.values())]:
        for ys in xs.values():
            ys.sort()
    (OUT / "tiles.json").write_text(json.dumps({"zoom": [0, MAX_ZOOM], "tiles": tiles, "same": same},
                                               separators=(",", ":")))
    return lines, size


def main():
    if sys.argv[1:] == ["--reindex"]:  # rewrite tiles.json from the tiles already built
        lines, _ = write_index()
        return print(f"wrote {(OUT / 'tiles.json').relative_to(ROOT)} ({len(lines):,} tiles)")
    for tool in ("ogr2ogr", "gdal_rasterize", "gdaladdo"):
        if not shutil.which(tool):
            sys.exit(f"Missing {tool}. Install GDAL (Ubuntu: sudo apt install gdal-bin python3-gdal; macOS: brew install gdal). npm run doctor checks everything.")
    gdal2tiles = shutil.which("gdal2tiles") or shutil.which("gdal2tiles.py")
    previous = json.loads(RECORD.read_text())["sources"] if RECORD.exists() else {}

    SRC_DIR.mkdir(parents=True, exist_ok=True)
    shutil.rmtree(WORK, ignore_errors=True)
    WORK.mkdir(parents=True)
    t_all = time.perf_counter()
    started = dt.datetime.now(dt.timezone.utc)

    paths, sources = {}, {}
    for name in SOURCES:
        paths[name], sources[name] = fetch(name, previous.get(name))

    mask = WORK / "land_3857.tif"
    extent = [str(-R), str(-R), str(R), str(R)]
    merc = {}
    # 1. Reproject land and lakes to Web Mercator, clipped to its ±85.05° limit
    #    (gdal_rasterize can't reproject on the fly)
    for name in SOURCES:
        merc[name] = WORK / f"{name}_3857.gpkg"
        run(f"reproject {name.split('_')[-1]}", [
            "ogr2ogr", "-f", "GPKG", "-t_srs", "EPSG:3857",
            "-clipsrc", "-180", "-85.05112878", "180", "85.05112878",
            str(merc[name]), f"/vsizip/{paths[name]}/{name}.shp",
        ])
    # 2. Land: one band on the zoom-9 grid; land = grey, everything else 0 (nodata = transparent)
    run("rasterize land", [
        "gdal_rasterize", "-burn", str(LAND_GREY), "-init", "0", "-a_nodata", "0", "-ot", "Byte",
        "-te", *extent, "-ts", str(PX), str(PX),
        "-co", "TILED=YES", "-co", "COMPRESS=DEFLATE", "-co", "BIGTIFF=YES",
        str(merc["ne_10m_land"]), str(mask),
    ])
    # Lakes: burn back to 0, so they take the ocean colour too
    run("rasterize lakes", ["gdal_rasterize", "-burn", "0", str(merc["ne_10m_lakes"]), str(mask)])
    # 3. Overviews (lower zooms averaged from full resolution)
    run("overviews", ["gdaladdo", "-r", "average", str(mask), "2", "4", "8", "16", "32", "64", "128", "256", "512"])
    # 4. Tiles: land only. Fully transparent (all-water) tiles are skipped
    shutil.rmtree(OUT, ignore_errors=True)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    run("tile", [gdal2tiles, "--xyz", "-z", f"0-{MAX_ZOOM}", "-w", "none", "--exclude",
                 f"--processes={os.cpu_count() or 4}", str(mask), str(OUT)])

    # Most zoom-9 tiles are the same solid grey square inland: store identical tiles once (hard
    # links), so each costs a directory entry, not a ~4 KB disk block. Paths and contents unchanged.
    t = time.perf_counter()
    sys.path.insert(0, str(Path(__file__).parent))
    from dedupe_tiles import dedupe
    deduped = dedupe(OUT)
    timings.append({"step": "dedupe", "seconds": round(time.perf_counter() - t, 1)})
    print(f"dedupe: {deduped['files']:,} tiles, {deduped['unique']:,} distinct; "
          f"on disk {deduped['disk_before'] / 1e6:,.0f} MB -> {deduped['disk_after'] / 1e6:,.0f} MB")

    # tiles.json + digest
    lines, size = write_index()

    gdal_version = subprocess.run(["gdalinfo", "--version"], capture_output=True, text=True).stdout.strip()
    record = {
        "description": "Grey base map: Natural Earth 1:10m land as light grey, water transparent "
                       "(the globe's base colour supplies the ocean).",
        "licence": "Public domain (Natural Earth). See provenance/terms/natural-earth-terms-of-use.md",
        "colours": {"land": f"#{LAND_GREY:02x}" * 3, "ocean_and_lakes": "transparent (globe base colour #3b3f45)"},
        "sources": sources,
        "commands": commands,
        "built_utc": started.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "environment": {"gdal": gdal_version, "python": platform.python_version(), "platform": platform.platform()},
        "wall_clock_seconds": {"total": round(time.perf_counter() - t_all, 1), "steps": timings},
        "deduplication": {"method": "identical tiles hard-linked to one copy (scripts/dedupe_tiles.py)",
                          "distinct_tiles": deduped["unique"], "disk_mb_before": round(deduped["disk_before"] / 1e6),
                          "disk_mb_after": round(deduped["disk_after"] / 1e6)},
        "output": {"path": "public/tiles/grey/{z}/{x}/{y}.png", "zoom": [0, MAX_ZOOM], "tile_count": len(lines),
                   "bytes": size, "tiles_sha256": hashlib.sha256("\n".join(lines).encode()).hexdigest()},
    }
    RECORD.write_text(json.dumps(record, indent=2) + "\n")
    (OUT / "PROVENANCE.json").write_text(json.dumps(record, indent=2) + "\n")
    shutil.rmtree(WORK, ignore_errors=True)
    print(f"\n{len(lines):,} tiles, {size / 1e6:.0f} MB in {record['wall_clock_seconds']['total']:.0f} s")
    for t in timings:
        print(f"  {t['step']:<16} {t['seconds']:>7.1f} s")


if __name__ == "__main__":
    main()
