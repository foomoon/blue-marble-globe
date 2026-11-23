// Layers control: switch the Blue Marble base map and each built Landsat region on
// and off, and set region opacity. Works in production: built regions are listed in
// /tiles/landsat/index.json, which scripts/build_region.py writes after every build.
import * as Cesium from "cesium";
import "./layers.css";

const STORE = "layers";

// Vector layers shipped with the app (see scripts/fetch_vectors.py and provenance/vectors.json).
// Listed in this order; drawn bottom to top by `drawOrder`, so state lines sit under country borders.
const BORDER = Cesium.Color.WHITE.withAlpha(0.75);
const STATE = Cesium.Color.WHITE.withAlpha(0.4);
const VECTORS = [
  {
    name: "country-borders",
    title: "Country borders",
    detail: "Natural Earth · 1:50m · dashed = disputed",
    url: "/vectors/country-borders.geojson",
    drawOrder: 2,
    style: (props) =>
      props.kind === "disputed"
        ? { width: 1.5, material: new Cesium.PolylineDashMaterialProperty({ color: BORDER, dashLength: 10 }) }
        : { width: 1.25, material: new Cesium.ColorMaterialProperty(BORDER) },
  },
  {
    name: "us-states",
    title: "US states",
    detail: "Natural Earth · 1:50m",
    url: "/vectors/us-states.geojson",
    drawOrder: 1,
    style: () => ({ width: 1, material: new Cesium.ColorMaterialProperty(STATE) }),
  },
];
// Tiles a build didn't write (empty, or outside a polygon) get this instead of a request that would 404
const EMPTY_TILE = Object.assign(document.createElement("canvas"), { width: 1, height: 1 });

const load = () => {
  try {
    return JSON.parse(localStorage.getItem(STORE)) ?? {};
  } catch {
    return {};
  }
};
const store = (prefs) => {
  try {
    localStorage.setItem(STORE, JSON.stringify(prefs));
  } catch {}
};

/** An imagery layer for a built region; `available` (a Set of "z/x/y") skips tiles that don't exist. */
export function regionProvider(region, { url = region.url, available } = {}) {
  const provider = new Cesium.UrlTemplateImageryProvider({
    url,
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
    rectangle: Cesium.Rectangle.fromDegrees(...region.bbox),
    minimumLevel: region.zoom[0],
    maximumLevel: region.zoom[1],
    credit: new Cesium.Credit(region.credit ?? "Landsat imagery courtesy of the U.S. Geological Survey", true),
  });
  provider.errorEvent.addEventListener((e) => (e.retry = false));
  if (available) {
    const request = provider.requestImage.bind(provider);
    provider.requestImage = (x, y, level, req) =>
      available.has(`${level}/${x}/${y}`) ? request(x, y, level, req) : Promise.resolve(EMPTY_TILE);
  }
  return provider;
}

/**
 * The layer for a region, hidden when zoomed out past its minimum zoom (so "zoom 8–12" means
 * what it says). Past the maximum it stays, enlarged: that's still sharper than Blue Marble.
 * Cesium's globe tiles start at 2 across where Web Mercator starts at 1, so globe level L ≈ zoom L+1.
 */
export function regionLayer(region, opts) {
  return new Cesium.ImageryLayer(regionProvider(region, opts), { minimumTerrainLevel: Math.max(0, region.zoom[0] - 1) });
}

async function availability(region) {
  if (!region.tiles_index) return null; // older builds: request every tile in the bbox
  try {
    const res = await fetch(region.tiles_index);
    if (!res.ok) return null;
    const set = new Set();
    for (const [z, xs] of Object.entries((await res.json()).tiles))
      for (const [x, ys] of Object.entries(xs)) for (const y of ys) set.add(`${z}/${x}/${y}`);
    return set;
  } catch {
    return null;
  }
}

