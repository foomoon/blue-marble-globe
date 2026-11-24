"""
Regional terrain for a Landsat region: the terrain stage of scripts/build_region.py.

Source, by priority: USGS 3DEP Seamless at 10 m (the United States and its territories), then
NASADEM at 30 m (60° N to 56° S) wherever 3DEP has no data. Both are read from Microsoft
Planetary Computer, only the region's pixels.

Output: public/tiles/landsat/<name>/terrain/{z}/{x}/{y}.webp, the same encoding as the global
terrain (Terrarium in lossless WebP, heights rounded to whole metres, sea at 0) with one
addition: the blue channel is the share of the regional source in each height, 0-255. A
decoder that reads blue as Terrarium's 1/256 m adds under a metre; src/terrain.js reads it
as the share, for the readout.

Edges: over the last FEATHER_M inside the region's outline, heights fade from the regional
source to the global terrain (the tiles in public/tiles/terrain, decoded exactly as the
globe decodes them), and outside it they're the global heights. So where the regional
tiles stop, the surface carries on without a step.
"""

from __future__ import annotations

import json
import math
import time
import urllib.request
from pathlib import Path

import numpy as np
from osgeo import gdal, ogr, osr

ROOT = Path(__file__).resolve().parents[1]
GLOBAL = ROOT / "public" / "tiles" / "terrain"
STAC = "https://planetarycomputer.microsoft.com/api/stac/v1/search"
TOKEN = "https://planetarycomputer.microsoft.com/api/sas/v1/token/{}"
USER_AGENT = "blue-marble-globe/1.0"
R = 20037508.342789244
NODATA = -99999.0
FEATHER_M = 2000  # blend width inside the outline
BLOCK = 4096  # px per side of a processing block
MIN_SHARE = 0.005  # a fallback source is used only if it adds at least this share of the land
MAX_PIXELS = 600_000_000  # cap for the deepest zoom's grid; above it, stop a zoom earlier

SOURCES = [  # by priority: the first with data at a pixel wins
    {"collection": "3dep-seamless", "asset": "data", "gsd": 10, "label": "USGS 3DEP", "max_zoom": 14,
     "credit": "Terrain: U.S. Geological Survey, 3DEP", "licence": "Public domain (USGS)"},
    {"collection": "nasadem", "asset": "elevation", "gsd": 30, "label": "NASADEM", "max_zoom": 12,
     "credit": "Terrain: NASA JPL, NASADEM", "licence": "No restrictions (NASA, CC0)"},
]

_tokens: dict[str, tuple[float, str]] = {}


def signed(href: str, collection: str) -> str:
    t = _tokens.get(collection)
    if not t or time.time() - t[0] > 1800:
        req = urllib.request.Request(TOKEN.format(collection), headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=30) as r:
            t = (time.time(), json.load(r)["token"])
        _tokens[collection] = t
    return f"{href}?{t[1]}"


