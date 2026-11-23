#!/usr/bin/env python3
"""
Generate the map server's metadata from the layers built on this machine.

Scans:
  public/tiles/blue-marble/   public/tiles/grey/   public/tiles/landsat/index.json
  provenance/vectors.json     (borders, states, coastlines in public/vectors/)

Writes mapserver/www/ (gitignored; regenerate after building or rebuilding a layer):
  catalog.json                every layer: id, kind, URLs, zoom, bounds, attribution, licence, provenance
  tilejson/<id>.json          TileJSON 3.0.0 per tiled layer, served at /tiles/<id>/tilejson.json
  index.html                  a human-readable index with previews and copy-paste snippets

  python3 scripts/build_server.py [--base-url https://maps.example.com]

Every URL in these files must be absolute: a web map on another site would resolve /tiles/...
against itself. Without --base-url, they start with a placeholder that nginx swaps for the address
each request came in on (http://localhost:8080, http://192.168.1.20:8080, ...). Pass --base-url
when the server sits behind a proxy or CDN that should be the only address published.
"""

from __future__ import annotations

import argparse
import datetime as dt
import html
import math
import os
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TILES = ROOT / "public" / "tiles"
WWW = ROOT / "mapserver" / "www"
WORLD = [-180, -85.0511, 180, 85.0511]
NASA = ('Imagery: <a href="https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/">'
        "NASA Earth Observatory, Blue Marble: Next Generation</a>")
NATURAL_EARTH = '<a href="https://www.naturalearthdata.com/">Natural Earth</a> (public domain)'


# Swapped by nginx (sub_filter in mapserver/nginx.conf) for the address each request came in on
ORIGIN = "__MAPSERVER_ORIGIN__"


def provenance(path: Path) -> dict | None:
    return json.loads(path.read_text()) if path.exists() else None


def tiled_layers(base: str) -> list[dict]:
    layers = []
    bm = provenance(TILES / "blue-marble" / "PROVENANCE.json")
    if bm:
        layers.append({
            "id": "blue-marble", "name": "Blue Marble", "kind": "raster", "format": "jpg",
            "description": "NASA Blue Marble: Next Generation, August 2004, 500 m. Global true-colour base map.",
            "minzoom": 0, "maxzoom": bm["build"]["output"]["zoom"][1], "bounds": WORLD,
            "attribution": NASA,
            "license": "Used under NASA's Images and Media Usage Guidelines; credit NASA Earth Observatory. See /licensing.",
            "version": bm["build"]["built_utc"], "provenance": "/tiles/blue-marble/PROVENANCE.json",
        })
    grey = provenance(TILES / "grey" / "PROVENANCE.json")
    if grey:
        layers.append({
            "id": "grey", "name": "Grey", "kind": "raster", "format": "png",
            "description": "Natural Earth 1:10m land as light grey (#d6d6d6). Water is transparent: "
                           "put a dark background (e.g. #3b3f45) underneath for the ocean.",
            "minzoom": 0, "maxzoom": grey["output"]["zoom"][1], "bounds": WORLD,
            "attribution": NATURAL_EARTH,
            "license": "Public domain (Natural Earth). No attribution required.",
            "version": grey["built_utc"], "provenance": "/tiles/grey/PROVENANCE.json",
        })
    index = provenance(TILES / "landsat" / "index.json")
    for r in (index or {}).get("regions", []):
        w, s, e, n = r["bbox"]
        layers.append({
            "id": f"landsat/{r['name']}", "name": f"{r['title']} (Landsat)", "kind": "raster", "format": "webp",
            "description": "Landsat 8/9 cloud-free composite, 30 m. Transparent outside the region "
                           "and where there was no clear view.",
            "minzoom": r["zoom"][0], "maxzoom": r["zoom"][1], "bounds": [w, s, e, n],
            "attribution": r["credit"],
            "license": "U.S. Geological Survey data, public domain; credit requested. See /licensing.",
            "version": r["built_utc"], "provenance": f"/tiles/landsat/{r['name']}/PROVENANCE.json",
        })
    for layer in layers:
        layer["tiles"] = f"{base}/tiles/{layer['id']}/{{z}}/{{x}}/{{y}}.{layer['format']}"
        layer["tilejson"] = f"{base}/tiles/{layer['id']}/tilejson.json"
        layer["provenance"] = base + layer["provenance"]
    return layers


