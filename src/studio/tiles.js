// Web Mercator tile math for region estimates. Counts are exact; sizes are estimates.

const MAX_LAT = 85.0511287798;
const clampLat = (lat) => Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));

/** Fractional tile coordinates at zoom z (y counts down from the top, as in XYZ). */
export const tileXf = (lon, z) => ((lon + 180) / 360) * 2 ** z;
export function tileYf(lat, z) {
  const r = (clampLat(lat) * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}
export const lonToX = (lon, z) => Math.floor(tileXf(lon, z));
export const latToY = (lat, z) => Math.floor(tileYf(lat, z));

/** Number of XYZ tiles that intersect bbox [w, s, e, n] at zoom z. */
export function tilesAt([w, s, e, n], z) {
  const last = 2 ** z - 1;
  const x0 = lonToX(w, z), x1 = Math.min(lonToX(e, z), last);
  const y0 = latToY(n, z), y1 = Math.min(latToY(s, z), last);
  return (x1 - x0 + 1) * (y1 - y0 + 1);
}

// ---- polygons (in tile space, where every tile is a unit square) ----

function pointInPolygon([x, y], pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segmentsCross([ax, ay], [bx, by], [cx, cy], [dx, dy]) {
  const d = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
  if (d === 0) return false;
  const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / d;
  const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

function squareTouchesPolygon(x, y, pts) {
  const corners = [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]];
  if (corners.some((c) => pointInPolygon(c, pts))) return true;
  if (pts.some(([px, py]) => px >= x && px <= x + 1 && py >= y && py <= y + 1)) return true;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    for (let k = 0; k < 4; k++) if (segmentsCross(a, b, corners[k], corners[(k + 1) % 4])) return true;
  }
  return false;
}

const shoelace = (pts) => Math.abs(pts.reduce((a, [x, y], i) => {
  const [x2, y2] = pts[(i + 1) % pts.length];
  return a + x * y2 - x2 * y;
}, 0)) / 2;

const MAX_EXACT = 250_000; // tiles per level checked one by one; beyond this, estimate by area

/** Tiles touching a polygon at zoom z: { tiles, exact }. */
export function polygonTilesAt(boundary, z) {
  const pts = boundary.map(([lon, lat]) => [tileXf(lon, z), tileYf(lat, z)]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const last = 2 ** z - 1;
  const x0 = Math.floor(Math.min(...xs)), x1 = Math.min(Math.floor(Math.max(...xs)), last);
  const y0 = Math.floor(Math.min(...ys)), y1 = Math.min(Math.floor(Math.max(...ys)), last);
  const boxTiles = (x1 - x0 + 1) * (y1 - y0 + 1);
  if (boxTiles > MAX_EXACT) {
    const ratio = shoelace(pts) / ((Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys)) || 1);
    return { tiles: Math.ceil(boxTiles * Math.min(1, ratio * 1.05)), exact: false };
  }
  let tiles = 0;
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) if (squareTouchesPolygon(x, y, pts)) tiles++;
  return { tiles, exact: true };
}

export const bboxOf = (boundary) => {
  const lons = boundary.map((p) => p[0]), lats = boundary.map((p) => p[1]);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
};

// Average JPEG/WebP size for detailed Landsat land tiles (an estimate;
// the Blue Marble tiles average ~4 KB, but those are mostly smooth ocean).
export const BYTES_PER_TILE = 20_000;

/** Tile counts per zoom for a region: a bbox, or a polygon boundary if given. */
export function estimate(bbox, [z0, z1], boundary) {
  const levels = [];
  for (let z = z0; z <= z1; z++) {
    levels.push(boundary ? { z, ...polygonTilesAt(boundary, z) } : { z, tiles: tilesAt(bbox, z), exact: true });
  }
  const tiles = levels.reduce((a, l) => a + l.tiles, 0);
  return { levels, tiles, bytes: tiles * BYTES_PER_TILE, exact: levels.every((l) => l.exact) };
}

const R_KM = 6371.0088, RAD = Math.PI / 180;

/** Ground area of bbox in km² (spherical). */
export function areaKm2([w, s, e, n]) {
  return R_KM * R_KM * (e - w) * RAD * Math.abs(Math.sin(n * RAD) - Math.sin(s * RAD));
}

/** Ground area of a lon/lat polygon in km² (spherical, via the trapezoid rule on sin(lat)). */
export function polygonAreaKm2(boundary) {
  let sum = 0;
  for (let i = 0; i < boundary.length; i++) {
    const [lon1, lat1] = boundary[i], [lon2, lat2] = boundary[(i + 1) % boundary.length];
    sum += (lon2 - lon1) * RAD * (2 + Math.sin(lat1 * RAD) + Math.sin(lat2 * RAD));
  }
  return Math.abs((sum * R_KM * R_KM) / 2);
}

export const fmtBytes = (b) =>
  b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`;
export const fmtInt = (n) => Math.round(n).toLocaleString("en-US");
