#!/usr/bin/env python3
"""
Build Web Mercator XYZ tiles from the NASA source files, and record exactly how.

Input:   data/source/bmng/*.tif   (fetched and checksummed by fetch_source.py)
Output:  public/tiles/blue-marble-webp/{z}/{x}/{y}.webp  WebP, quality 80 (the default)
         public/tiles/blue-marble/{z}/{x}/{y}.jpg        JPEG, quality 85 (--format jpeg or both)
         zoom 0-8
Record:  provenance/build.json    tool versions, every command run, a digest of every tile,
                                  and a performance profile of the run
         PROVENANCE.json beside each set of tiles, a copy shipped with them

The pixels are only reprojected and resampled; nothing else is done to them.
There is no colour correction, no compositing with other data and no added labels.

  python3 scripts/build_tiles.py                 WebP tiles (overwrites existing ones), then
                                                 delete the ~4 GB intermediate in data/work/
  python3 scripts/build_tiles.py --format jpeg   JPEG instead, for clients older than ~2020
  python3 scripts/build_tiles.py --format both   both, from one reprojection
  python3 scripts/build_tiles.py --keep-work     keep data/work/ for inspection
  python3 scripts/build_tiles.py --verify        re-hash the tiles and compare with build.json
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import platform
import resource
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = ROOT / "data" / "source" / "bmng"
WORK = ROOT / "data" / "work"
SOURCES = ROOT / "provenance" / "sources.json"
RECORD = ROOT / "provenance" / "build.json"

MAX_ZOOM = 8
JPEG_QUALITY = 85
# WebP 80 is about half the size of JPEG 85. Measured against the full-resolution image it scores
# slightly lower (SSIM 0.984 vs 0.991: a touch smoother on open sea); side by side, no visible
# difference. WebP 88 would match JPEG's quality at 76% of its size.
WEBP_QUALITY = 80
FORMATS = {
    "jpeg": {"ext": "jpg", "out": ROOT / "public" / "tiles" / "blue-marble", "record": "output"},
    "webp": {"ext": "webp", "out": ROOT / "public" / "tiles" / "blue-marble-webp", "record": "output_webp"},
}
# Web Mercator covers the world in 256 * 2^z pixels across at zoom z. Warping straight
# to the zoom-8 size means gdal2tiles slices at native resolution and never
# resamples a second time.
MERCATOR_PX = 256 * 2**MAX_ZOOM
MERCATOR_EXTENT = ["-20037508.342789244"] * 2 + ["20037508.342789244"] * 2
RSS_UNIT = 1 if platform.system() == "Darwin" else 1024  # ru_maxrss: bytes on macOS, KiB on Linux

commands: list[list[str]] = []
profile: list[dict] = []


# ---------------------------------------------------------------- running and profiling

def run(step: str, cmd: list[str], **extra) -> dict:
    """Run one command and profile it: wall time, CPU time and peak memory of that process
    (and the processes it waited for), from the kernel's own accounting (wait4)."""
    print("\n$ " + " ".join(cmd), flush=True)
    commands.append(cmd)
    t0 = time.perf_counter()
    proc = subprocess.Popen(cmd)
    _, status, ru = os.wait4(proc.pid, 0)
    proc.returncode = os.waitstatus_to_exitcode(status)
    wall = time.perf_counter() - t0
    if proc.returncode:
        raise subprocess.CalledProcessError(proc.returncode, cmd)
    entry = record_step(step, wall, ru.ru_utime + ru.ru_stime, ru.ru_maxrss * RSS_UNIT, **extra)
    print(f"[{step}: {wall:.1f} s, {entry['cpu_seconds']:.0f} s CPU, peak {entry['peak_memory_mb']:,.0f} MB]", flush=True)
    return entry


def run_python(step: str, fn, **extra):
    """Profile work done in this process (and any worker processes it starts)."""
    s0, c0 = resource.getrusage(resource.RUSAGE_SELF), resource.getrusage(resource.RUSAGE_CHILDREN)
    t0 = time.perf_counter()
    result = fn()
    wall = time.perf_counter() - t0
    s1, c1 = resource.getrusage(resource.RUSAGE_SELF), resource.getrusage(resource.RUSAGE_CHILDREN)
    cpu = (s1.ru_utime - s0.ru_utime + s1.ru_stime - s0.ru_stime) + (c1.ru_utime - c0.ru_utime + c1.ru_stime - c0.ru_stime)
    # Peak memory: the kernel only keeps running maxima here, so count workers' peak only if it
    # rose during this step (otherwise it's an earlier command's), else this process's own
    peak = c1.ru_maxrss if c1.ru_maxrss > c0.ru_maxrss else s1.ru_maxrss
    record_step(step, wall, cpu, peak * RSS_UNIT, **extra)
    return result