def vector_layers(base: str) -> list[dict]:
    rec = provenance(ROOT / "provenance" / "vectors.json")
    titles = {"country-borders": "Country borders", "us-states": "US states", "coastlines": "Coastlines"}
    out = []
    for name, v in (rec or {}).get("layers", {}).items():
        out.append({
            "id": name, "name": titles.get(name, name), "kind": "vector", "format": "geojson",
            "description": v["dataset"] + ". " + v["boundary_view"],
            "url": f"{base}/vectors/{name}.geojson", "features": v["output"]["features"], "bytes": v["output"]["bytes"],
            "attribution": NATURAL_EARTH, "license": "Public domain (Natural Earth). No attribution required.",
            "version": f"Natural Earth {v['natural_earth_version']}", "provenance": f"{base}/provenance/vectors.json",
        })
    return out


def tilejson(layer: dict) -> dict:
    w, s, e, n = layer["bounds"]
    return {
        "tilejson": "3.0.0",
        "name": layer["name"],
        "description": layer["description"],
        "version": layer["version"],
        "attribution": layer["attribution"],
        "scheme": "xyz",
        "tiles": [layer["tiles"]],
        "minzoom": layer["minzoom"],
        "maxzoom": layer["maxzoom"],
        "bounds": layer["bounds"],
        "center": [round((w + e) / 2, 4), round((s + n) / 2, 4), layer["minzoom"]],
        "format": layer["format"],
        "license": layer["license"],
        "provenance": layer["provenance"],
    }


def snippets(layer: dict) -> str:
    if layer["kind"] == "vector":
        return f"""// Leaflet
fetch("{layer['url']}").then((r) => r.json()).then((g) => L.geoJSON(g).addTo(map));

// MapLibre
map.addSource("{layer['id']}", {{ type: "geojson", data: "{layer['url']}" }});
map.addLayer({{ id: "{layer['id']}", type: "line", source: "{layer['id']}" }});

// Cesium
viewer.dataSources.add(Cesium.GeoJsonDataSource.load("{layer['url']}"));"""
    url = layer["tiles"]
    return f"""// Leaflet
L.tileLayer("{url}", {{ minZoom: {layer['minzoom']}, maxNativeZoom: {layer['maxzoom']}, attribution: '{layer['attribution'].replace("'", "&#39;")}' }}).addTo(map);

// MapLibre (reads the TileJSON)
map.addSource("{layer['id']}", {{ type: "raster", url: "{layer['tilejson']}", tileSize: 256 }});
map.addLayer({{ id: "{layer['id']}", type: "raster", source: "{layer['id']}" }});

// OpenLayers
new ol.layer.Tile({{ source: new ol.source.XYZ({{ url: "{url}", maxZoom: {layer['maxzoom']} }}) }});

// Cesium (doesn't read TileJSON, so pass the credit yourself)
viewer.imageryLayers.addImageryProvider(new Cesium.UrlTemplateImageryProvider({{
  url: "{url}",
  tilingScheme: new Cesium.WebMercatorTilingScheme(),
  maximumLevel: {layer['maxzoom']},{cesium_rect(layer)}
  credit: new Cesium.Credit('{layer['attribution'].replace("'", "&#39;")}', true),
}}));"""


def cesium_rect(layer: dict) -> str:
    """A region covers part of the world: tell Cesium where, so it only asks for tiles there."""
    if layer["bounds"] == WORLD:
        return ""
    w, s, e, n = layer["bounds"]
    return f"\n  minimumLevel: {layer['minzoom']},\n  rectangle: Cesium.Rectangle.fromDegrees({w}, {s}, {e}, {n}),"


