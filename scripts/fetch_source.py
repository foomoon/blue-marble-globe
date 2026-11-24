#!/usr/bin/env python3
"""
Download the NASA Blue Marble Next Generation source imagery and record its provenance.

Source: BMNG "topography + bathymetry", August 2004, 500 m/pixel,
eight 21600x21600 GeoTIFF tiles (A1-D1 north row, A2-D2 south row).

Writes:
  data/source/bmng/*.tif            the unmodified NASA files (gitignored)
  provenance/sources.json           URL, size, SHA-256 and HTTP headers per file

If provenance/sources.json already exists, every file is checked against the
recorded SHA-256 and the script fails if anything differs. That way a rebuild
provably starts from the same bytes as the original one.

Standard library only:  python3 scripts/fetch_source.py
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import sys
import time
import urllib.request
from pathlib import Path

BASE_URL = (
    "https://assets.science.nasa.gov/content/dam/science/esd/eo/images/"
    "bmng/bmng-topography-bathymetry/august"
)
PREFIX = "world.topo.bathy.200408.3x21600x21600"
TILES = ["A1", "B1", "C1", "D1", "A2", "B2", "C2", "D2"]

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "data" / "source" / "bmng"
RECORD = ROOT / "provenance" / "sources.json"


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def download(url: str, out: Path, attempts: int = 3) -> dict:
    for attempt in range(1, attempts + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "blue-marble-globe/1.0"})
            with urllib.request.urlopen(req, timeout=60) as r:
                headers = {k.lower(): v for k, v in r.headers.items()}
                expected = int(headers.get("content-length", -1))
                tmp = out.with_suffix(".part")
                got = 0
                with tmp.open("wb") as f:
                    for chunk in iter(lambda: r.read(1 << 20), b""):
                        f.write(chunk)
                        got += len(chunk)
                if expected >= 0 and got != expected:
                    raise IOError(f"short read: {got} of {expected} bytes")
                tmp.replace(out)
                return headers
        except Exception as e:  # noqa: BLE001 - retry any network failure
            print(f"  attempt {attempt} failed: {e}", file=sys.stderr)
            if attempt == attempts:
                raise
            time.sleep(2 * attempt)
    raise AssertionError("unreachable")


def main() -> None:
    DEST.mkdir(parents=True, exist_ok=True)
    recorded = {}
    if RECORD.exists():
        recorded = {f["file"]: f for f in json.loads(RECORD.read_text())["files"]}

    files, profile = [], []
    t_all = time.perf_counter()
    for tile in TILES:
        name = f"{PREFIX}.{tile}_geo.tif"
        url = f"{BASE_URL}/{name}"
        out = DEST / name
        headers = {}

        t0 = time.perf_counter()
        if out.exists():
            print(f"have {name}")
            got = False
        else:
            print(f"GET  {url}")
            headers = download(url, out)
            got = True
        t_dl = time.perf_counter() - t0
        t0 = time.perf_counter()
        digest = sha256_of(out)
        t_hash = time.perf_counter() - t0
        size = out.stat().st_size
        profile.append({"file": name, "bytes": size, "downloaded": got, "download_seconds": round(t_dl, 1),
                        "mb_per_second": round(size / 1e6 / t_dl, 1) if got and t_dl else None,
                        "sha256_seconds": round(t_hash, 1)})
        if got:
            print(f"     {size / 1e6:,.0f} MB in {t_dl:.1f} s ({size / 1e6 / t_dl:.1f} MB/s), checksum {t_hash:.1f} s")
        prev = recorded.get(name)
        if prev and prev["sha256"] != digest:
            sys.exit(
                f"CHECKSUM MISMATCH for {name}\n"
                f"  recorded {prev['sha256']}\n  actual   {digest}\n"
                "The NASA file differs from the one this project was built from."
            )

        entry = prev or {
            "file": name,
            "tile": tile,
            "url": url,
            "bytes": out.stat().st_size,
            "sha256": digest,
            "http_etag": headers.get("etag"),
            "http_last_modified": headers.get("last-modified"),
            "retrieved_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        files.append(entry)
        print(f"     sha256 {digest}{'  (matches record)' if prev else ''}")

    RECORD.parent.mkdir(parents=True, exist_ok=True)
    RECORD.write_text(
        json.dumps(
            {
                "dataset": "NASA Blue Marble: Next Generation, topography + bathymetry, August 2004, 500 m",
                "publisher": "NASA Earth Observatory (NASA Goddard Space Flight Center)",
                "landing_page": "https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/",
                "files": files,
            },
            indent=2,
        )
        + "\n"
    )
    print(f"\nRecorded {len(files)} files in {RECORD.relative_to(ROOT)}")
    # This run's timings, beside the downloads (they vary per run and machine, so they're not in
    # sources.json); build_tiles.py copies them into its performance profile
    total = round(time.perf_counter() - t_all, 1)
    downloaded = [p for p in profile if p["downloaded"]]
    (DEST / "download-profile.json").write_text(json.dumps({
        "run_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "wall_seconds": total,
        "bytes_downloaded": sum(p["bytes"] for p in downloaded),
        "mb_per_second": round(sum(p["bytes"] for p in downloaded) / 1e6 / max(0.1, sum(p["download_seconds"] for p in downloaded)), 1)
                         if downloaded else None,
        "files": profile,
    }, indent=2) + "\n")
    print(f"Total {total:.0f} s" + (f", {len(downloaded)} files downloaded" if downloaded else ""))


if __name__ == "__main__":
    main()