def record_step(step, wall, cpu, peak, **extra) -> dict:
    cores = os.cpu_count() or 1
    entry = {"step": step, "wall_seconds": round(wall, 1), "cpu_seconds": round(cpu, 1),
             "cores_busy": round(cpu / wall, 1) if wall else 0,
             "cpu_utilisation": f"{min(1, cpu / wall / cores):.0%}" if wall else "0%",
             "peak_memory_mb": round(peak / 1e6), **extra}
    profile.append(entry)
    return entry


def du(path: Path) -> int:
    if path.is_file():
        return path.stat().st_size
    return sum(p.stat().st_size for p in path.rglob("*") if p.is_file()) if path.exists() else 0


def system_info() -> dict:
    info = {"os": platform.platform(), "machine": platform.machine(), "cpu_count": os.cpu_count(),
            "python": platform.python_version()}
    try:
        if platform.system() == "Darwin":
            info["cpu"] = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True).stdout.strip()
            info["memory_gb"] = round(int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True).stdout) / 1e9, 1)
        else:
            cpu = [ln.split(":", 1)[1].strip() for ln in Path("/proc/cpuinfo").read_text().splitlines()
                   if ln.lower().startswith(("model name", "hardware"))]
            info["cpu"] = cpu[0] if cpu else platform.processor()
            mem = [ln for ln in Path("/proc/meminfo").read_text().splitlines() if ln.startswith("MemTotal")]
            info["memory_gb"] = round(int(mem[0].split()[1]) * 1024 / 1e9, 1) if mem else None
    except (OSError, ValueError, IndexError):
        pass
    info["disk_free_gb"] = round(shutil.disk_usage(ROOT).free / 1e9)
    return info


# ---------------------------------------------------------------- tiles

def tool(*names: str) -> str:
    for n in names:
        if shutil.which(n):
            return n
    sys.exit(f"Missing '{names[0]}'. Install GDAL (Ubuntu: sudo apt install gdal-bin python3-gdal; macOS: brew install gdal). npm run doctor checks everything.")


def tile_digest(root: Path, ext: str) -> tuple[int, int, str]:
    """Return (count, bytes, sha256) over the sorted lines '<relpath> <sha256>' of every tile."""
    lines, total = [], 0
    for p in sorted(root.rglob(f"*.{ext}")):
        data = p.read_bytes()
        total += len(data)
        lines.append(f"{p.relative_to(root).as_posix()} {hashlib.sha256(data).hexdigest()}")
    return len(lines), total, hashlib.sha256("\n".join(lines).encode()).hexdigest()


def verify() -> None:
    record = json.loads(RECORD.read_text())
    ok_all = True
    for fmt, f in FORMATS.items():
        rec = record.get(f["record"])
        if not rec or not f["out"].exists():
            continue
        count, size, digest = tile_digest(f["out"], f["ext"])
        ok = (count, digest) == (rec["tile_count"], rec["tiles_sha256"])
        ok_all &= ok
        print(f"{fmt}: tiles {count} (recorded {rec['tile_count']})\n  digest {digest}\n  record {rec['tiles_sha256']}")
        print(f"  {'OK' if ok else 'MISMATCH'}")
    print("OK: tiles match provenance/build.json" if ok_all else "MISMATCH")
    sys.exit(0 if ok_all else 1)


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