export function mountLayers(viewer, baseLayer) {
  const prefs = load();
  const regions = new Map(); // name -> { region, layer }
  const suspended = new Set(); // regions hidden while the studio rebuilds them
  const vectorSources = new Map(); // name -> GeoJsonDataSource

  const toggle = el("button", "layers-toggle", "Layers");
  toggle.setAttribute("aria-expanded", "false");
  const pop = el("div", "layers-pop");
  pop.hidden = true;
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Map layers");
  document.body.append(toggle, pop);

  toggle.addEventListener("click", () => {
    pop.hidden = !pop.hidden;
    toggle.setAttribute("aria-expanded", String(!pop.hidden));
  });
  const close = () => {
    pop.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
  };
  document.addEventListener("keydown", (e) => e.key === "Escape" && !pop.hidden && close());
  // Like a menu: clicking anywhere else (the globe, the Guide button) closes it
  document.addEventListener("pointerdown", (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !toggle.contains(e.target)) close();
  });

  const isOn = (name, fallback = true) => prefs[name]?.on ?? fallback;
  const opacity = (name) => prefs[name]?.opacity ?? 1;
  const set = (name, patch) => {
    prefs[name] = { ...prefs[name], ...patch };
    store(prefs);
  };

  baseLayer.show = isOn("blue-marble");

  function apply(name) {
    const entry = regions.get(name);
    if (!entry?.layer) return;
    entry.layer.show = isOn(name) && !suspended.has(name);
    entry.layer.alpha = opacity(name);
  }

  function render() {
    pop.innerHTML = `<div class="layers-head">Layers</div>`;
    const list = el("ul", "layers-list");
    list.append(row({ name: "blue-marble", title: "Blue Marble", detail: "NASA · global base map, 500 m" }, false));
    for (const v of VECTORS) list.append(row(v, false));
    const sorted = [...regions.values()].map((e) => e.region).sort((a, b) => a.title.localeCompare(b.title));
    for (const r of sorted) {
      list.append(row({ name: r.name, title: r.title, detail: `Landsat · 30 m · shown from zoom ${r.zoom[0]}`, region: r }, true));
    }
    if (!sorted.length) list.append(Object.assign(el("li", "layers-empty"), { textContent: "No regional layers built yet" }));
    pop.append(list);
  }

  function row({ name, title, detail, region }, hasOpacity) {
    const li = el("li", "layers-row");
    const id = `layer-${name}`;
    li.innerHTML = `<input type="checkbox" id="${id}"><label for="${id}"><strong></strong><span></span></label>`;
    li.querySelector("strong").textContent = title;
    li.querySelector("span").textContent = suspended.has(name) ? "rebuilding…" : detail;
    const box = li.querySelector("input");
    box.setAttribute("aria-label", title); // the detail line stays visible but isn't part of the name
    box.checked = isOn(name);
    box.addEventListener("change", () => {
      set(name, { on: box.checked });
      if (name === "blue-marble") baseLayer.show = box.checked;
      else if (vectorSources.has(name)) vectorSources.get(name).show = box.checked;
      else apply(name);
      slider && (slider.disabled = !box.checked);
    });
    let slider = null;
    if (hasOpacity) {
      const fly = el("button", "layers-fly", "Go");
      fly.title = `Fly to ${title}`;
      fly.addEventListener("click", () =>
        viewer.camera.flyTo({ destination: Cesium.Rectangle.fromDegrees(...region.bbox), duration: 1.2 }),
      );
      slider = Object.assign(document.createElement("input"), { type: "range", min: 0, max: 1, step: 0.05, value: opacity(name) });
      slider.className = "layers-opacity";
      slider.setAttribute("aria-label", `${title} opacity`);
      slider.disabled = !box.checked;
      slider.addEventListener("input", () => {
        set(name, { opacity: Number(slider.value) });
        apply(name);
      });
      li.append(fly, slider);
    }
    return li;
  }

  /** Re-read the index of built regions and sync the globe's layers with it. */
  async function refresh() {
    let index = [];
    try {
      const res = await fetch(`/tiles/landsat/index.json?t=${Date.now()}`);
      if (res.ok) index = (await res.json()).regions ?? [];
    } catch {}
    const names = new Set(index.map((r) => r.name));
    for (const [name, entry] of regions) {
      if (!names.has(name) || entry.region.built_utc !== index.find((r) => r.name === name).built_utc) {
        if (entry.layer) viewer.imageryLayers.remove(entry.layer);
        regions.delete(name);
      }
    }
    for (const r of index) {
      if (regions.has(r.name)) continue;
      const entry = { region: r, layer: null };
      regions.set(r.name, entry);
      const available = await availability(r);
      if (regions.get(r.name) !== entry) continue; // replaced while loading
      entry.layer = viewer.imageryLayers.add(regionLayer(r, { url: `${r.url}?b=${encodeURIComponent(r.built_utc)}`, available }));
      apply(r.name);
    }
    render();
  }

  /** Hide a region's layer while it's being rebuilt (the studio shows a live layer instead). */
  function suspend(name, on) {
    on ? suspended.add(name) : suspended.delete(name);
    apply(name);
    render();
  }

  async function loadVector(v) {
    try {
      const ds = await Cesium.GeoJsonDataSource.load(v.url);
      for (const e of ds.entities.values) {
        if (!e.polyline) continue;
        const { width, material } = v.style({ kind: e.properties?.kind?.getValue() });
        e.polyline.width = width;
        e.polyline.material = material;
        e.polyline.arcType = Cesium.ArcType.GEODESIC;
      }
      ds.show = isOn(v.name);
      vectorSources.set(v.name, ds);
      return ds;
    } catch (err) {
      console.warn(`Couldn't load ${v.title}:`, err);
    }
  }

  render();
  // Load in parallel, then add bottom-to-top so the draw order is fixed whatever finishes first
  const vectorsReady = Promise.all(VECTORS.map(loadVector)).then(async (sources) => {
    const order = VECTORS.map((v, i) => [v.drawOrder, sources[i]]).sort((a, b) => a[0] - b[0]);
    for (const [, ds] of order) if (ds) await viewer.dataSources.add(ds);
  });
  const ready = Promise.all([refresh(), vectorsReady]);
  return { refresh, suspend, ready };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}
