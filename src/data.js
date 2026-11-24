// Where the globe gets its map data: its own site (the default), or a map server.
//
//   VITE_MAP_SERVER_URL=http://localhost:8080 npm run dev     (or npm run build)
//
// The map server (npm run server:up) serves the same files at the same paths (/tiles/...,
// /vectors/...), from the same public/ folders, so a URL is just prefixed with its address.
const SERVER = (import.meta.env.VITE_MAP_SERVER_URL ?? "").replace(/\/+$/, "");

/** The URL to load a data path from ("/tiles/..." or "/vectors/..."); other paths unchanged. */
export const dataUrl = (path) => (SERVER && /^\/(tiles|vectors)\//.test(path) ? SERVER + path : path);

/** The map server in use, or "" for the globe's own site. */
export const mapServer = SERVER;

/** Whether this globe is the one the map server itself serves (at /globe/): its own site *is* the
 * map server, so data comes from there without an address. */
export const servedByMapServer = import.meta.env.VITE_SERVED_BY_MAP_SERVER === "1";

/**
 * Tell the data source indicator how a request to the map server went: true when it answered
 * (any HTTP status: it's up), false when it didn't (a network error). Nothing to tell for local files.
 */
export function noteResponse(ok) {
  if (SERVER || servedByMapServer) document.dispatchEvent(new CustomEvent("data:response", { detail: { ok } }));
}

const TIMEOUT_MS = 8_000;

/**
 * fetch() for map data, reporting to the indicator. Same arguments and result as fetch, with a
 * time limit: a server that's paused or overloaded doesn't refuse requests, it leaves them hanging.
 */
export async function dataFetch(path, init = {}) {
  try {
    const res = await fetch(dataUrl(path), { signal: AbortSignal.timeout(TIMEOUT_MS), ...init });
    noteResponse(res.status < 500);
    return res;
  } catch (err) {
    noteResponse(false);
    throw err;
  }
}

/** Make a Cesium imagery provider report each tile download to the indicator. */
export function reportingTiles(provider) {
  const load = provider.requestImage.bind(provider);
  provider.requestImage = (...args) => {
    const image = load(...args); // undefined when Cesium's queue is full (it asks again later)
    image?.then(() => noteResponse(true), () => noteResponse(false));
    return image;
  };
  return provider;
}

/** Whether a tile or file exists. A map server answers a missing tile 204 (blank), not 404. */
export const exists = (path) => dataFetch(path, { method: "HEAD" }).then((r) => r.status === 200, () => false);
