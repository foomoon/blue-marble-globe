#!/usr/bin/env python3
"""
Build Web Mercator XYZ tiles from the NASA source files, and record exactly how.

Input:   data/source/bmng/*.tif   (fetched and checksummed by fetch_source.py)
Output:  public/tiles/blue-marble/{z}/{x}/{y}.jpg   (zoom 0-8)
Record:  provenance/build.json    tool versions, every command run, and a digest of
                                  every tile produced
         public/tiles/blue-marble/PROVENANCE.json   a copy shipped with the tiles

The pixels are only reprojected and resampled; nothing else is done to them.
There is no colour correction, no compositing with other data and no added labels.

  python3 scripts/build_tiles.py           build the tiles (overwrites existing ones),
                                           then delete the ~4 GB intermediate in data/work/
  python3 scripts/build_tiles.py --keep-work   keep data/work/ for inspection
  python3 scripts/build_tiles.py --verify  re-hash public/tiles and compare with build.json
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = ROOT / "data" / "source" / "bmng"
WORK = ROOT / "data" / "work"
OUT = ROOT / "public" / "tiles" / "blue-marble"
SOURCES = ROOT / "provenance" / "sources.json"
RECORD = ROOT / "provenance" / "build.json"

MAX_ZOOM = 8
JPEG_QUALITY = 85
# Web Mercator covers the world in 256 * 2^z pixels across at zoom z. Warping straight
# to the zoom-8 size means gdal2tiles slices at native resolution and never
# resamples a second time.
MERCATOR_PX = 256 * 2**MAX_ZOOM
MERCATOR_EXTENT = ["-20037508.342789244"] * 2 + ["20037508.342789244"] * 2

commands: list[list[str]] = []
timings: list[dict] = []


def run(step: str, cmd: list[str]) -> None:
    print("\n$ " + " ".join(cmd), flush=True)
    commands.append(cmd)
    t0 = time.perf_counter()
    subprocess.run(cmd, check=True)
    secs = round(time.perf_counter() - t0, 1)
    timings.append({"step": step, "seconds": secs})
    print(f"[{step}: {secs:.1f} s]", flush=True)


def tool(*names: str) -> str:
    for n in names:
        if shutil.which(n):
            return n
    sys.exit(f"Missing '{names[0]}'. Install GDAL (Ubuntu: sudo apt install gdal-bin python3-gdal; macOS: brew install gdal). npm run doctor checks everything.")


def tile_digest(root: Path) -> tuple[int, int, str]:
    """Return (count, bytes, sha256) over the sorted lines '<relpath> <sha256>' of every tile."""
    lines, total = [], 0
    for p in sorted(root.rglob("*.jpg")):
        data = p.read_bytes()
        total += len(data)
        lines.append(f"{p.relative_to(root).as_posix()} {hashlib.sha256(data).hexdigest()}")
    return len(lines), total, hashlib.sha256("\n".join(lines).encode()).hexdigest()


def verify() -> None:
    rec = json.loads(RECORD.read_text())["output"]
    count, size, digest = tile_digest(OUT)
    ok = (count, digest) == (rec["tile_count"], rec["tiles_sha256"])
    print(f"tiles   {count} (recorded {rec['tile_count']})")
    print(f"digest  {digest}\nrecord  {rec['tiles_sha256']}")
    print("OK: tiles match provenance/build.json" if ok else "MISMATCH")
    sys.exit(0 if ok else 1)


def jpeg_tiles_supported(gdal2tiles: str) -> bool:
    """Whether this gdal2tiles writes JPEG tiles (GDAL 3.9+). An unknown driver fails option
    parsing before --help is reached."""
    p = subprocess.run([gdal2tiles, "--tiledriver=JPEG", "--help"], capture_output=True, text=True)
    return p.returncode == 0


def _to_jpeg(path: str) -> None:
    from osgeo import gdal
    gdal.UseExceptions()
    gdal.SetConfigOption("GDAL_PAM_ENABLED", "NO")  # no .aux.xml beside each tile
    gdal.Translate(path[:-4] + ".jpg", path, format="JPEG", bandList=[1, 2, 3],
                   creationOptions=[f"QUALITY={JPEG_QUALITY}"])
    os.remove(path)


def png_tiles_to_jpeg(root: Path) -> int:
    """Convert gdal2tiles' PNG tiles (RGB + alpha) to RGB JPEG, in parallel."""
    from concurrent.futures import ProcessPoolExecutor
    try:
        from osgeo import gdal  # noqa: F401
    except ImportError:
        sys.exit("Converting tiles to JPEG needs GDAL's Python bindings (Ubuntu: sudo apt install python3-gdal).")
    files = [str(p) for p in root.rglob("*.png")]
    with ProcessPoolExecutor(os.cpu_count() or 4) as pool:
        for _ in pool.map(_to_jpeg, files, chunksize=256):
            pass
    return len(files)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--verify", action="store_true")
    ap.add_argument("--keep-work", action="store_true", help="keep the intermediate files in data/work/")
    args = ap.parse_args()
    if args.verify:
        return verify()

    if not SOURCES.exists():
        sys.exit("provenance/sources.json not found. Run scripts/fetch_source.py first.")
    sources = json.loads(SOURCES.read_text())
    inputs = [SRC_DIR / f["file"] for f in sources["files"]]  # recorded order: A1-D1, A2-D2
    missing = [p.name for p in inputs if not p.exists()]
    if missing:
        sys.exit(f"Missing source files {missing}. Run scripts/fetch_source.py.")

    gdal2tiles = tool("gdal2tiles", "gdal2tiles.py")
    for t in ("gdalbuildvrt", "gdalwarp", "gdaladdo"):
        tool(t)
    gdal_version = subprocess.run(
        ["gdalinfo", "--version"], capture_output=True, text=True, check=True
    ).stdout.strip()

    WORK.mkdir(parents=True, exist_ok=True)
    vrt = WORK / "bmng.vrt"
    merc = WORK / "bmng_3857.tif"
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    started = dt.datetime.now(dt.timezone.utc)
    t_start = time.perf_counter()

    # 1. Mosaic the 8 NASA tiles into one virtual raster (no pixels are copied)
    run("mosaic", ["gdalbuildvrt", "-overwrite", str(vrt), *map(str, inputs)])

    # 2. Reproject from geographic (EPSG:4326) to Web Mercator (EPSG:3857), cropping
    #    to the Mercator square (about ±85.05° latitude) at the exact zoom-8 pixel size
    run("reproject", [
        "gdalwarp", "-overwrite",
        "-t_srs", "EPSG:3857",
        "-te", *MERCATOR_EXTENT,
        "-ts", str(MERCATOR_PX), str(MERCATOR_PX),
        "-r", "bilinear",
        "-multi", "-wo", "NUM_THREADS=ALL_CPUS", "-wm", "2048",
        "-co", "TILED=YES", "-co", "COMPRESS=DEFLATE", "-co", "BIGTIFF=YES",
        str(vrt), str(merc),
    ])

    # 3. Overviews, so the lower zoom levels are averaged from the full-resolution image
    run("overviews", ["gdaladdo", "-r", "average", str(merc), "2", "4", "8", "16", "32", "64", "128", "256"])

    # 4. Slice into XYZ tiles: z/x/y with y counted from the top, the web convention.
    #    gdal2tiles writes JPEG from GDAL 3.9; before that (Ubuntu 24.04 has 3.8) it writes PNG,
    #    and each tile is then converted to JPEG at the same quality.
    direct = jpeg_tiles_supported(gdal2tiles)
    run("tile", [
        gdal2tiles,
        "--xyz", "-z", f"0-{MAX_ZOOM}", "-w", "none",
        f"--processes={os.cpu_count() or 4}",
        *(["--tiledriver=JPEG", f"--jpeg-quality={JPEG_QUALITY}"] if direct else ["--tiledriver=PNG"]),
        str(merc), str(OUT),
    ])
    if not direct:
        t0 = time.perf_counter()
        n = png_tiles_to_jpeg(OUT)
        commands.append(["(python)", f"convert each PNG tile to JPEG, quality {JPEG_QUALITY}, RGB ({n} tiles)"])
        timings.append({"step": "to JPEG", "seconds": round(time.perf_counter() - t0, 1)})

    t0 = time.perf_counter()
    count, size, digest = tile_digest(OUT)
    timings.append({"step": "hash tiles", "seconds": round(time.perf_counter() - t0, 1)})
    total = round(time.perf_counter() - t_start, 1)
    record = {
        "description": "Web Mercator XYZ tiles built from the NASA source files listed in sources.json.",
        "modifications": [
            "mosaic of the 8 source tiles",
            "reprojection EPSG:4326 -> EPSG:3857, bilinear resampling",
            "cropped to the Web Mercator extent (about ±85.05° latitude)",
            "downsampled to 65536 px square (zoom 8) and averaged overviews for zoom 0-7",
            f"JPEG encoding, quality {JPEG_QUALITY}"
            + ("" if direct else " (gdal2tiles wrote PNG, as this GDAL is older than 3.9; each tile converted)"),
        ],
        "not_modified": "no colour correction, no compositing with other data, no added labels",
        "built_utc": started.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "environment": {
            "gdal": gdal_version,
            "python": platform.python_version(),
            "platform": platform.platform(),
            "cpu_count": os.cpu_count(),
        },
        "wall_clock_seconds": {"total": total, "steps": timings},
        "inputs": [{"file": f["file"], "sha256": f["sha256"]} for f in sources["files"]],
        "sources_json_sha256": hashlib.sha256(SOURCES.read_bytes()).hexdigest(),
        "commands": [[os.path.relpath(a, ROOT) if a.startswith(str(ROOT)) else a for a in c] for c in commands],
        "output": {
            "path": "public/tiles/blue-marble/{z}/{x}/{y}.jpg",
            "zoom": [0, MAX_ZOOM],
            "tile_count": count,
            "bytes": size,
            "tiles_sha256": digest,
            "tiles_sha256_method": "sha256 of the sorted lines '<z/x/y.jpg> <sha256 of file>', joined by \\n",
        },
    }
    RECORD.write_text(json.dumps(record, indent=2, ensure_ascii=False) + "\n")
    shipped = {"sources": sources, "build": record}
    (OUT / "PROVENANCE.json").write_text(json.dumps(shipped, indent=2, ensure_ascii=False) + "\n")
    print("\nWall-clock time:")
    for t in timings:
        print(f"  {t['step']:<11} {t['seconds']:>8.1f} s")
    print(f"  {'total':<11} {total:>8.1f} s  ({total / 60:.1f} min)")
    print(f"\n{count} tiles, {size / 1e6:.0f} MB, digest {digest}")
    print(f"Recorded in {RECORD.relative_to(ROOT)}")

    # The intermediate is fully reproducible from data/source/; free the disk space
    if not args.keep_work:
        freed = sum(p.stat().st_size for p in WORK.rglob("*") if p.is_file())
        shutil.rmtree(WORK)
        print(f"Removed data/work/ ({freed / 1e9:.1f} GB). Use --keep-work to keep it.")


if __name__ == "__main__":
    main()
