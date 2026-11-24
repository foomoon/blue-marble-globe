// Where the map data comes from, shown top right under Layers/Guide: this site's own files, or a
// map server (VITE_MAP_SERVER_URL), with a dot for whether that server is answering. The dot
// follows the data requests themselves: a tile or file that arrives proves the server is up (green,
// no extra request); one that fails prompts a health check straight away. A health check also runs
// every 30 s, for when nothing is loading, and gives up after 4 s: a paused server just hangs.
import { mapServer, servedByMapServer } from "./data.js";
import "./datasource.css";

const RECHECK_MS = 30_000;
const CHECK_TIMEOUT_MS = 4_000; // no answer by then counts as not answering
const AFTER_FAILURE_MS = 1_000; // a burst of failures (the server just went down) gives one check

export function mountDataSource(parent = document.body) {
  const badge = document.createElement("div");
  badge.className = "data-source";
  badge.setAttribute("role", "status");
  badge.innerHTML = `<i aria-hidden="true"></i><span></span>`;
  const text = badge.querySelector("span");
  parent.append(badge);

  if (!mapServer && !servedByMapServer) {
    badge.dataset.state = "local";
    text.textContent = "Data: local";
    badge.title = "Map data comes straight from this site's own files (public/tiles and public/vectors).";
    return;
  }

  // Served by the map server itself (/globe/), or pointed at one (VITE_MAP_SERVER_URL)
  text.textContent = servedByMapServer ? "Data: this server" : "Data: map server";
  const where = servedByMapServer ? `this map server (${location.origin})` : `the map server at ${mapServer}`;
  const show = (ok, how) => {
    badge.dataset.state = ok ? "online" : "offline";
    badge.title = `Map data comes from ${where}. ` +
      (ok ? "It's answering" : "It isn't answering: is it running (npm run server:up) and not paused in Docker? Or check the address") +
      ` (${how}, ${new Date().toLocaleTimeString()}).`;
  };
  const check = async () => {
    let ok = false;
    try {
      // A time limit: a paused or overloaded server doesn't refuse requests, it leaves them hanging
      ok = (await fetch(`${mapServer}/healthz`, { cache: "no-store", signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) })).ok;
    } catch {}
    show(ok, "health check");
  };
  // The data requests themselves: success shows green at once; a failure prompts a check soon
  let pending = null;
  document.addEventListener("data:response", (e) => {
    if (e.detail.ok) {
      if (badge.dataset.state !== "online") show(true, "data arriving");
    } else if (!pending) {
      pending = setTimeout(() => ((pending = null), check()), AFTER_FAILURE_MS);
    }
  });
  badge.dataset.state = "checking";
  badge.title = `Map data comes from ${where}. Checking it…`;
  check();
  setInterval(check, RECHECK_MS);
}
