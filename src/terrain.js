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
import { noteResponse } from "./data.js";

const N = 65; // heights per side of a Cesium terrain tile
const CACHE = 300; // decoded files kept (256 KB each)
const MAX_LAT = Cesium.Math.toRadians(85.0511287798);

/**
 * Reads heights from one or more tile sets: one shared decoder and cache, used by the terrain,
 * the relief shading and the readout. Sources are in priority order (regions first, the global
 * terrain last): at each point, the first source with a tile there wins.
 *
 * Each source: { name, label, url, available (Set of "z/x/y"), minzoom, maxzoom, detail (its
 * native spacing, m), shareInBlue }. Region tiles (shareInBlue) keep in their blue channel the
 * share of the regional data in each height (0-255; it blends into the global terrain at the
 * region's edge); in global tiles blue is Terrarium's 1/256 m.
 */
export function heightSource(sources) {
  const cache = new Map(); // "source/z/x/y" -> Promise<{h, share} | null>, least recently used first

  function file(si, z, x, y) {
    const src = sources[si];
    if (!src.available.has(`${z}/${x}/${y}`)) return null;
    const key = `${si}/${z}/${x}/${y}`;
    let p = cache.get(key);
    if (p) cache.delete(key);
    else {
      p = decode(src.url.replace("{z}", z).replace("{x}", x).replace("{y}", y), src.shareInBlue);
      p.catch(() => cache.delete(key)); // a failed request can be tried again
    }
    cache.set(key, p);
    if (cache.size > CACHE) cache.delete(cache.keys().next().value);
    return p;
  }

  /** Which source and zoom serve a point (u, v: Web Mercator, 0-1) at a given level. */
  function pick(level, u, v) {
    for (let si = 0; si < sources.length; si++) {
      const src = sources[si];
      const z = Math.min(level, src.maxzoom);
      if (z < src.minzoom) continue;
      const n = 2 ** z;
      const fx = Math.min(n - 1, Math.floor(u * n)), fy = Math.min(n - 1, Math.max(0, Math.floor(v * n)));
      if (si === sources.length - 1 || src.available.has(`${z}/${fx}/${fy}`)) return [si, z];
    }
  }

  /**
   * Heights at many points: `uv` is [u0, v0, u1, v1, ...] in Web Mercator (0-1). Interpolates
   * between the four nearest pixels (values sit at pixel centres) of the source picked for each
   * point. With `share`, also fills in each point's regional share (0 where the global terrain
   * serves it) and `picked`, the source index per point.
   */
  async function sample(level, uv, out, share, picked) {
    const count = uv.length / 2;
    const choice = new Array(count);
    const files = new Map();
    const need = (si, z, gx, gy) => {
      const size = 256 * 2 ** z;
      gx = ((gx % size) + size) % size;
      gy = Math.min(size - 1, Math.max(0, gy));
      const key = `${si}/${z}/${gx >> 8}/${gy >> 8}`;
      if (!files.has(key)) files.set(key, file(si, z, gx >> 8, gy >> 8));
    };
    for (let i = 0; i < count; i++) {
      const [si, z] = pick(level, uv[2 * i], uv[2 * i + 1]);
      choice[i] = [si, z];
      const size = 256 * 2 ** z;
      const px = Math.floor(uv[2 * i] * size - 0.5), py = Math.floor(uv[2 * i + 1] * size - 0.5);
      need(si, z, px, py); need(si, z, px + 1, py); need(si, z, px, py + 1); need(si, z, px + 1, py + 1);
    }
    const loaded = new Map();
    await Promise.all([...files].map(async ([k, p]) => loaded.set(k, p ? await p : null)));
    for (let i = 0; i < count; i++) {
      const [si, z] = choice[i];
      const size = 256 * 2 ** z;
      const x = uv[2 * i] * size - 0.5, y = uv[2 * i + 1] * size - 0.5;
      const x0 = Math.floor(x), y0 = Math.floor(y), wx = x - x0, wy = y - y0;
      // A neighbour in a file this source doesn't have (the edge of a region's tiles) takes the
      // point's own pixel: by then the region has blended into the global heights anyway
      const own = cell(loaded, si, z, size, Math.round(x), Math.round(y));
      const at = (gx, gy, field) => cell(loaded, si, z, size, gx, gy)?.[field] ?? own?.[field] ?? 0;
      const lerp = (field) =>
        (at(x0, y0, field) * (1 - wx) + at(x0 + 1, y0, field) * wx) * (1 - wy) +
        (at(x0, y0 + 1, field) * (1 - wx) + at(x0 + 1, y0 + 1, field) * wx) * wy;
      out[i] = lerp("h");
      if (share) share[i] = sources[si].shareInBlue ? lerp("share") : 0;
      if (picked) picked[i] = si;
    }
    return out;
  }

  return { sources, sample, pick };
}

