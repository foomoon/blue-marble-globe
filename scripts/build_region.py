#!/usr/bin/env python3
"""
Build a regional Landsat 8/9 imagery layer from a saved region config.

  .venv/bin/python scripts/build_region.py regions/<name>.json

Stages:
  1. search     Landsat Collection 2 Level-2 scenes in the box, dates, months and cloud limit,
                from Microsoft Planetary Computer's public STAC catalogue
  2. download   for each chosen scene, read only the region's pixels (red, green, blue and the
                QA cloud mask) straight from the cloud-optimised GeoTIFFs, already on the
                Web Mercator grid of the region's highest zoom
  3. composite  per block: mask clouds, cloud shadows and fill, take the median of what's left,
                and scale surface reflectance to 8-bit with the region's `stretch`
  4. tile       gdal2tiles into public/tiles/landsat/<name>/{z}/{x}/{y}.webp (WebP keeps
                transparency, so Blue Marble shows wherever there's no Landsat data)

Progress goes to stdout as one JSON object per line, for the Regions panel
(server/studio.js relays it). Run it in a terminal and you'll see the same lines.

Provenance: provenance/regions/<name>.json records the config, the catalogue query,
every scene used (ID, date, cloud cover, asset URLs, HTTP ETag and size), tool
versions, per-stage timings and a digest of every tile. A copy ships with the tiles.
"""

from __future__ import annotations

import concurrent.futures as cf
import datetime as dt
import hashlib
import json
import math
import os
import platform
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.request
import warnings
from pathlib import Path

import numpy as np
from osgeo import gdal, ogr, osr

