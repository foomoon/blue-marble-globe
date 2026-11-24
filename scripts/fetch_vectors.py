#!/usr/bin/env python3
"""
Fetch the vector layers and record their provenance.

All from Natural Earth (public domain; terms archived in
provenance/terms/natural-earth-terms-of-use.md):

  country-borders  Admin 0 boundary lines (land), 1:50m, default ("de facto") edition
  us-states        Admin 1 state/province lines, 1:50m, filtered to the United States
  coastlines       Coastline, 1:50m

Writes:
  data/source/naturalearth/<zip>       the unmodified downloads (gitignored)
  public/vectors/<layer>.geojson       what the globe loads (small; committed)
  provenance/vectors.json              per layer: URL, SHA-256 of download and output,
                                       Natural Earth version, the exact conversion

As with the imagery: a download must match its recorded SHA-256, or the script stops.

  python3 scripts/fetch_vectors.py      (needs GDAL's ogr2ogr)
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = ROOT / "data" / "source" / "naturalearth"
OUT_DIR = ROOT / "public" / "vectors"
RECORD = ROOT / "provenance" / "vectors.json"
BASE = "https://naciscdn.org/naturalearth/50m"  # + /cultural or /physical

LAYERS = [
    {
        "name": "country-borders",
        "dataset": "Natural Earth, Admin 0 boundary lines (land), 1:50m",
        "category": "cultural",
        "source": "ne_50m_admin_0_boundary_lines_land",
        # Natural Earth's own class (FEATURECLA) gives the default de facto view. Anything not an
        # agreed international boundary is marked "disputed" and drawn dashed.
        "sql": """SELECT GEOMETRY, NAME AS name,
                    CASE WHEN FEATURECLA LIKE 'International boundary%' THEN 'international' ELSE 'disputed' END AS kind,
                    FEATURECLA AS natural_earth_class
                  FROM {src}""",
        "view": "Natural Earth default edition: de facto control. Disputed, indefinite and "
                "line-of-control segments are kept, marked kind=disputed, and drawn dashed.",
    },
    {
        "name": "us-states",
        "dataset": "Natural Earth, Admin 1 states/provinces lines, 1:50m (United States only)",
        "category": "cultural",
        "source": "ne_50m_admin_1_states_provinces_lines",
        "sql": "SELECT GEOMETRY, NAME AS name FROM {src} WHERE ADM0_A3 = 'USA'",
        "view": "Internal US state lines only; the outer US border is in country-borders.",
    },
    {
        "name": "coastlines",
        "dataset": "Natural Earth, Coastline, 1:50m",
        "category": "physical",
        "source": "ne_50m_coastline",
        "sql": "SELECT GEOMETRY FROM {src}",
        "view": "Coastlines of land masses and islands (lake shores are not included).",
    },
]


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_records() -> dict:
    if not RECORD.exists():
        return {}
    rec = json.loads(RECORD.read_text())
    if "layers" in rec:
        return rec["layers"]
    return {"country-borders": rec}  # the original single-layer format


def build(layer: dict, previous: dict | None) -> dict:
    src_name = layer["source"]
    zip_path = SRC_DIR / f"{src_name}.zip"
    url = f"{BASE}/{layer['category']}/{src_name}.zip"
    headers = {}
    if not zip_path.exists():
        print(f"GET  {url}")
        req = urllib.request.Request(url, headers={"User-Agent": "blue-marble-globe/1.0"})
        with urllib.request.urlopen(req, timeout=60) as r:
            zip_path.write_bytes(r.read())
            headers = {k.lower(): v for k, v in r.headers.items()}
    digest = sha256(zip_path)
    if previous and previous["source"]["sha256"] != digest:
        sys.exit(f"CHECKSUM MISMATCH for {zip_path.name}\n  recorded {previous['source']['sha256']}\n  actual   {digest}")
    with zipfile.ZipFile(zip_path) as z:
        version = z.read(f"{src_name}.VERSION.txt").decode().strip()

    out = OUT_DIR / f"{layer['name']}.geojson"
    out.unlink(missing_ok=True)
    cmd = ["ogr2ogr", "-f", "GeoJSON", "-a_srs", "EPSG:4326", "-lco", "RFC7946=YES", "-lco", "COORDINATE_PRECISION=15",
           "-dialect", "SQLite", "-sql", " ".join(layer["sql"].format(src=src_name).split()),
           str(out), f"/vsizip/{zip_path}/{src_name}.shp"]
    subprocess.run(cmd, check=True)

    feats = json.loads(out.read_text())["features"]
    empty = sum(1 for f in feats if not f.get("geometry"))
    if not feats or empty:
        out.unlink()
        sys.exit(f"{layer['name']}: {empty} of {len(feats)} features have no geometry; refusing to write it.")
    normalise(out, feats)

    print(f"{layer['name']}: {len(feats)} lines -> {out.relative_to(ROOT)} ({out.stat().st_size / 1e3:.0f} KB), Natural Earth {version}")
    return {
        "dataset": layer["dataset"],
        "publisher": "Natural Earth (naturalearthdata.com), supported by NACIS",
        "licence": "Public domain. See provenance/terms/natural-earth-terms-of-use.md",
        "natural_earth_version": version,
        "boundary_view": layer["view"],
        "source": previous["source"] if previous else {
            "url": url,
            "file": zip_path.name,
            "bytes": zip_path.stat().st_size,
            "sha256": digest,
            "http_etag": headers.get("etag"),
            "http_last_modified": headers.get("last-modified"),
            "retrieved_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        },
        "conversion": [a if not a.startswith(str(ROOT)) else str(Path(a).relative_to(ROOT)) for a in cmd],
        "post_processing": f"coordinates rounded to {DECIMALS} decimals (round half to even) and written in one fixed "
                           "layout by scripts/fetch_vectors.py, so the output is the same with any GDAL version",
        "output": {"path": str(out.relative_to(ROOT)), "features": len(feats),
                   "bytes": out.stat().st_size, "sha256": sha256(out)},
    }


DECIMALS = 4  # about 11 m: plenty at 1:50m


def rounded(c):
    """Coordinates to DECIMALS places, round half to even (+ 0.0 turns -0.0 into 0.0)."""
    return [rounded(v) for v in c] if isinstance(c, list) else round(c, DECIMALS) + 0.0


def normalise(path: Path, features: list) -> None:
    """Rewrite in one fixed form, so the bytes (and the checksum in provenance/vectors.json)
    don't depend on the GDAL version. ogr2ogr writes full precision and this rounds: GDAL 3.8
    (Ubuntu 24.04) and 3.13 round exact halves differently (117.40625 -> .4063 or .4062), pad
    differently, and newer versions add a top-level "xy_coordinate_resolution". One feature per
    line, so a changed line in git means a changed feature."""
    for f in features:
        f["geometry"]["coordinates"] = rounded(f["geometry"]["coordinates"])
    lines = [json.dumps(f, separators=(",", ":"), ensure_ascii=False) for f in features]
    path.write_text('{"type":"FeatureCollection","features":[\n' + ",\n".join(lines) + "\n]}\n", encoding="utf-8")


def main() -> None:
    if not shutil.which("ogr2ogr"):
        sys.exit("Missing ogr2ogr. Install GDAL (Ubuntu: sudo apt install gdal-bin python3-gdal; macOS: brew install gdal). npm run doctor checks everything.")
    SRC_DIR.mkdir(parents=True, exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    records = load_records()
    layers = {layer["name"]: build(layer, records.get(layer["name"])) for layer in LAYERS}
    RECORD.write_text(json.dumps({"layers": layers}, indent=2) + "\n")

    # The new layer on the map server's home page and catalog, if the server is set up
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from build_server import refresh
    refresh()

if __name__ == "__main__":
    main()