def make_tiles(fmt: str, gdal2tiles: str, merc: Path) -> tuple[dict, str]:
    """Tile the intermediate in one format. Returns its output record and an encoding note."""
    out, ext = FORMATS[fmt]["out"], FORMATS[fmt]["ext"]
    if out.exists():
        shutil.rmtree(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    base = [gdal2tiles, "--xyz", "-z", f"0-{MAX_ZOOM}", "-w", "none", f"--processes={os.cpu_count() or 4}"]
    first = len(profile)  # this format's tiling steps start here
    if fmt == "webp":
        # WebP tiles: GDAL 3.6+, so this works directly on Ubuntu 24.04's GDAL 3.8 too
        run("tile (WebP)", base + ["--tiledriver=WEBP", f"--webp-quality={WEBP_QUALITY}", str(merc), str(out)])
        note = f"WebP encoding (lossy), quality {WEBP_QUALITY}"
    elif jpeg_tiles_supported(gdal2tiles):
        run("tile (JPEG)", base + ["--tiledriver=JPEG", f"--jpeg-quality={JPEG_QUALITY}", str(merc), str(out)])
        note = f"JPEG encoding, quality {JPEG_QUALITY}"
    else:
        # gdal2tiles writes JPEG from GDAL 3.9; before that (Ubuntu 24.04 has 3.8) it writes PNG,
        # and each tile is then converted to JPEG at the same quality
        run("tile (PNG, for JPEG)", base + ["--tiledriver=PNG", str(merc), str(out)])
        n = run_python("PNG -> JPEG", lambda: png_tiles_to_jpeg(out))
        commands.append(["(python)", f"convert each PNG tile to JPEG, quality {JPEG_QUALITY}, RGB ({n} tiles)"])
        note = (f"JPEG encoding, quality {JPEG_QUALITY} (gdal2tiles wrote PNG, as this GDAL is older "
                "than 3.9; each tile converted)")
    seconds = sum(p["wall_seconds"] for p in profile[first:])  # tiling, plus any conversion
    count, size, digest = run_python(f"hash tiles ({fmt})", lambda: tile_digest(out, ext))
    profile[first].update({"tiles": count, "tiles_mb": round(size / 1e6, 1),
                           "tiles_per_second": round(count / seconds) if seconds else None})
    return {
        "path": f"{out.relative_to(ROOT).as_posix()}/{{z}}/{{x}}/{{y}}.{ext}",
        "zoom": [0, MAX_ZOOM],
        "tile_count": count,
        "bytes": size,
        "bytes_on_disk_note": "data bytes; small files each take at least one disk block",
        "tiles_sha256": digest,
        "tiles_sha256_method": f"sha256 of the sorted lines '<z/x/y.{ext}> <sha256 of file>', joined by \\n",
    }, note


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--verify", action="store_true")
    ap.add_argument("--keep-work", action="store_true", help="keep the intermediate files in data/work/")
    ap.add_argument("--format", choices=["jpeg", "webp", "both"], default="webp",
                    help="tile format(s): webp (default, about half the size), jpeg, or both from one reprojection")
    args = ap.parse_args()
    if args.verify:
        return verify()
    formats = ["jpeg", "webp"] if args.format == "both" else [args.format]

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
    started = dt.datetime.now(dt.timezone.utc)
    t_start = time.perf_counter()
    source_bytes = sum(p.stat().st_size for p in inputs)

    # 1. Mosaic the 8 NASA tiles into one virtual raster (no pixels are copied)
    run("mosaic", ["gdalbuildvrt", "-overwrite", str(vrt), *map(str, inputs)])

    # 2. Reproject from geographic (EPSG:4326) to Web Mercator (EPSG:3857), cropping
    #    to the Mercator square (about ±85.05° latitude) at the exact zoom-8 pixel size
    e = run("reproject", [
        "gdalwarp", "-overwrite",
        "-t_srs", "EPSG:3857",
        "-te", *MERCATOR_EXTENT,
        "-ts", str(MERCATOR_PX), str(MERCATOR_PX),
        "-r", "bilinear",
        "-multi", "-wo", "NUM_THREADS=ALL_CPUS", "-wm", "2048",
        "-co", "TILED=YES", "-co", "COMPRESS=DEFLATE", "-co", "BIGTIFF=YES",
        str(vrt), str(merc),
    ])
    e.update({"input_mb": round(source_bytes / 1e6), "output_mb": round(du(merc) / 1e6),
              "megapixels_per_second": round(MERCATOR_PX**2 / 1e6 / e["wall_seconds"], 1)})

    # 3. Overviews, so the lower zoom levels are averaged from the full-resolution image
    before = du(merc)
    e = run("overviews", ["gdaladdo", "-r", "average", str(merc), "2", "4", "8", "16", "32", "64", "128", "256"])
    e.update({"added_mb": round((du(merc) - before) / 1e6), "intermediate_mb": round(du(merc) / 1e6)})

    # 4. Slice into XYZ tiles, z/x/y with y counted from the top (the web convention), in each format
    outputs, notes = {}, {}
    for fmt in formats:
        outputs[fmt], notes[fmt] = make_tiles(fmt, gdal2tiles, merc)

    total = round(time.perf_counter() - t_start, 1)
    previous = json.loads(RECORD.read_text()) if RECORD.exists() else {}
    dl = SRC_DIR / "download-profile.json"
    record = {
        "description": "Web Mercator XYZ tiles built from the NASA source files listed in sources.json.",
        "modifications": [
            "mosaic of the 8 source tiles",
            "reprojection EPSG:4326 -> EPSG:3857, bilinear resampling",
            "cropped to the Web Mercator extent (about ±85.05° latitude)",
            "downsampled to 65536 px square (zoom 8) and averaged overviews for zoom 0-7",
            *(notes[f] for f in formats),
        ],
        "not_modified": "no colour correction, no compositing with other data, no added labels",
        "built_utc": started.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "formats": formats,
        "environment": {"gdal": gdal_version, **system_info()},
        "wall_clock_seconds": {"total": total,
                               "steps": [{"step": p["step"], "seconds": p["wall_seconds"]} for p in profile]},
        "profile": {
            "note": "per step: wall time, CPU time (all cores), cores kept busy on average, and peak memory "
                    "of the process doing the work (from the kernel's accounting)",
            "download": json.loads(dl.read_text()) if dl.exists() else None,
            "steps": profile,
        },
        "inputs": [{"file": f["file"], "sha256": f["sha256"]} for f in sources["files"]],
        "sources_json_sha256": hashlib.sha256(SOURCES.read_bytes()).hexdigest(),
        "commands": [[os.path.relpath(a, ROOT) if a.startswith(str(ROOT)) else a for a in c] for c in commands],
    }
    # Each format's output record; a format not built this time keeps its previous record
    for fmt, f in FORMATS.items():
        if fmt in outputs:
            record[f["record"]] = outputs[fmt]
        elif previous.get(f["record"]) and f["out"].exists():
            record[f["record"]] = previous[f["record"]]
    RECORD.write_text(json.dumps(record, indent=2, ensure_ascii=False) + "\n")
    shipped = {"sources": sources, "build": record}
    for fmt in formats:
        (FORMATS[fmt]["out"] / "PROVENANCE.json").write_text(json.dumps(shipped, indent=2, ensure_ascii=False) + "\n")

    # The profile, as a table
    print(f"\nPerformance profile ({record['environment'].get('cpu', '?')}, {os.cpu_count()} cores, "
          f"{record['environment'].get('memory_gb', '?')} GB):")
    print(f"  {'step':<22} {'wall':>8} {'CPU':>9} {'cores':>6} {'peak mem':>9}  output")
    for p in profile:
        out = ", ".join(f"{k.replace('_', ' ')} {v:,}" if isinstance(v, (int, float)) else f"{k} {v}"
                        for k, v in p.items() if k not in ("step", "wall_seconds", "cpu_seconds", "cores_busy",
                                                            "cpu_utilisation", "peak_memory_mb"))
        print(f"  {p['step']:<22} {p['wall_seconds']:>7.1f}s {p['cpu_seconds']:>8.0f}s {p['cores_busy']:>6.1f} "
              f"{p['peak_memory_mb']:>7,} MB  {out}")
    print(f"  {'total':<22} {total:>7.1f}s  ({total / 60:.1f} min)")
    for fmt in formats:
        o = outputs[fmt]
        print(f"\n{fmt}: {o['tile_count']} tiles, {o['bytes'] / 1e6:.0f} MB, digest {o['tiles_sha256']}")
    print(f"Recorded in {RECORD.relative_to(ROOT)}")

    # The intermediate is fully reproducible from data/source/; free the disk space
    if not args.keep_work:
        freed = du(WORK)
        shutil.rmtree(WORK)
        print(f"Removed data/work/ ({freed / 1e9:.1f} GB). Use --keep-work to keep it.")


if __name__ == "__main__":
    main()