/** One pixel of a loaded file: { h, share } or undefined where the file doesn't exist. */
function cell(loaded, si, z, size, gx, gy) {
  gx = ((gx % size) + size) % size; // wraps at the antimeridian
  gy = Math.min(size - 1, Math.max(0, gy));
  const f = loaded.get(`${si}/${z}/${gx >> 8}/${gy >> 8}`);
  if (!f) return undefined;
  const i = (gy & 255) * 256 + (gx & 255);
  return { h: f.h[i], share: f.share ? f.share[i] / 255 : 0 };
}

/** Web Mercator v (0 at the top, 1 at the bottom) of a latitude in radians, clamped to the grid. */
const mercV = (lat) => {
  const l = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  return (1 - Math.log(Math.tan(l) + 1 / Math.cos(l)) / Math.PI) / 2;
};

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
      const uv = new Float64Array(N * N * 2);
      for (let j = 0; j < N; j++) {
        const v = mercV(r.north - (j / (N - 1)) * (r.north - r.south));
        for (let i = 0; i < N; i++) {
          uv[(j * N + i) * 2] = (r.west + (i / (N - 1)) * (r.east - r.west) + Math.PI) / (2 * Math.PI);
          uv[(j * N + i) * 2 + 1] = v;
        }
      }
      // A geographic tile at level L has about the detail of a Web Mercator tile at zoom L
      return source.sample(level, uv, new Float32Array(N * N));
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
    // Slopes are measured across one pixel of the source's own files (k tile pixels): deeper
    // than the files go, heights are interpolated flat between file pixels, and slopes measured
    // across one tile pixel would show those flat facets as squares
    const size = 256 * 2 ** level;
    const [, zf] = source.pick(level, (x + 0.5) / 2 ** level, (y + 0.5) / 2 ** level);
    const k = Math.min(16, 2 ** (level - zf));
    // The tile plus a k-pixel border, for the slopes at its edges
    const W = 256 + 2 * k;
    const uv = new Float64Array(W * W * 2);
    for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
      uv[(j * W + i) * 2] = (x * 256 + i - k + 0.5) / size;
      uv[(j * W + i) * 2 + 1] = (y * 256 + j - k + 0.5) / size;
    }
    const h = await source.sample(level, uv, new Float32Array(W * W));
    if (!h.some((v) => v > 0)) return empty;
    // Ground size of one tile pixel at this tile's latitude
    const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / 2 ** level)));
    const cell = ((2 * Math.PI * 6378137) / (256 * 2 ** level)) * Math.cos(lat);
    const canvas = Object.assign(document.createElement("canvas"), { width: 256, height: 256 });
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(256, 256);
    for (let j = 0; j < 256; j++) {
      for (let i = 0; i < 256; i++) {
        const c = (j + k) * W + (i + k);
        const dzdx = ((h[c + k] - h[c - k]) * strength) / (2 * k * cell);
        const dzdy = ((h[c + k * W] - h[c - k * W]) * strength) / (2 * k * cell); // +y is south
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

async function decode(href, shareInBlue) {
  let res;
  try {
    res = await fetch(href);
    noteResponse(res.status < 500); // for the data source indicator
  } catch (err) {
    noteResponse(false);
    throw err;
  }
  if (!res.ok) throw new Error(`${res.status} ${href}`);
  // The colours are data, not a picture: no colour management, no premultiplied alpha
  const bitmap = await createImageBitmap(await res.blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const ctx = new OffscreenCanvas(256, 256).getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const rgba = ctx.getImageData(0, 0, 256, 256).data;
  const h = new Float32Array(256 * 256);
  const share = shareInBlue ? new Uint8Array(256 * 256) : null;
  for (let i = 0; i < h.length; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    if (share) {
      h[i] = r * 256 + g - 32768; // whole metres; blue is the regional share
      share[i] = b;
    } else h[i] = r * 256 + g + b / 256 - 32768;
  }
  return { h, share };
}
