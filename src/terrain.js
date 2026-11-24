// Terrain from elevation tiles: 256 x 256 images whose colours encode height ("Terrarium":
// height_m = R * 256 + G + B / 256 - 32768), as scripts/build_terrain.py writes them. The same
// tiles work in MapLibre as a raster-dem source.
//
// The files are on the Web Mercator grid, which stops at 85.05° N/S. Cesium's terrain uses its
// own latitude/longitude grid here instead, which covers the poles: each terrain tile samples the
// files at its own 65 x 65 points, and beyond 85.05° the heights carry on from the edge (so the
// Antarctic plateau reaches the pole rather than dropping to sea level). Tiles the build didn't
// write are all sea: height 0.
import * as Cesium from "cesium";

const N = 65; // heights per side of a Cesium terrain tile
const CACHE = 300; // decoded files kept (256 KB each)
const MAX_LAT = Cesium.Math.toRadians(85.0511287798);

/**
 * Reads heights from the tiles: one shared decoder, used by the terrain and the relief shading.
 * @param {object} options
 * @param {string} options.url             tile URL template, e.g. "/tiles/terrain/{z}/{x}/{y}.webp"
 * @param {Set<string>} options.available  "z/x/y" of every tile that exists (from tiles.json)
 * @param {number} options.maxzoom         the deepest zoom built
 */
export function heightSource({ url, available, maxzoom }) {
  const cache = new Map(); // "z/x/y" -> Promise<Float32Array | null>, least recently used first

  /** Heights of one file, or null where the build wrote none (sea). */
  function file(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (!available.has(key)) return Promise.resolve(null);
    let p = cache.get(key);
    if (p) cache.delete(key);
    else {
      p = decode(url.replace("{z}", z).replace("{x}", x).replace("{y}", y));
      p.catch(() => cache.delete(key)); // a failed request can be tried again
    }
    cache.set(key, p);
    if (cache.size > CACHE) cache.delete(cache.keys().next().value);
    return p;
  }

  /**
   * Heights at many points on the zoom-z pixel grid (pixel centres at +0.5): loads the files they
   * fall in, then interpolates between the four nearest pixels. `points` is [x0, y0, x1, y1, ...].
   */
  async function sample(z, points, out) {
    const size = 256 * 2 ** z;
    const files = new Map();
    for (let i = 0; i < points.length; i += 2) {
      const px = Math.floor(points[i] - 0.5), py = Math.floor(points[i + 1] - 0.5);
      for (const gx of [px, px + 1]) for (const gy of [py, py + 1]) {
        const fx = (((gx % size) + size) % size) >> 8, fy = Math.min(size - 1, Math.max(0, gy)) >> 8;
        const key = `${fx}/${fy}`;
        if (!files.has(key)) files.set(key, file(z, fx, fy));
      }
    }
    const loaded = new Map();
    await Promise.all([...files].map(async ([k, p]) => loaded.set(k, await p)));
    const at = (gx, gy) => {
      gx = ((gx % size) + size) % size; // wraps at the antimeridian
      gy = Math.min(size - 1, Math.max(0, gy));
      const h = loaded.get(`${gx >> 8}/${gy >> 8}`);
      return h ? h[(gy & 255) * 256 + (gx & 255)] : 0;
    };
    for (let i = 0, o = 0; i < points.length; i += 2, o++) {
      const x = points[i] - 0.5, y = points[i + 1] - 0.5;
      const x0 = Math.floor(x), y0 = Math.floor(y), wx = x - x0, wy = y - y0;
      out[o] = (at(x0, y0) * (1 - wx) + at(x0 + 1, y0) * wx) * (1 - wy) + (at(x0, y0 + 1) * (1 - wx) + at(x0 + 1, y0 + 1) * wx) * wy;
    }
    return out;
  }

  return { maxzoom, file, sample };
}