def search(src: dict, bbox: list[float]) -> list[dict]:
    body = {"collections": [src["collection"]], "bbox": bbox, "limit": 500}
    req = urllib.request.Request(STAC, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as r:
        items = json.load(r)["features"]
    if src["collection"] == "3dep-seamless":
        items = [it for it in items if it["properties"].get("gsd") == src["gsd"]]
    return items


def lonlat_outline(cfg):
    """The region's outline in longitude/latitude: its boundary polygon, or its bbox."""
    w, s, e, n = cfg["bbox"]
    points = cfg.get("boundary") or [(w, s), (e, s), (e, n), (w, n)]
    ring = ogr.Geometry(ogr.wkbLinearRing)
    for lon, lat in [*points, points[0]]:
        ring.AddPoint_2D(lon, lat)
    poly = ogr.Geometry(ogr.wkbPolygon)
    poly.AddGeometry(ring)
    return poly if poly.IsValid() else poly.Buffer(0)


def covers(items, outline) -> bool:
    """Whether the items' footprints together cover the whole outline."""
    union = None
    for it in items:
        g = ogr.CreateGeometryFromJson(json.dumps(it["geometry"]))
        union = g if union is None else union.Union(g)
    return union is not None and union.Buffer(1e-6).Contains(outline)


def tile_range(area, z):
    minx, maxx, miny, maxy = area.GetEnvelope()
    size = 2 * R / 2**z
    n = 2**z
    tx0, tx1 = math.floor((minx + R) / size), min(n - 1, math.floor((maxx + R) / size))
    ty0, ty1 = math.floor((R - maxy) / size), min(n - 1, math.floor((R - miny) / size))
    return tx0, tx1, ty0, ty1, size


def mem(width, height, bounds, dtype=gdal.GDT_Float32, nodata=NODATA):
    ds = gdal.GetDriverByName("MEM").Create("", width, height, 1, dtype)
    x0, y0, x1, y1 = bounds
    ds.SetGeoTransform((x0, (x1 - x0) / width, 0, y1, 0, -(y1 - y0) / height))
    srs = osr.SpatialReference()
    srs.ImportFromEPSG(3857)
    ds.SetProjection(srs.ExportToWkt())
    if nodata is not None:
        ds.GetRasterBand(1).SetNoDataValue(nodata)
        ds.GetRasterBand(1).Fill(nodata)
    return ds


class GlobalHeights:
    """The global terrain exactly as the globe sees it: its tiles, decoded, at zoom min(z, 8)."""

    def __init__(self):
        idx = GLOBAL / "tiles.json"
        self.ok = idx.exists()
        if self.ok:
            j = json.loads(idx.read_text())
            self.maxzoom = j["zoom"][1]
            self.have = {f"{z}/{x}/{y}" for z, xs in j["tiles"].items() for x, ys in xs.items() for y in ys}
        self.cache = {}

    def tile(self, z, x, y):
        key = f"{z}/{x}/{y}"
        if key not in self.cache:
            if key in self.have:
                a = gdal.Open(str(GLOBAL / str(z) / str(x) / f"{y}.webp")).ReadAsArray().astype(np.float32)
                self.cache[key] = a[0] * 256 + a[1] + a[2] / 256 - 32768
            else:
                self.cache[key] = np.zeros((256, 256), np.float32)  # all sea
            if len(self.cache) > 400:
                self.cache.pop(next(iter(self.cache)))
        return self.cache[key]

    def warp(self, bounds, width, height, z):
        """Global heights on a block's grid (bilinear between pixel centres, as the globe does)."""
        zg = min(z, self.maxzoom)
        size = 2 * R / 2**zg
        x0, y0, x1, y1 = bounds
        tx0, tx1 = math.floor((x0 + R) / size), math.floor((x1 - 1e-6 + R) / size)
        ty0, ty1 = math.floor((R - y1) / size), math.floor((R - y0 - 1e-6) / size)
        n = 2**zg
        mosaic = np.zeros(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256), np.float32)
        for ty in range(ty0, ty1 + 1):
            for tx in range(tx0, tx1 + 1):
                if 0 <= ty < n:
                    mosaic[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256] = self.tile(zg, tx % n, ty)
        src = mem(mosaic.shape[1], mosaic.shape[0],
                  (-R + tx0 * size, R - (ty1 + 1) * size, -R + (tx1 + 1) * size, R - ty0 * size), nodata=None)
        src.GetRasterBand(1).WriteArray(mosaic)
        out = gdal.Warp("", src, format="MEM", outputBounds=bounds, width=width, height=height,
                        resampleAlg="bilinear", outputType=gdal.GDT_Float32)
        return out.GetRasterBand(1).ReadAsArray()


def encode(h, w):
    v = np.rint(h).astype(np.int32) + 32768
    return np.stack([v >> 8, v & 255, np.rint(w * 255).astype(np.int32)]).astype(np.uint8)


def write_tile(path: Path, rgb) -> int:
    ds = gdal.GetDriverByName("MEM").Create("", 256, 256, 3, gdal.GDT_Byte)
    for i in range(3):
        ds.GetRasterBand(i + 1).WriteArray(rgb[i])
    path.parent.mkdir(parents=True, exist_ok=True)
    gdal.GetDriverByName("WEBP").CreateCopy(str(path), ds, options=["LOSSLESS=TRUE"])
    return path.stat().st_size