def preview(layer: dict) -> str:
    """A representative tile to show on the index page."""
    if layer["kind"] == "vector":
        return ""
    z = layer["minzoom"]
    if layer["id"].startswith("landsat/"):
        idx = provenance(TILES / layer["id"] / "tiles.json")
        if idx:
            zs = sorted(idx["tiles"], key=int)
            z = int(zs[len(zs) // 2]) if zs else z
            xs = idx["tiles"][str(z)]
            x = sorted(xs, key=int)[len(xs) // 2]
            ys = xs[x]
            return tile_url(layer, z, int(x), ys[len(ys) // 2])
        # Built before tiles.json existed: of the tiles at the region's centre, one per zoom,
        # the biggest file (the one most filled with imagery)
        found = []
        for z in range(layer["minzoom"], layer["maxzoom"] + 1):
            x, y = centre_tile(layer["bounds"], z)
            f = TILES / layer["id"] / str(z) / str(x) / f"{y}.{layer['format']}"
            if f.exists():
                found.append((f.stat().st_size, z, x, y))
        return tile_url(layer, *max(found)[1:]) if found else ""
    return tile_url(layer, 0, 0, 0)


def tile_url(layer: dict, z: int, x: int, y: int) -> str:
    return layer["tiles"].replace("{z}", str(z)).replace("{x}", str(x)).replace("{y}", str(y))


def centre_tile(bounds: list[float], z: int) -> tuple[int, int]:
    """The XYZ tile containing the centre of a lon/lat bounding box."""
    w, s, e, n = bounds
    lat = math.radians((s + n) / 2)
    k = 2 ** z
    x = int((((w + e) / 2) + 180) / 360 * k)
    y = int((1 - math.log(math.tan(lat) + 1 / math.cos(lat)) / math.pi) / 2 * k)
    return x, y


def vector_thumbnail(layer_id: str, size: int = 128) -> str:
    """The layer's lines as a small inline SVG: Web Mercator, fitted to the data, points snapped
    to a half-pixel grid so even the 1.3 MB coastline file comes out at a few tens of KB."""
    path = ROOT / "public" / "vectors" / f"{layer_id}.geojson"
    if not path.exists():
        return ""

    def merc(lon: float, lat: float) -> tuple[float, float]:
        lat = max(-85.0511, min(85.0511, lat))
        return lon, math.degrees(math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)))

    lines = []
    for f in json.loads(path.read_text())["features"]:
        g = f.get("geometry") or {}
        parts = {"LineString": [g.get("coordinates")], "MultiLineString": g.get("coordinates"),
                 "Polygon": g.get("coordinates"),
                 "MultiPolygon": [r for p in g.get("coordinates") or [] for r in p]}.get(g.get("type"), [])
        lines += [[merc(*pt[:2]) for pt in line] for line in parts if line]
    if not lines:
        return ""
    xs = [x for line in lines for x, _ in line]
    ys = [y for line in lines for _, y in line]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    pad = 6
    k = (size - 2 * pad) / max(x1 - x0, y1 - y0)
    ox = (size - (x1 - x0) * k) / 2
    oy = (size - (y1 - y0) * k) / 2
    d = []
    for line in lines:
        pts = []
        for x, y in line:
            pt = (round(((x - x0) * k + ox) * 2) / 2, round(((y1 - y) * k + oy) * 2) / 2)
            if not pts or pts[-1] != pt:
                pts.append(pt)
        if len(pts) > 1:
            d.append("M" + "L".join(f"{x:g} {y:g}" for x, y in pts))
    return (f'<svg class="vec" viewBox="0 0 {size} {size}" role="img" aria-label="Preview of {layer_id}">'
            f'<path d="{"".join(d)}" fill="none" stroke="#e6e9ee" stroke-width=".6" stroke-linejoin="round"/></svg>')


def index_html(catalog: dict) -> str:
    rows = []
    for layer in catalog["layers"]:
        img = preview(layer)
        thumb = (f'<img src="{html.escape(img)}" alt="" loading="lazy">' if img else
                 vector_thumbnail(layer["id"]) if layer["kind"] == "vector" else "") or '<div class="vec"></div>'
        meta = (f'<a href="{html.escape(layer["tilejson"])}">TileJSON</a> · zoom {layer["minzoom"]}–{layer["maxzoom"]}'
                if layer["kind"] == "raster" else
                f'<a href="{html.escape(layer["url"])}">GeoJSON</a> · {layer["features"]:,} features')
        rows.append(f"""
      <article>
        {thumb}
        <div>
          <h2>{html.escape(layer["name"])} <code>{html.escape(layer["id"])}</code></h2>
          <p>{html.escape(layer["description"])}</p>
          <p class="meta">{meta} · <a href="{html.escape(layer["provenance"])}">provenance</a></p>
          <p class="meta">Attribution: {layer["attribution"]}</p>
          <details><summary>Use it</summary><pre>{html.escape(snippets(layer))}</pre></details>
        </div>
      </article>""")
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Blue Marble Globe map server</title>
  <style>
    :root {{ --bg: #0f141c; --fg: #e6e9ee; --muted: #9aa4b2; --line: rgba(255,255,255,.1); --accent: #7cb7ff; }}
    @media (prefers-color-scheme: light) {{ :root {{ --bg: #f6f7f9; --fg: #1b2027; --muted: #5b6573; --line: rgba(0,0,0,.1); --accent: #1f6fd1; }} }}
    body {{ margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
    main {{ max-width: 980px; margin: 0 auto; padding: 32px 16px 64px; }}
    h1 {{ margin: 0 0 4px; font-size: 26px; }}
    a {{ color: var(--accent); }}
    .lede, .meta {{ color: var(--muted); }}
    .meta {{ margin: 2px 0; font-size: 13px; }}
    article {{ display: grid; grid-template-columns: 128px minmax(0, 1fr); gap: 18px; padding: 20px 0; border-top: 1px solid var(--line); }}
    article img, .vec {{ width: 128px; height: 128px; border-radius: 8px; background: #3b3f45; object-fit: cover; }}
    h2 {{ margin: 0 0 4px; font-size: 18px; }}
    h2 code {{ font-size: 12px; color: var(--muted); font-weight: 400; }}
    p {{ margin: 0 0 6px; }}
    pre {{ overflow-x: auto; padding: 12px; border: 1px solid var(--line); border-radius: 8px; font-size: 12px; }}
    summary {{ cursor: pointer; color: var(--accent); font-size: 13px; }}
    @media (max-width: 560px) {{ article {{ grid-template-columns: 1fr; }} }}
  </style>
</head>
<body>
  <main>
    <h1>Map server</h1>
    <p class="lede">{len(catalog["layers"])} layers, built {html.escape(catalog["generated_utc"])}.
      Machine-readable: <a href="{html.escape(catalog["base_url"])}/catalog.json">catalog.json</a> ·
      licensing: <a href="{html.escape(catalog["base_url"])}/licensing">LICENSING.md</a> ·
      all provenance records: <a href="{html.escape(catalog["base_url"])}/provenance/">/provenance/</a></p>
    <p class="lede">Tiles are Web Mercator XYZ, 256 px. Tiles a layer deliberately doesn't have
      (ocean in Grey, empty areas of a region) answer <code>204 No Content</code>: treat them as blank.</p>
    {"".join(rows)}
  </main>
</body>
</html>
"""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default=ORIGIN, help="public URL of the server, e.g. https://maps.example.com")
    base = ap.parse_args().base_url.rstrip("/")

    layers = tiled_layers(base) + vector_layers(base)
    catalog = {
        "name": "Blue Marble Globe map server",
        "generated_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "base_url": base,
        "licensing": f"{base}/licensing",
        "layers": layers,
    }
    # Update the folder in place, never delete and recreate it: a running container has it
    # mounted and would go on serving the deleted folder (every request a 404).
    files = {WWW / "catalog.json": json.dumps(catalog, indent=2) + "\n", WWW / "index.html": index_html(catalog)}
    for layer in layers:
        if layer["kind"] == "raster":
            files[WWW / "tilejson" / f"{layer['id']}.json"] = json.dumps(tilejson(layer), indent=2) + "\n"
    for path, text in files.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(text)
        os.replace(tmp, path)  # each file swaps in whole, so the server never sends half of one
    for path in sorted(WWW.rglob("*"), reverse=True):  # layers that no longer exist
        if path.is_file() and path not in files:
            path.unlink()
        elif path.is_dir() and not any(path.iterdir()):
            path.rmdir()
    print(f"{len(layers)} layers -> {WWW.relative_to(ROOT)}/ (base URL: {"each request's own address" if base == ORIGIN else base})")
    for layer in layers:
        print(f"  {layer['kind']:<6} {layer['id']}")


if __name__ == "__main__":
    main()