/** Cesium terrain from a heightSource. */
export function terrainProvider(source, { credit } = {}) {
  const tilingScheme = new Cesium.GeographicTilingScheme();
  return new Cesium.CustomHeightmapTerrainProvider({
    width: N,
    height: N,
    tilingScheme,
    credit,
    callback: (x, y, level) => {
      const r = tilingScheme.tileXYToRectangle(x, y, level);
      // A geographic tile at level L has about the detail of a Web Mercator tile at zoom L
      const z = Math.min(level, source.maxzoom);
      const size = 256 * 2 ** z;
      const points = new Float64Array(N * N * 2);
      for (let j = 0; j < N; j++) {
        const lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, r.north - (j / (N - 1)) * (r.north - r.south)));
        const py = ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * size;
        for (let i = 0; i < N; i++) {
          const lon = r.west + (i / (N - 1)) * (r.east - r.west);
          points[(j * N + i) * 2] = ((lon + Math.PI) / (2 * Math.PI)) * size;
          points[(j * N + i) * 2 + 1] = py;
        }
      }
      return source.sample(z, points, new Float32Array(N * N));
    },
  });
}

/**
 * Relief shading ("hillshade") as an imagery layer, computed in the browser from the same heights:
 * slopes facing the light (from the north-west, 45° up, the cartographic convention) get lighter,
 * slopes facing away darker, flat ground stays transparent. For base maps without shading of
 * their own (Grey, None); Blue Marble's photos already have it.
 */
export function reliefProvider(source, { strength = 2 } = {}) {
  const empty = Object.assign(document.createElement("canvas"), { width: 1, height: 1 });
  const provider = new Cesium.UrlTemplateImageryProvider({
    url: "relief/{z}/{x}/{y}", // never requested: requestImage below draws each tile
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
    maximumLevel: 13,
  });
  const az = Cesium.Math.toRadians(315), zen = Cesium.Math.toRadians(45);
  const flat = Math.cos(zen);
  provider.requestImage = async (x, y, level) => {
    const z = Math.min(level, source.maxzoom);
    const k = 2 ** (level - z); // tile pixels per file pixel
    // 258 x 258 heights: the tile plus a 1-pixel border, for the slopes at its edges
    const W = 258;
    const points = new Float64Array(W * W * 2);
    for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
      points[(j * W + i) * 2] = (x * 256 + i - 1 + 0.5) / k;
      points[(j * W + i) * 2 + 1] = (y * 256 + j - 1 + 0.5) / k;
    }
    const h = await source.sample(z, points, new Float32Array(W * W));
    if (!h.some((v) => v > 0)) return empty;
    // Ground size of one tile pixel at this tile's latitude
    const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / 2 ** level)));
    const cell = ((2 * Math.PI * 6378137) / (256 * 2 ** level)) * Math.cos(lat);
    const canvas = Object.assign(document.createElement("canvas"), { width: 256, height: 256 });
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(256, 256);
    for (let j = 0; j < 256; j++) {
      for (let i = 0; i < 256; i++) {
        const c = (j + 1) * W + (i + 1);
        const dzdx = ((h[c + 1] - h[c - 1]) * strength) / (2 * cell);
        const dzdy = ((h[c + W] - h[c - W]) * strength) / (2 * cell); // +y is south
        const slope = Math.atan(Math.hypot(dzdx, dzdy));
        const aspect = Math.atan2(dzdy, -dzdx);
        const shade = Math.cos(zen) * Math.cos(slope) + Math.sin(zen) * Math.sin(slope) * Math.cos(az - Math.PI / 2 - aspect);
        const v = shade - flat; // < 0: in shadow, > 0: lit
        const o = (j * 256 + i) * 4;
        const c8 = v < 0 ? 0 : 255;
        img.data[o] = img.data[o + 1] = img.data[o + 2] = c8;
        img.data[o + 3] = Math.min(150, Math.abs(v) * (v < 0 ? 420 : 260));
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  };
  return provider;
}

async function decode(href) {
  const res = await fetch(href);
  if (!res.ok) throw new Error(`${res.status} ${href}`);
  // The colours are data, not a picture: no colour management, no premultiplied alpha
  const bitmap = await createImageBitmap(await res.blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const ctx = new OffscreenCanvas(256, 256).getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const rgba = ctx.getImageData(0, 0, 256, 256).data;
  const h = new Float32Array(256 * 256);
  for (let i = 0; i < h.length; i++) h[i] = rgba[i * 4] * 256 + rgba[i * 4 + 1] + rgba[i * 4 + 2] / 256 - 32768;
  return h;
}