def build(cfg, area, dest: Path, work: Path, progress, cancelled, log):
    """Build the region's terrain into dest. Returns its provenance record, or None if no source covers it."""
    t_all = time.perf_counter()
    bbox = cfg["bbox"]

    # 1. Which sources have data here: 3DEP first, then others only for what it doesn't cover
    found = []
    outline = lonlat_outline(cfg)
    for src in SOURCES:
        items = search(src, bbox)
        if not items:
            continue
        found.append((src, items))
        if covers(items, outline):
            break
    if not found:
        log("No regional terrain source covers this area (3DEP: the US; NASADEM: 60° N to 56° S); "
            "the globe uses the global terrain here.")
        return None
    best = found[0][0]
    tz0 = cfg["zoom"][0]
    tz1 = best["max_zoom"]
    while True:  # keep the deepest grid within reason for big regions
        tx0, tx1, ty0, ty1, _ = tile_range(area, tz1)
        if (tx1 - tx0 + 1) * (ty1 - ty0 + 1) * 65536 <= MAX_PIXELS or tz1 <= max(tz0, cfg["zoom"][1]):
            break
        tz1 -= 1
    tz0 = min(tz0, tz1)
    log(f"terrain: searching {' + '.join(s['label'] for s, _ in found)}, zoom {tz0}-{tz1}")

    # 2. Read the region's pixels once, onto the deepest zoom's grid. One source at a time (their
    #    coordinate systems differ: 3DEP is NAD83, NASADEM WGS84), lowest priority first: each
    #    later one overwrites only where it has data.
    tx0, tx1, ty0, ty1, size = tile_range(area, tz1)
    bounds = (-R + tx0 * size, R - (ty1 + 1) * size, -R + (tx1 + 1) * size, R - ty0 * size)
    width, height = (tx1 - tx0 + 1) * 256, (ty1 - ty0 + 1) * 256
    dem_path = work / "dem.tif"
    dem = gdal.GetDriverByName("GTiff").Create(
        str(dem_path), width, height, 1, gdal.GDT_Float32,
        options=["TILED=YES", "COMPRESS=DEFLATE", "PREDICTOR=3", "BIGTIFF=IF_SAFER"])
    dem.SetGeoTransform((bounds[0], size / 256, 0, bounds[3], 0, -size / 256))
    srs3857 = osr.SpatialReference()
    srs3857.ImportFromEPSG(3857)
    dem.SetProjection(srs3857.ExportToWkt())
    dem.GetRasterBand(1).SetNoDataValue(NODATA)
    dem.GetRasterBand(1).Fill(NODATA)
    # By priority: the first source goes straight in; each later one only fills pixels still
    # empty, and counts the land it adds, so a source that only adds sea isn't credited
    land_added = {}
    for k, (src, items) in enumerate(found):
        hrefs = [f"/vsicurl/{signed(it['assets'][src['asset']]['href'], src['collection'])}" for it in items]
        vrt = gdal.BuildVRT(str(work / f"{src['collection']}.vrt"), hrefs)
        # Horizontal reference only: a source that declares a vertical one (3DEP files may say
        # "NAD83 + NAVD88 height") would otherwise have its heights converted to the ellipsoid
        # on reprojection. Heights stay above sea level, as in the global terrain.
        horiz = vrt.GetSpatialRef().Clone()
        horiz.StripVertical()

        def on_progress(frac, *_, k=k):
            progress((k + frac) / len(found) * 0.5)  # reading is about half the stage
            return 0 if cancelled() else 1
        if k == 0:
            gdal.Warp(dem, vrt, srcSRS=horiz.ExportToWkt(), resampleAlg="bilinear", dstNodata=NODATA,
                      multithread=True, warpMemoryLimit=512, callback=on_progress)
            band = dem.GetRasterBand(1)
            land_added[src["label"]] = sum(
                int((band.ReadAsArray(x, y, min(BLOCK, width - x), min(BLOCK, height - y)) > 0.5).sum())
                for y in range(0, height, BLOCK) for x in range(0, width, BLOCK))
        else:
            tmp = gdal.Warp(str(work / f"{src['collection']}.tif"), vrt, srcSRS=horiz.ExportToWkt(),
                            dstSRS="EPSG:3857", outputBounds=bounds,
                            width=width, height=height, resampleAlg="bilinear", outputType=gdal.GDT_Float32,
                            dstNodata=NODATA, multithread=True, warpMemoryLimit=512,
                            creationOptions=["TILED=YES", "COMPRESS=DEFLATE", "PREDICTOR=3", "BIGTIFF=IF_SAFER"],
                            callback=on_progress)
            # Count first: a source that only adds a sliver (coastal noise, say: under 0.5% of the
            # land) isn't used at all, so the credit and the readout stay true
            def gaps():
                for y in range(0, height, BLOCK):
                    for x in range(0, width, BLOCK):
                        bw, bh = min(BLOCK, width - x), min(BLOCK, height - y)
                        have = dem.GetRasterBand(1).ReadAsArray(x, y, bw, bh)
                        fill = tmp.GetRasterBand(1).ReadAsArray(x, y, bw, bh)
                        yield x, y, have, fill, (have == NODATA) & (fill != NODATA)
            added = sum(int((gap & (fill > 0.5)).sum()) for _, _, _, fill, gap in gaps())
            if added >= MIN_SHARE * max(1, sum(land_added.values())):
                for x, y, have, fill, gap in gaps():
                    if gap.any():
                        dem.GetRasterBand(1).WriteArray(np.where(gap, fill, have), x, y)
            else:
                log(f"terrain: {src['label']} would add only {added:,} px of land; not used")
                added = 0
            tmp = None
            land_added[src["label"]] = added
        vrt = None
        if cancelled():
            raise SystemExit(130)
    found = [(src, items) for src, items in found if land_added.get(src["label"], 0) > 0] or found[:1]
    best = found[0][0]
    labels = " + ".join(src["label"] for src, _ in found)
    log(f"terrain: land from {', '.join(f'{k} {v:,} px' for k, v in land_added.items())}")
    dem.FlushCache()
    t_read = time.perf_counter() - t_all

    # 3. Each zoom, in blocks: regional heights, blended into the global ones near the outline
    glob = GlobalHeights()
    if not glob.ok:
        log("terrain: the global terrain isn't built, so the regional terrain isn't blended at its edges")
    ring = ogr.CreateGeometryFromWkb(area.ExportToWkb())
    # The in-memory vector driver is "MEM" from GDAL 3.11, "Memory" before (Ubuntu 24.04 has 3.8).
    # Asking OGR, which lists vector drivers only, finds whichever this GDAL has.
    vec = (ogr.GetDriverByName("MEM") or ogr.GetDriverByName("Memory")).CreateDataSource("")
    srs = osr.SpatialReference()
    srs.ImportFromEPSG(3857)
    lyr = vec.CreateLayer("area", srs)
    feat = ogr.Feature(lyr.GetLayerDefn())
    feat.SetGeometry(ring)
    lyr.CreateFeature(feat)

    jobs = []
    for z in range(tz1, tz0 - 1, -1):
        zx0, zx1, zy0, zy1, zsize = tile_range(area, z)
        per = BLOCK // 256
        for by in range(zy0, zy1 + 1, per):
            for bx in range(zx0, zx1 + 1, per):
                jobs.append((z, bx, min(zx1, bx + per - 1), by, min(zy1, by + per - 1), zsize))
    written, total_bytes = {}, 0
    for n, (z, bx0, bx1, by0, by1, zsize) in enumerate(jobs, 1):
        if cancelled():
            raise SystemExit(130)
        px = zsize / 256  # metres per pixel at this zoom
        pad = math.ceil(FEATHER_M / px) + 1 if glob.ok else 0
        w_px, h_px = (bx1 - bx0 + 1) * 256, (by1 - by0 + 1) * 256
        b = (-R + bx0 * zsize - pad * px, R - (by1 + 1) * zsize - pad * px,
             -R + (bx1 + 1) * zsize + pad * px, R - by0 * zsize + pad * px)
        W, H = w_px + 2 * pad, h_px + 2 * pad
        # (keep the dataset in a variable: chaining .GetRasterBand() lets Python free it first)
        dds = gdal.Warp("", dem, format="MEM", outputBounds=b, width=W, height=H,
                        resampleAlg="average" if z < tz1 else "near", outputType=gdal.GDT_Float32,
                        srcNodata=NODATA, dstNodata=NODATA)
        d = dds.GetRasterBand(1).ReadAsArray()
        dds = None
        # Inside the outline: 1, outside: 0; then distance (px) from the outside
        m = mem(W, H, b, gdal.GDT_Byte, nodata=None)
        gdal.RasterizeLayer(m, [1], lyr, burn_values=[1])
        inside = m.GetRasterBand(1).ReadAsArray() > 0
        if glob.ok and not inside.all():
            prox = mem(W, H, b, gdal.GDT_Float32, nodata=None)
            gdal.ComputeProximity(m.GetRasterBand(1), prox.GetRasterBand(1), ["VALUES=0", "DISTUNITS=PIXEL"])
            dist = prox.GetRasterBand(1).ReadAsArray() * px
            t = np.clip(dist / FEATHER_M, 0, 1)
            wgt = np.where(inside, t * t * (3 - 2 * t), 0)  # smoothstep
            g = np.maximum(glob.warp(b, W, H, z), 0)
        elif glob.ok:  # the whole block is inside the outline (global heights still fill gaps in the data)
            wgt = np.ones((H, W), np.float32)
            g = np.maximum(glob.warp(b, W, H, z), 0)
        else:
            wgt = np.ones((H, W), np.float32)
            g = np.zeros((H, W), np.float32)
        valid = d != NODATA
        wgt = np.where(valid, wgt, 0)  # no regional data here (e.g. sea in 3DEP): global only
        h = np.maximum(wgt * np.where(valid, d, 0) + (1 - wgt) * g, 0)
        h, wgt = h[pad:pad + h_px, pad:pad + w_px], wgt[pad:pad + h_px, pad:pad + w_px]
        for j in range(by1 - by0 + 1):
            for i in range(bx1 - bx0 + 1):
                tw = wgt[j * 256:(j + 1) * 256, i * 256:(i + 1) * 256]
                th = h[j * 256:(j + 1) * 256, i * 256:(i + 1) * 256]
                # Every tile in the region's box with land, including just outside its outline
                # (global heights there): a web map using only this terrain source then has no
                # cliff where the outline doesn't reach. All-sea tiles are left out.
                if not ((tw > 0).any() or (th > 0.5).any()):
                    continue
                x, y = bx0 + i, by0 + j
                total_bytes += write_tile(dest / str(z) / str(x) / f"{y}.webp", encode(th, tw))
                written.setdefault(str(z), {}).setdefault(str(x), []).append(y)
        progress(0.5 + 0.5 * n / len(jobs))
    for xs in written.values():
        for ys in xs.values():
            ys.sort()
    (dest / "tiles.json").write_text(json.dumps({"zoom": [tz0, tz1], "tiles": written}, separators=(",", ":")))
    count = sum(len(ys) for xs in written.values() for ys in xs.values())
    return {
        "sources": [{"dataset": s["label"], "collection": s["collection"], "licence": s["licence"],
                     "items": [{"id": it["id"], "href": it["assets"][s["asset"]]["href"]} for it in items]}
                    for s, items in found],
        "label": labels,
        "credit": "Terrain: " + "; ".join(s["credit"].removeprefix("Terrain: ") for s, _ in found),
        "detail_m": best["gsd"] if len(found) == 1 else max(s["gsd"] for s, _ in found),
        "zoom": [tz0, tz1],
        "encoding": "Terrarium, lossless WebP; heights rounded to whole metres, sea at 0; blue = share of the "
                    "regional source (0-255)",
        "edges": (f"blended into the global terrain over {FEATHER_M} m inside the outline; global heights outside it"
                  if glob.ok else "not blended (global terrain not built)"),
        "tile_count": count,
        "bytes": total_bytes,
        "seconds": {"read": round(t_read, 1), "total": round(time.perf_counter() - t_all, 1)},
    }