gdal.UseExceptions()
gdal.SetConfigOption("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
gdal.SetConfigOption("GDAL_HTTP_MAX_RETRY", "4")
gdal.SetConfigOption("GDAL_HTTP_RETRY_DELAY", "2")

ROOT = Path(__file__).resolve().parents[1]
STAC = "https://planetarycomputer.microsoft.com/api/stac/v1/search"
TOKEN_URL = "https://planetarycomputer.microsoft.com/api/sas/v1/token/landsat-c2-l2"
COLLECTION = "landsat-c2-l2"
R = 20037508.342789244  # half the Web Mercator world width, metres
BLOCK = 1024  # composite block size, px
QA_REJECT = 0b11111  # QA_PIXEL bits: fill, dilated cloud, cirrus, cloud, cloud shadow
SR_SCALE, SR_OFFSET = 2.75e-5, -0.2  # Collection 2 surface reflectance scaling
USER_AGENT = "blue-marble-globe/1.0"

cancelled = threading.Event()


# ---------------------------------------------------------------- progress output

class Reporter:
    """JSON-lines progress on stdout. Progress lines are throttled; everything else is immediate."""

    def __init__(self):
        self.lock = threading.Lock()
        self.last = {}

    def emit(self, type_, **fields):
        with self.lock:
            print(json.dumps({"type": type_, "t": round(time.time(), 2), **fields}), flush=True)

    def progress(self, stage, done, total, force=False, **extra):
        now = time.time()
        if not force and now - self.last.get(stage, 0) < 0.25 and done < total:
            return
        self.last[stage] = now
        self.emit("progress", stage=stage, done=round(done, 3), total=total, **extra)


out = Reporter()


def redact(text):
    """Drop the catalogue's access token from URLs before they reach a log."""
    return re.sub(r"\?st=[^\s'\"]*", "?<token>", str(text))


def log(msg):
    out.emit("log", message=redact(msg))


# ---------------------------------------------------------------- web mercator grid

def merc(lon, lat):
    lat = max(-85.05112878, min(85.05112878, lat))
    return lon * R / 180, math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * R / math.pi


def unmerc(x, y):
    return x * 180 / R, math.degrees(2 * math.atan(math.exp(y * math.pi / R)) - math.pi / 2)


class Grid:
    """The region's pixel grid: the zoom-max tiles covering the bbox, 256 px each."""

    def __init__(self, bbox, zmax):
        w, s, e, n = bbox
        self.res = 2 * R / (256 * 2**zmax)
        tile_m = 256 * self.res
        (x0, y0), (x1, y1) = merc(w, n), merc(e, s)
        tx0, tx1 = math.floor((x0 + R) / tile_m), math.floor((x1 + R) / tile_m)
        ty0, ty1 = math.floor((R - y0) / tile_m), math.floor((R - y1) / tile_m)
        self.xmin, self.xmax = -R + tx0 * tile_m, -R + (tx1 + 1) * tile_m
        self.ymax, self.ymin = R - ty0 * tile_m, R - (ty1 + 1) * tile_m
        self.width, self.height = (tx1 - tx0 + 1) * 256, (ty1 - ty0 + 1) * 256

    def window(self, xmin, ymin, xmax, ymax):
        """Pixel window (col, row, w, h) covering a mercator box, clipped to the grid, or None."""
        c0 = max(0, math.floor((xmin - self.xmin) / self.res))
        c1 = min(self.width, math.ceil((xmax - self.xmin) / self.res))
        r0 = max(0, math.floor((self.ymax - ymax) / self.res))
        r1 = min(self.height, math.ceil((self.ymax - ymin) / self.res))
        return (c0, r0, c1 - c0, r1 - r0) if c1 > c0 and r1 > r0 else None

    def bounds(self, col, row, w, h):
        return (self.xmin + col * self.res, self.ymax - (row + h) * self.res,
                self.xmin + (col + w) * self.res, self.ymax - row * self.res)

    def lonlat_bounds(self, col, row, w, h):
        x0, y0, x1, y1 = self.bounds(col, row, w, h)
        return [*unmerc(x0, y0), *unmerc(x1, y1)]


# ---------------------------------------------------------------- region shape (Web Mercator)

def merc_ring(points):
    ring = ogr.Geometry(ogr.wkbLinearRing)
    for lon, lat in [*points, points[0]]:
        ring.AddPoint_2D(*merc(lon, lat))
    poly = ogr.Geometry(ogr.wkbPolygon)
    poly.AddGeometry(ring)
    return poly if poly.IsValid() else poly.Buffer(0)  # repair a self-touching outline


def merc_box(x0, y0, x1, y1):
    return merc_ring([unmerc(x0, y0), unmerc(x1, y0), unmerc(x1, y1), unmerc(x0, y1)])


def region_area(cfg):
    """The region as a Web Mercator polygon: its boundary if it has one, else its bbox."""
    if cfg.get("boundary"):
        return merc_ring(cfg["boundary"])
    w, s, e, n = cfg["bbox"]
    return merc_ring([(w, s), (e, s), (e, n), (w, n)])


# ---------------------------------------------------------------- catalogue

_token = {"value": None, "at": 0}


def token():
    if time.time() - _token["at"] > 1800:
        with urllib.request.urlopen(urllib.request.Request(TOKEN_URL, headers={"User-Agent": USER_AGENT}), timeout=30) as r:
            _token["value"] = json.load(r)["token"]
        _token["at"] = time.time()
    return _token["value"]


def signed(href):
    return f"{href}?{token()}"


def search(cfg):
    body = {
        "collections": [COLLECTION],
        "bbox": cfg["bbox"],
        "datetime": f"{cfg['dates'][0]}T00:00:00Z/{cfg['dates'][1]}T23:59:59Z",
        "query": {"eo:cloud_cover": {"lt": cfg["max_cloud_percent"]}, "platform": {"in": ["landsat-8", "landsat-9"]}},
        "limit": 250,
    }
    items, req_body = [], body
    while req_body is not None and not cancelled.is_set():
        req = urllib.request.Request(STAC, json.dumps(req_body).encode(),
                                     {"Content-Type": "application/json", "User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=60) as r:
            page = json.load(r)
        items += page["features"]
        out.progress("search", len(items), len(items), force=True)
        nxt = next((l for l in page.get("links", []) if l.get("rel") == "next"), None)
        req_body = nxt.get("body") if nxt else None
    return body, items


def choose(cfg, items, area):
    """Keep scenes in the chosen months that touch the region, then the clearest N per Landsat path/row."""
    months = set(cfg["months"])
    per = cfg.get("scenes_per_location", 4)
    by_loc = {}
    for it in items:
        p = it["properties"]
        if int(p["datetime"][5:7]) not in months:
            continue
        if not merc_ring(it["geometry"]["coordinates"][0]).Intersects(area):
            continue  # inside the bbox but outside a polygon boundary
        by_loc.setdefault((p.get("landsat:wrs_path"), p.get("landsat:wrs_row")), []).append(it)
    chosen = []
    for group in by_loc.values():
        group.sort(key=lambda it: it["properties"]["eo:cloud_cover"])
        chosen += group[:per]
    return chosen


# ---------------------------------------------------------------- download (windowed reads)

def head(url):
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as r:
        return {"etag": r.headers.get("ETag"), "bytes": int(r.headers.get("Content-Length", 0)),
                "last_modified": r.headers.get("Last-Modified")}


def open_remote(href, label, attempts=3):
    """Check a remote band opens, retrying transient failures. Returns its /vsicurl/ path."""
    for attempt in range(1, attempts + 1):
        path = f"/vsicurl/{signed(href)}"
        try:
            if gdal.Open(path) is not None:
                return path
        except RuntimeError as e:
            err = e
        if cancelled.is_set():
            raise SystemExit(130)
        log(f"retrying {label} (attempt {attempt} of {attempts} failed)")
        if hasattr(gdal, "VSICurlPartialClearCache"):
            gdal.VSICurlPartialClearCache(path)  # don't reuse a cached failure
        time.sleep(2 * attempt)
    raise RuntimeError(f"couldn't open {label} after {attempts} tries: {redact(err)}")


def fetch_scene(item, grid, work, progress_cb):
    """Warp one scene's RGB + QA into its window of the region grid. Returns a record or None."""
    xs, ys = zip(*(merc(*pt) for pt in item["geometry"]["coordinates"][0]))
    win = grid.window(min(xs), min(ys), max(xs), max(ys))
    if win is None:
        return None
    col, row, w, h = win
    bounds = grid.bounds(*win)
    a = item["assets"]
    hrefs = {k: a[k]["href"] for k in ("red", "green", "blue", "qa_pixel")}
    assets = {k: {"href": v, **head(signed(v))} for k, v in hrefs.items()}

    def cb(frac, _msg, _data):
        progress_cb(frac)
        return 0 if cancelled.is_set() else 1

    # BuildVRT silently drops inputs it can't open, so open every band first
    rgb_paths = [open_remote(hrefs[b], f"{item['id']} {b}") for b in ("red", "green", "blue")]
    qa_path = open_remote(hrefs["qa_pixel"], f"{item['id']} qa_pixel")
    vrt = f"/vsimem/{item['id']}.vrt"
    vds = gdal.BuildVRT(vrt, rgb_paths, separate=True)
    if vds is None or vds.RasterCount != 3:
        raise RuntimeError(f"{item['id']}: expected 3 colour bands, got {vds.RasterCount if vds else 0}")
    vds = None
    common = dict(dstSRS="EPSG:3857", outputBounds=bounds, width=w, height=h, multithread=True,
                  creationOptions=["TILED=YES", "COMPRESS=DEFLATE", "PREDICTOR=2"])
    gdal.Warp(str(work / f"{item['id']}_rgb.tif"), vrt, resampleAlg="bilinear", srcNodata=0, dstNodata=0,
              callback=lambda f, m, d: cb(f * 0.85, m, d), **common)
    gdal.Warp(str(work / f"{item['id']}_qa.tif"), qa_path, resampleAlg="near",
              srcNodata=1, dstNodata=1, callback=lambda f, m, d: cb(0.85 + f * 0.15, m, d), **common)
    gdal.Unlink(vrt)
    p = item["properties"]
    return {
        "id": item["id"], "datetime": p["datetime"], "platform": p["platform"],
        "cloud_cover": p["eo:cloud_cover"], "wrs_path": p.get("landsat:wrs_path"), "wrs_row": p.get("landsat:wrs_row"),
        "window": [col, row, w, h], "assets": assets,
    }


# ---------------------------------------------------------------- composite

def composite(cfg, grid, scenes, work, path, area):
    drv = gdal.GetDriverByName("GTiff")
    ds = drv.Create(str(path), grid.width, grid.height, 4, gdal.GDT_Byte,
                    ["TILED=YES", "COMPRESS=DEFLATE", "BIGTIFF=IF_SAFER", "PHOTOMETRIC=RGB", "ALPHA=YES"])
    ds.SetGeoTransform([grid.xmin, grid.res, 0, grid.ymax, 0, -grid.res])
    srs = osr.SpatialReference()
    srs.ImportFromEPSG(3857)
    ds.SetProjection(srs.ExportToWkt())

    s0, s1 = cfg.get("stretch", [0, 0.3])
    gamma = cfg.get("gamma", 1.6)
    handles = {s["id"]: (gdal.Open(str(work / f"{s['id']}_rgb.tif")), gdal.Open(str(work / f"{s['id']}_qa.tif")))
               for s in scenes}
    blocks = [(c, r, min(BLOCK, grid.width - c), min(BLOCK, grid.height - r))
              for r in range(0, grid.height, BLOCK) for c in range(0, grid.width, BLOCK)]
    blocks = [b for b in blocks if merc_box(*grid.bounds(*b)).Intersects(area)]
    out.emit("blocks", total=len(blocks))
    covered = 0

    for i, (bc, br, bw, bh) in enumerate(blocks):
        if cancelled.is_set():
            raise SystemExit(130)
        layers = []
        for s in scenes:
            sc, sr, sw, sh = s["window"]
            c0, r0 = max(bc, sc), max(br, sr)
            c1, r1 = min(bc + bw, sc + sw), min(br + bh, sr + sh)
            if c1 <= c0 or r1 <= r0:
                continue
            rgb_ds, qa_ds = handles[s["id"]]
            if rgb_ds.RasterCount != 3:  # never expected after fetch_scene's check; don't crash on it
                continue
            rgb = rgb_ds.ReadAsArray(c0 - sc, r0 - sr, c1 - c0, r1 - r0).astype(np.float32)
            qa = qa_ds.ReadAsArray(c0 - sc, r0 - sr, c1 - c0, r1 - r0)
            bad = ((qa & QA_REJECT) != 0) | (rgb.min(axis=0) == 0)
            layer = np.full((3, bh, bw), np.nan, np.float32)
            sub = rgb * SR_SCALE + SR_OFFSET
            sub[:, bad] = np.nan
            layer[:, r0 - br:r1 - br, c0 - bc:c1 - bc] = sub
            layers.append(layer)

        if layers:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)  # all-NaN pixels: no clear view
                med = np.nanmedian(np.stack(layers), axis=0)
            valid = ~np.isnan(med[0])
            norm = np.clip((med - s0) / (s1 - s0), 0, 1) ** (1 / gamma)  # gamma > 1 lifts midtones
            rgb8 = np.nan_to_num(norm * 255).astype(np.uint8)
            alpha = (valid * 255).astype(np.uint8)
            for b in range(3):
                ds.GetRasterBand(b + 1).WriteArray(rgb8[b], bc, br)
            ds.GetRasterBand(4).WriteArray(alpha, bc, br)
            covered += int(valid.sum())

        out.emit("block", index=i, bounds=grid.lonlat_bounds(bc, br, bw, bh), scenes=len(layers))
        out.progress("composite", i + 1, len(blocks))

    if cfg.get("boundary"):
        # Everything outside the polygon becomes transparent, so Blue Marble shows there
        # (gdal.RasterizeLayer ignores INVERSE, so use gdal.Rasterize with a vector dataset)
        mem = gdal.GetDriverByName("MEM").Create("", 0, 0, 0, gdal.GDT_Unknown)
        layer = mem.CreateLayer("boundary", srs, ogr.wkbPolygon)
        feat = ogr.Feature(layer.GetLayerDefn())
        feat.SetGeometry(area)
        layer.CreateFeature(feat)
        gdal.Rasterize(ds, mem, bands=[4], burnValues=[0], inverse=True)
        alpha = ds.GetRasterBand(4)
        covered = sum(int(np.count_nonzero(alpha.ReadAsArray(c, r, w, h))) for c, r, w, h in blocks)

    ds.FlushCache()
    ds = None
    inside_px = area.GetArea() / grid.res**2
    return min(1.0, covered / inside_px)


# ---------------------------------------------------------------- tiles

def expected_tiles(area, z0, z1):
    """Tiles touching the region shape, per the same rule the Regions panel uses."""
    minx, maxx, miny, maxy = area.GetEnvelope()
    total = 0
    for z in range(z0, z1 + 1):
        n, size = 2**z, 2 * R / 2**z
        tx0, tx1 = math.floor((minx + R) / size), min(n - 1, math.floor((maxx + R) / size))
        ty0, ty1 = math.floor((R - maxy) / size), min(n - 1, math.floor((R - miny) / size))
        box = (tx1 - tx0 + 1) * (ty1 - ty0 + 1)
        if box > 300_000:
            total += box
            continue
        for tx in range(tx0, tx1 + 1):
            for ty in range(ty0, ty1 + 1):
                x0 = -R + tx * size
                y1 = R - ty * size
                if merc_box(x0, y1 - size, x0 + size, y1).Intersects(area):
                    total += 1
    return total


def write_index(dest, zoom):
    """tiles.json: which tiles exist, so the globe never requests ones that weren't written."""
    idx = {}
    for p in dest.rglob("*.webp"):
        z, x, y = p.relative_to(dest).with_suffix("").parts
        idx.setdefault(z, {}).setdefault(x, []).append(int(y))
    for xs in idx.values():
        for ys in xs.values():
            ys.sort()
    (dest / "tiles.json").write_text(json.dumps({"zoom": zoom, "tiles": idx}, separators=(",", ":")))


def make_tiles(cfg, src, dest, area):
    z0, z1 = cfg["zoom"]
    gdal2tiles = shutil.which("gdal2tiles") or shutil.which("gdal2tiles.py")
    cmd = [gdal2tiles, "--xyz", "-z", f"{z0}-{z1}", "-w", "none", f"--processes={os.cpu_count() or 4}",
           "--tiledriver=WEBP", "--webp-quality=85", "--exclude", str(src), str(dest)]
    total = expected_tiles(area, z0, z1)
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    while proc.poll() is None:
        if cancelled.is_set():
            proc.terminate()
            raise SystemExit(130)
        n = sum(1 for _ in dest.rglob("*.webp")) if dest.exists() else 0
        out.progress("tile", min(n, total), total, force=True)
        time.sleep(1)
    if cancelled.is_set():  # SIGTERM reached gdal2tiles too (same process group)
        raise SystemExit(130)
    if proc.returncode:
        raise RuntimeError(f"gdal2tiles failed: {proc.stderr.read()[-500:]}")
    return cmd


def digest(root):
    lines, size = [], 0
    for p in sorted(root.rglob("*.webp")):
        b = p.read_bytes()
        size += len(b)
        lines.append(f"{p.relative_to(root).as_posix()} {hashlib.sha256(b).hexdigest()}")
    return len(lines), size, hashlib.sha256("\n".join(lines).encode()).hexdigest()


def write_regions_index():
    """public/tiles/landsat/index.json: every built region, for the globe's Layers control."""
    base = ROOT / "public" / "tiles" / "landsat"
    regions = []
    for prov in sorted(base.glob("*/PROVENANCE.json")) if base.exists() else []:
        rec = json.loads(prov.read_text())
        cfg, name = rec["region"], prov.parent.name
        regions.append({
            "name": name,
            "title": cfg.get("title", name),
            "bbox": cfg["bbox"],
            **({"boundary": cfg["boundary"]} if cfg.get("boundary") else {}),
            "zoom": cfg["zoom"],
            "url": f"/tiles/landsat/{name}/{{z}}/{{x}}/{{y}}.webp",
            **({"tiles_index": f"/tiles/landsat/{name}/tiles.json"} if (prov.parent / "tiles.json").exists() else {}),
            "credit": rec["data"]["credit"],
            "built_utc": rec["built_utc"],
            "tile_count": rec["output"]["tile_count"],
        })
    if regions or (base / "index.json").exists():
        base.mkdir(parents=True, exist_ok=True)
        (base / "index.json").write_text(json.dumps({"regions": regions}, indent=2) + "\n")


# ---------------------------------------------------------------- main

def main():
    if sys.argv[1:] == ["--index"]:
        write_regions_index()
        return print("wrote public/tiles/landsat/index.json")
    if len(sys.argv) != 2:
        sys.exit("usage: build_region.py regions/<name>.json  |  build_region.py --index")
    cfg_path = Path(sys.argv[1]).resolve()
    cfg = json.loads(cfg_path.read_text())
    name = cfg["name"]
    work = ROOT / "data" / "regions-work" / name
    dest = ROOT / "public" / "tiles" / "landsat" / name
    record_path = ROOT / "provenance" / "regions" / f"{name}.json"

    def on_term(*_):
        cancelled.set()
    signal.signal(signal.SIGTERM, on_term)
    signal.signal(signal.SIGINT, on_term)

    timings, t_all = {}, time.perf_counter()
    started = dt.datetime.now(dt.timezone.utc)
    grid = Grid(cfg["bbox"], cfg["zoom"][1])
    area = region_area(cfg)
    out.emit("start", region=name, bbox=cfg["bbox"], zoom=cfg["zoom"], grid=[grid.width, grid.height])
    complete = False
    tiling = False  # once true, dest holds a half-written layer; before that it's the previous build
    try:
        shutil.rmtree(work, ignore_errors=True)
        work.mkdir(parents=True)

        # 1. search
        out.emit("stage", stage="search", status="running")
        t = time.perf_counter()
        query, items = search(cfg)
        chosen = choose(cfg, items, area)
        timings["search"] = round(time.perf_counter() - t, 1)
        for it in chosen:
            out.emit("scene", id=it["id"], state="found", footprint=it["geometry"]["coordinates"][0],
                     cloud=it["properties"]["eo:cloud_cover"], date=it["properties"]["datetime"][:10])
        out.emit("stage", stage="search", status="done",
                 detail=f"{len(chosen)} scenes chosen of {len(items)} found")
        if not chosen:
            raise RuntimeError("No scenes match. Widen the dates, add months or raise the cloud limit.")

        # 2. download
        out.emit("stage", stage="download", status="running")
        t = time.perf_counter()
        frac = {it["id"]: 0.0 for it in chosen}
        flock = threading.Lock()

        def run(it):
            if cancelled.is_set():  # queued scenes return at once after a cancel
                return None
            def cb(f):
                with flock:
                    frac[it["id"]] = f
                    out.progress("download", sum(frac.values()), len(chosen))
            out.emit("scene", id=it["id"], state="downloading")
            rec = fetch_scene(it, grid, work, cb)
            with flock:
                frac[it["id"]] = 1.0
            out.emit("scene", id=it["id"], state="loaded" if rec else "skipped")
            return rec

        scenes, failed = [], []
        pool = cf.ThreadPoolExecutor(max_workers=4)
        futures = {pool.submit(run, it): it for it in chosen}
        pending = set(futures)
        try:
            # Poll rather than block on as_completed, so a cancel is noticed within half a second
            while pending:
                done, pending = cf.wait(pending, timeout=0.5, return_when=cf.FIRST_COMPLETED)
                if cancelled.is_set():
                    raise SystemExit(130)
                for fut in done:
                    try:
                        rec = fut.result()
                        if rec:
                            scenes.append(rec)
                    except Exception as e:  # noqa: BLE001 - one bad scene shouldn't sink the build
                        if cancelled.is_set():
                            raise SystemExit(130)
                        out.emit("scene", id=futures[fut]["id"], state="failed")
                        log(f"scene {futures[fut]['id']} failed: {e}")
                        failed.append({"id": futures[fut]["id"], "reason": redact(e)})
                out.progress("download", sum(frac.values()), len(chosen), force=True)
        finally:
            pool.shutdown(wait=False, cancel_futures=True)  # drop scenes that haven't started
        timings["download"] = round(time.perf_counter() - t, 1)
        if not scenes:
            raise RuntimeError("Every scene failed to download.")
        scenes.sort(key=lambda s: s["cloud_cover"])  # median is order-independent; keeps the record tidy
        out.emit("stage", stage="download", status="done",
                 detail=f"{len(scenes)} scenes read" + (f", {len(failed)} failed (see log)" if failed else ""))

        # 3. composite
        out.emit("stage", stage="composite", status="running")
        t = time.perf_counter()
        comp = work / "composite.tif"
        coverage = composite(cfg, grid, scenes, work, comp, area)
        timings["composite"] = round(time.perf_counter() - t, 1)
        out.emit("stage", stage="composite", status="done", detail=f"{coverage:.0%} of the area has a clear view")

        # 4. tile
        out.emit("stage", stage="tile", status="running", url=f"/tiles/landsat/{name}/{{z}}/{{x}}/{{y}}.webp")
        t = time.perf_counter()
        tiling = True
        shutil.rmtree(dest, ignore_errors=True)
        dest.parent.mkdir(parents=True, exist_ok=True)
        cmd = make_tiles(cfg, comp, dest, area)
        write_index(dest, cfg["zoom"])
        timings["tile"] = round(time.perf_counter() - t, 1)
        count, size, tiles_sha = digest(dest)
        size_txt = f"{size / 1e6:.1f} MB" if size >= 1e6 else f"{size / 1e3:.0f} KB"
        out.emit("stage", stage="tile", status="done", detail=f"{count:,} tiles, {size_txt}")

        record = {
            "region": cfg,
            "region_config_sha256": hashlib.sha256(cfg_path.read_bytes()).hexdigest(),
            "data": {
                "dataset": "Landsat 8-9 OLI Collection 2 Level-2 surface reflectance",
                "producer": "U.S. Geological Survey (USGS) / NASA",
                "accessed_via": "Microsoft Planetary Computer STAC API (landsat-c2-l2); asset URLs below are unsigned",
                "credit": "Landsat imagery courtesy of the U.S. Geological Survey",
            },
            "catalogue_query": query,
            "scenes_found": len(items),
            "scenes": scenes,
            "scenes_failed": failed,  # chosen but unreadable at build time, so not in the composite
            "processing": [
                "per scene: red/green/blue bilinear-warped and QA_PIXEL nearest-warped to EPSG:3857 at the zoom-max grid",
                "per pixel: reject QA_PIXEL fill, dilated cloud, cirrus, cloud and cloud shadow",
                "per pixel: median of the remaining scenes, reflectance = DN * 2.75e-5 - 0.2",
                f"stretch {cfg.get('stretch', [0, 0.3])} -> 0-1, gamma {cfg.get('gamma', 1.6)}, -> 0-255; transparent where no clear view",
                "gdal2tiles --xyz, WebP quality 85, fully transparent tiles not written; tiles.json lists the rest",
            ] + (["masked to the region's boundary polygon (outside is transparent)"] if cfg.get("boundary") else []),
            "commands": [[os.path.relpath(a, ROOT) if str(a).startswith(str(ROOT)) else a for a in cmd]],
            "built_utc": started.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "environment": {"gdal": gdal.__version__, "numpy": np.__version__,
                            "python": platform.python_version(), "platform": platform.platform()},
            "wall_clock_seconds": {"total": round(time.perf_counter() - t_all, 1), "steps": timings},
            "output": {"path": f"public/tiles/landsat/{name}/{{z}}/{{x}}/{{y}}.webp", "zoom": cfg["zoom"],
                       "clear_view_fraction": round(coverage, 4),
                       "tile_count": count, "bytes": size, "tiles_sha256": tiles_sha},
        }
        record_path.parent.mkdir(parents=True, exist_ok=True)
        record_path.write_text(json.dumps(record, indent=2) + "\n")
        (dest / "PROVENANCE.json").write_text(json.dumps(record, indent=2) + "\n")
        complete = True
        out.emit("done", seconds=record["wall_clock_seconds"]["total"], tiles=count, bytes=size,
                 provenance=str(record_path.relative_to(ROOT)))
    except SystemExit:
        out.emit("cancelled")
        raise
    except Exception as e:  # noqa: BLE001 - report every failure to the UI
        out.emit("error", message=redact(e))
        raise SystemExit(1)
    finally:
        shutil.rmtree(work, ignore_errors=True)
        if tiling and not complete:
            shutil.rmtree(dest, ignore_errors=True)  # never leave a half-built layer behind
        # (stopped earlier: a previous build's tiles are untouched and stay usable)
        write_regions_index()


if __name__ == "__main__":
    main()
