#!/usr/bin/env python3
"""
Build all the map data, in order, in the map server's builder container (or anywhere with GDAL,
Python and numpy):

  npm run maps                       everything not built yet (the usual way: runs in Docker)
  npm run maps -- --only grey        one step (or several: --only tiles,terrain)
  npm run maps -- --force            rebuild even what's already built
  npm run maps -- --list             the steps, and which are built

Steps, in order:
  vectors   borders, states, coastlines (Natural Earth)          already in the repo: skipped
  tiles     Blue Marble: download NASA's files (~3 GB), build the WebP tiles
  grey      the Grey base map
  terrain   global terrain: download NOAA ETOPO (~5 GB), build the tiles
  catalog   the map server's catalog and TileJSON (always runs, takes a second)

A step counts as built when its PROVENANCE.json (or its files, for vectors) exists. Downloads are
kept in data/source/ and checked against their recorded checksums, so a re-run doesn't fetch again.
Standard library only; each step is its own script.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
S = "scripts/"
VECTORS = ["coastlines", "country-borders", "us-states"]

# name, what, commands, "built" check
STEPS = [
    ("vectors", "borders, states and coastlines", [[S + "fetch_vectors.py"]],
     lambda: all((ROOT / f"public/vectors/{v}.geojson").exists() for v in VECTORS)),
    ("tiles", "Blue Marble (downloads ~3 GB from NASA)", [[S + "fetch_source.py"], [S + "build_tiles.py"]],
     lambda: (ROOT / "public/tiles/blue-marble-webp/PROVENANCE.json").exists()),
    ("grey", "the Grey base map", [[S + "build_grey.py"]],
     lambda: (ROOT / "public/tiles/grey/PROVENANCE.json").exists()),
    ("terrain", "global terrain (downloads ~5 GB from NOAA)", [[S + "build_terrain.py"]],
     lambda: (ROOT / "public/tiles/terrain/PROVENANCE.json").exists()),
    ("catalog", "the map server's catalog", [[S + "build_server.py"]], lambda: False),
]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--only", help="comma-separated steps: " + ",".join(s[0] for s in STEPS))
    ap.add_argument("--force", action="store_true", help="rebuild steps that are already built")
    ap.add_argument("--list", action="store_true", help="list the steps and whether each is built")
    a = ap.parse_args()

    names = [s[0] for s in STEPS]
    only = a.only.split(",") if a.only else names
    unknown = [n for n in only if n not in names]
    if unknown:
        sys.exit(f"unknown step(s): {', '.join(unknown)} (steps: {', '.join(names)})")

    if a.list:
        for name, what, _, built in STEPS:
            print(f"  {name:<8} {'built' if built() else '-':<6} {what}")
        return

    t_all, done = time.monotonic(), []
    for name, what, commands, built in STEPS:
        if name not in only:
            continue
        if built() and not a.force:
            print(f"== {name}: already built, skipping (--force to rebuild)", flush=True)
            continue
        print(f"== {name}: {what}", flush=True)
        t0 = time.monotonic()
        for cmd in commands:
            r = subprocess.run([sys.executable, "-I", *cmd], cwd=ROOT)
            if r.returncode:
                sys.exit(f"== {name} failed ({' '.join(cmd)} exited {r.returncode}). "
                         f"Fix the cause, then run again: finished steps are skipped.")
        done.append(f"{name} {time.monotonic() - t0:,.0f} s")
        print(f"== {name}: done in {time.monotonic() - t0:,.0f} s", flush=True)
    print(f"== all done in {time.monotonic() - t_all:,.0f} s" + (f" ({', '.join(done)})" if done else ""))


if __name__ == "__main__":
    main()
