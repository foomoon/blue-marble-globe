// Layers control: choose the base map (Blue Marble or Grey), switch terrain on and off (with
// exaggeration) and overlays (borders, states, each built Landsat region, with opacity). Works in production: built
// regions are listed in /tiles/landsat/index.json, which scripts/build_region.py writes.
import * as Cesium from "cesium";
import { heightSource, reliefProvider, terrainProvider } from "./terrain.js";
import "./layers.css";

const STORE = "layers";

// Base maps: exactly one is shown. The globe's base colour fills anywhere the tiles don't cover
// (Blue Marble's poles; all of Grey's water, since Grey's tiles are land only).
const BASES = [
  {
    name: "blue-marble",
    title: "Blue Marble",
    detail: "NASA · satellite imagery, 500 m",
    probe: "/tiles/blue-marble/0/0/0.jpg", // exists once built
    build: "npm run fetch:source && npm run build:tiles",
    baseColor: "#0b1a2e",
    atmosphere: true,
  },
  {
    name: "grey",
    relief: true, // flat colour shows no slopes: shade them when terrain is on
    title: "Grey",
    detail: "Natural Earth · land and lakes",
    url: "/tiles/grey/{z}/{x}/{y}.png",
    index: "/tiles/grey/tiles.json",
    probe: "/tiles/grey/tiles.json",
    build: "npm run build:grey",
    maximumLevel: 9,
    baseColor: "#3b3f45",
    atmosphere: false, // the blue atmosphere haze would tint the greys
  },
  // No imagery: a plain dark globe, so only the overlays show (lines use the white style)
  { name: "none", title: "None", detail: "plain globe, overlays only", baseColor: "#1c1f23", atmosphere: false, relief: true },
];

// Global terrain (scripts/build_terrain.py). Real relief is tiny at globe scale, so it's
// exaggerated by default; 1x is true scale.
const TERRAIN = {
  title: "Terrain",
  detail: "NOAA ETOPO 2022 · 450 m",
  url: "/tiles/terrain/{z}/{x}/{y}.webp",
  index: "/tiles/terrain/tiles.json",
  build: "npm run build:terrain",
  source: "NOAA ETOPO 2022",
  exaggeration: 2,
  credit: new Cesium.Credit(
    'Terrain: <a href="https://www.ncei.noaa.gov/products/etopo-global-relief-model" target="_blank" rel="noopener">NOAA NCEI, ETOPO 2022</a>',
    true,
  ),
};

// Line colours per base map: white reads on imagery (and the plain "None" globe), dark grey on
// light-grey land. Each line role shares one material, so switching base map only changes its
// colour value: Cesium updates that in place instead of rebuilding every line's geometry.
const LINE_COLOURS = {
  "blue-marble": {
    border: Cesium.Color.WHITE.withAlpha(0.75),
    state: Cesium.Color.WHITE.withAlpha(0.4),
    coast: Cesium.Color.fromCssColorString("#bfe3ff").withAlpha(0.7), // pale blue-white: reads on both land and sea
  },
  grey: {
    border: Cesium.Color.fromCssColorString("#6b7078"),
    state: Cesium.Color.fromCssColorString("#6b7078").withAlpha(0.5),
    coast: Cesium.Color.fromCssColorString("#8d939b"), // between the land and ocean greys
  },
};

// Vector layers shipped with the app (see scripts/fetch_vectors.py and provenance/vectors.json).
// Listed in this order; drawn bottom to top by `drawOrder`, so state lines sit under country borders.
const VECTORS = [
  {
    name: "country-borders",
    title: "Country borders",
    detail: "Natural Earth · 1:50m · dashed = disputed",
    url: "/vectors/country-borders.geojson",
    drawOrder: 2,
    style: (props) => (props.kind === "disputed" ? { width: 1.5, role: "disputed" } : { width: 1.25, role: "border" }),
  },
  {
    name: "us-states",
    title: "US states",
    detail: "Natural Earth · 1:50m",
    url: "/vectors/us-states.geojson",
    drawOrder: 1,
    style: () => ({ width: 1, role: "state" }),
  },
  {
    name: "coastlines",
    title: "Coastlines",
    detail: "Natural Earth · 1:50m",
    url: "/vectors/coastlines.geojson",
    drawOrder: 0,
    defaultOn: false, // both base maps already show the coast; this is for emphasis
    style: () => ({ width: 1, role: "coast" }),
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

/** A Web Mercator XYZ tile provider; `available` (a Set of "z/x/y") skips tiles that don't exist. */
function tileProvider({ available, ...options }) {
  const provider = new Cesium.UrlTemplateImageryProvider({ tilingScheme: new Cesium.WebMercatorTilingScheme(), ...options });
  provider.errorEvent.addEventListener((e) => (e.retry = false));
  if (available) {
    const request = provider.requestImage.bind(provider);
    provider.requestImage = (x, y, level, req) =>
      available.has(`${level}/${x}/${y}`) ? request(x, y, level, req) : Promise.resolve(EMPTY_TILE);
  }
  return provider;
}

/** The imagery provider for a built Landsat region. */
export function regionProvider(region, { url = region.url, available } = {}) {
  return tileProvider({
    url,
    available,
    rectangle: Cesium.Rectangle.fromDegrees(...region.bbox),
    minimumLevel: region.zoom[0],
    maximumLevel: region.zoom[1],
    credit: new Cesium.Credit(region.credit ?? "Landsat imagery courtesy of the U.S. Geological Survey", true),
  });
}

/**
 * The layer for a region, hidden when zoomed out past its minimum zoom (so "zoom 8–12" means
 * what it says). Past the maximum it stays, enlarged: that's still sharper than Blue Marble.
 * Cesium's globe tiles start at 2 across where Web Mercator starts at 1, so globe level L ≈ zoom L+1.
 */
export function regionLayer(region, opts) {
  return new Cesium.ImageryLayer(regionProvider(region, opts), { minimumTerrainLevel: Math.max(0, region.zoom[0] - 1) });
}

async function availability({ tiles_index }) {
  if (!tiles_index) return null; // older builds: request every tile in the bbox
  try {
    const res = await fetch(tiles_index);
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
  const baseLayers = new Map([["blue-marble", baseLayer]]); // name -> ImageryLayer, once loaded
  // One shared material per line role; restyling just changes their colours
  const palette = () => LINE_COLOURS[currentBaseLines()] ?? LINE_COLOURS["blue-marble"];
  const currentBaseLines = () => (LINE_COLOURS[currentBase] ? currentBase : "blue-marble");
  let materials = null;
  const materialFor = (role) => {
    if (!materials) {
      const c = palette();
      materials = {
        border: new Cesium.ColorMaterialProperty(c.border),
        disputed: new Cesium.PolylineDashMaterialProperty({ color: c.border, dashLength: 10 }),
        state: new Cesium.ColorMaterialProperty(c.state),
        coast: new Cesium.ColorMaterialProperty(c.coast),
      };
      materials.palette = currentBaseLines();
    }
    return materials[role];
  };
  const baseBuilt = new Map([["none", true]]); // name -> true / false (not built) / undefined (checking)
  let currentBase = prefs.base ?? "blue-marble";
  const atmosphereDefaults = {
    fadeIn: viewer.scene.globe.lightingFadeInDistance,
    fadeOut: viewer.scene.globe.lightingFadeOutDistance,
  };
  // Hidden until we know its tiles exist: on a fresh clone that avoids a burst of 404s
  baseLayer.show = false;

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

  // ---- base maps ----
  async function ensureBase(def) {
    if (baseBuilt.get(def.name) === false) return null;
    if (baseLayers.has(def.name)) return baseLayers.get(def.name);
    if (!def.url) return true; // "None": nothing to load
    const available = await availability({ tiles_index: def.index });
    if (!available) {
      baseBuilt.set(def.name, false);
      return null;
    }
    const layer = new Cesium.ImageryLayer(tileProvider({ url: def.url, available, maximumLevel: def.maximumLevel }));
    viewer.imageryLayers.add(layer, 1); // just above Blue Marble, under relief shading, regions and overlays
    baseLayers.set(def.name, layer);
    return layer;
  }

  async function setBase(name) {
    // Use the requested map if it's built, else the first built one; "none" always is
    let def = null;
    for (const candidate of [name, ...BASES.map((b) => b.name)]) {
      const d = BASES.find((b) => b.name === candidate);
      if (d && (await ensureBase(d))) {
        def = d;
        break;
      }
    }
    currentBase = def.name;
    for (const [n, layer] of baseLayers) layer.show = n === currentBase;
    viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString(def.baseColor);
    // Don't toggle showGroundAtmosphere: that recompiles the globe's shaders, and the vector lines
    // vanish for several seconds. The atmosphere is only drawn between two camera distances, so
    // push those out of reach instead; Blue Marble gets the defaults back.
    const globe = viewer.scene.globe;
    globe.lightingFadeInDistance = def.atmosphere ? atmosphereDefaults.fadeIn : Number.MAX_VALUE;
    globe.lightingFadeOutDistance = def.atmosphere ? atmosphereDefaults.fadeOut : Number.MAX_VALUE;
    restyleVectors();
    updateRelief();
    render();
    updateNotice();
  }

  // Find out which base maps are built (a cheap HEAD request each), without downloading tiles yet
  const basesChecked = Promise.all(
    BASES.filter((b) => b.probe).map(async (b) => {
      try {
        baseBuilt.set(b.name, (await fetch(b.probe, { method: "HEAD" })).ok);
      } catch {
        baseBuilt.set(b.name, false);
      }
    }),
  ).then(() => setBase(currentBase));

  // First-run notice: shown when no base map with tiles has been built yet
  const notice = el("div", "first-run");
  notice.hidden = true;
  notice.setAttribute("role", "status");
  notice.innerHTML = `<span>No base map built yet. The globe shows overlays only.</span>
    <button class="first-run-how">How to build it</button><button class="first-run-close" aria-label="Dismiss">×</button>`;
  document.body.append(notice);
  let noticeDismissed = false;
  notice.querySelector(".first-run-how").addEventListener("click", () =>
    document.dispatchEvent(new CustomEvent("guide:open", { detail: { tab: "tiles" } })),
  );
  notice.querySelector(".first-run-close").addEventListener("click", () => {
    noticeDismissed = true;
    updateNotice();
  });
  function updateNotice() {
    const anyBuilt = BASES.some((b) => b.probe && baseBuilt.get(b.name));
    notice.hidden = noticeDismissed || anyBuilt;
  }

  // ---- terrain ----
  let terrainBuilt; // true / false (not built) / undefined (checking)
  let terrain = null; // the provider, once loaded
  let heights = null; // its height source
  let relief = null; // relief shading layer (Grey and None), made on first use
  const flat = new Cesium.EllipsoidTerrainProvider();
  const exaggeration = () => prefs.terrain?.exaggeration ?? TERRAIN.exaggeration;

  async function setTerrain() {
    const on = terrainBuilt && isOn("terrain");
    if (on && !terrain) {
      try {
        const res = await fetch(TERRAIN.index);
        const { zoom, tiles } = await res.json();
        const available = new Set();
        for (const [z, xs] of Object.entries(tiles)) for (const [x, ys] of Object.entries(xs)) for (const y of ys) available.add(`${z}/${x}/${y}`);
        heights = heightSource({ url: TERRAIN.url, available, maxzoom: zoom[1] });
        terrain = terrainProvider(heights, { credit: TERRAIN.credit });
      } catch (err) {
        console.warn("Couldn't load the terrain index:", err);
        terrainBuilt = false;
        render();
        return;
      }
    }
    const want = on ? terrain : flat;
    if (viewer.terrainProvider !== want) viewer.terrainProvider = want;
    viewer.scene.verticalExaggeration = on ? exaggeration() : 1;
    updateRelief();
    document.dispatchEvent(new Event("terrain:changed")); // the readout shows the terrain under the cursor
  }

  function updateRelief() {
    const show = !!terrain && terrainBuilt && isOn("terrain") && !!BASES.find((b) => b.name === currentBase)?.relief;
    if (show && !relief) {
      relief = new Cesium.ImageryLayer(reliefProvider(heights));
      // Just above the base maps, under every region
      const above = Math.max(...[...baseLayers.values()].map((l) => viewer.imageryLayers.indexOf(l)));
      viewer.imageryLayers.add(relief, above + 1);
    }
    if (relief) relief.show = show;
  }

  const terrainChecked = fetch(TERRAIN.index, { method: "HEAD" })
    .then((r) => r.ok, () => false)
    .then((ok) => {
      terrainBuilt = ok;
      render();
      return setTerrain();
    });

  /**
   * The terrain under a point, for the readout: its source, its height (true metres, not
   * exaggerated) and how much detail it has there. Null when terrain is off.
   */
  async function terrainAt(lon, lat) {
    if (!(terrain && terrainBuilt && isOn("terrain"))) return null;
    const z = heights.maxzoom, size = 256 * 2 ** z;
    const r = Cesium.Math.toRadians(Math.max(-85.0511, Math.min(85.0511, lat)));
    const px = ((lon + 180) / 360) * size, py = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * size;
    const [h] = await heights.sample(z, [px, py], new Float32Array(1));
    // Detail: the coarser of the source grid (15", ~463 m north-south) and the tile grid at this latitude
    const detail = Math.max(463, (2 * Math.PI * 6378137 * Math.cos(r)) / size);
    return { source: TERRAIN.source, height: h, detail, sea: h < 0.5 };
  }

  function terrainRow() {
    const li = el("li", "layers-row");
    li.innerHTML = `<input type="checkbox" id="layer-terrain"><label for="layer-terrain"><strong></strong><span></span></label>`;
    li.querySelector("strong").textContent = TERRAIN.title;
    li.querySelector("span").textContent = terrainBuilt === false ? `not built yet: ${TERRAIN.build}` : TERRAIN.detail;
    const box = li.querySelector("input");
    box.setAttribute("aria-label", TERRAIN.title);
    box.checked = !!terrainBuilt && isOn("terrain");
    box.disabled = terrainBuilt === false;
    const value = el("span", "layers-value", `${exaggeration()}×`);
    value.title = "Vertical exaggeration";
    const slider = Object.assign(document.createElement("input"), { type: "range", min: 1, max: 5, step: 0.5, value: exaggeration() });
    slider.className = "layers-opacity";
    slider.setAttribute("aria-label", "Terrain exaggeration");
    slider.disabled = !box.checked;
    box.addEventListener("change", () => {
      set("terrain", { on: box.checked });
      slider.disabled = !box.checked;
      setTerrain();
    });
    slider.addEventListener("input", () => {
      set("terrain", { exaggeration: Number(slider.value) });
      value.textContent = `${slider.value}×`;
      viewer.scene.verticalExaggeration = Number(slider.value);
    });
    li.append(value, slider);
    return li;
  }

  function apply(name) {
    const entry = regions.get(name);
    if (!entry?.layer) return;
    entry.layer.show = isOn(name) && !suspended.has(name);
    entry.layer.alpha = opacity(name);
  }

  function render() {
    pop.innerHTML = `<div class="layers-head">Layers</div><div class="layers-section">Base map</div>`;
    const bases = el("ul", "layers-list");
    for (const b of BASES) bases.append(baseRow(b));
    pop.append(bases);
    const section = (title) => Object.assign(el("div", "layers-section"), { textContent: title });

    const terrainList = el("ul", "layers-list");
    terrainList.append(terrainRow());
    pop.append(section("Terrain"), terrainList);

    const overlays = el("ul", "layers-list");
    for (const v of VECTORS) overlays.append(row(v, false));
    pop.append(section("Overlays"), overlays);

    const regionList = el("ul", "layers-list");
    const sorted = [...regions.values()].map((e) => e.region).sort((a, b) => a.title.localeCompare(b.title));
    for (const r of sorted) {
      regionList.append(row({ name: r.name, title: r.title, detail: `Landsat · 30 m · shown from zoom ${r.zoom[0]}`, region: r }, true));
    }
    if (!sorted.length) {
      regionList.append(Object.assign(el("li", "layers-empty"), { textContent: "No regions built yet" }));
    }
    pop.append(section("Regions"), regionList);
  }

  function baseRow(b) {
    const li = el("li", "layers-row");
    const id = `base-${b.name}`;
    li.innerHTML = `<input type="radio" name="basemap" id="${id}"><label for="${id}"><strong></strong><span></span></label>`;
    li.querySelector("strong").textContent = b.title;
    const built = baseBuilt.get(b.name);
    li.querySelector("span").textContent = built === false ? `not built yet: ${b.build}` : b.detail;
    const radio = li.querySelector("input");
    radio.setAttribute("aria-label", b.title);
    radio.checked = b.name === currentBase;
    radio.disabled = built === false;
    radio.addEventListener("change", () => {
      prefs.base = b.name;
      store(prefs);
      setBase(b.name);
    });
    return li;
  }

  function row({ name, title, detail, region, defaultOn = true }, hasOpacity) {
    const li = el("li", "layers-row");
    const id = `layer-${name}`;
    li.innerHTML = `<input type="checkbox" id="${id}"><label for="${id}"><strong></strong><span></span></label>`;
    li.querySelector("strong").textContent = title;
    li.querySelector("span").textContent = suspended.has(name) ? "rebuilding…" : detail;
    const box = li.querySelector("input");
    box.setAttribute("aria-label", title); // the detail line stays visible but isn't part of the name
    box.checked = isOn(name, defaultOn);
    box.addEventListener("change", () => {
      set(name, { on: box.checked });
      const vector = VECTORS.find((v) => v.name === name);
      if (vector) {
        if (vectorSources.has(name)) vectorSources.get(name).show = box.checked;
        else if (box.checked) addVectorLate(vector); // off by default: load on first use
      }
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
      // (ImageryLayerCollection.add returns nothing, so keep our own reference to the layer)
      entry.layer = regionLayer(r, { url: `${r.url}?b=${encodeURIComponent(r.built_utc)}`, available });
      viewer.imageryLayers.add(entry.layer);
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

  function styleVector(v, ds) {
    for (const e of ds.entities.values) {
      if (!e.polyline) continue;
      const { width, role } = v.style({ kind: e.properties?.kind?.getValue() });
      e.polyline.width = width;
      e.polyline.material = materialFor(role);
      e.polyline.arcType = Cesium.ArcType.GEODESIC;
      // Draped on the ground, so with terrain on a border follows the ridge it runs along
      // instead of being drawn at sea level (and seen through the mountains)
      e.polyline.clampToGround = true;
    }
  }
  function restyleVectors() {
    if (!materials || materials.palette === currentBaseLines()) return; // same colours: nothing to do
    const c = palette();
    materials.border.color = c.border;
    materials.disputed.color = c.border;
    materials.state.color = c.state;
    materials.coast.color = c.coast;
    materials.palette = currentBaseLines();
  }

  async function loadVector(v) {
    try {
      const ds = await Cesium.GeoJsonDataSource.load(v.url);
      styleVector(v, ds);
      ds.show = isOn(v.name, v.defaultOn ?? true);
      vectorSources.set(v.name, ds);
      return ds;
    } catch (err) {
      console.warn(`Couldn't load ${v.title}:`, err);
    }
  }

  // A layer switched on later slots into its place in the draw order
  async function addVectorLate(v) {
    const ds = await loadVector(v);
    if (!ds) return;
    await viewer.dataSources.add(ds);
    for (const other of [...VECTORS].sort((a, b) => b.drawOrder - a.drawOrder)) {
      if (other.drawOrder > v.drawOrder && vectorSources.has(other.name)) viewer.dataSources.raiseToTop(vectorSources.get(other.name));
    }
  }

  render();
  // Load the layers that are on, in parallel, then add bottom-to-top so the draw order is fixed
  // whatever finishes first. Layers that are off load when first switched on.
  const startOn = VECTORS.filter((v) => isOn(v.name, v.defaultOn ?? true));
  const vectorsReady = Promise.all(startOn.map(loadVector)).then(async (sources) => {
    const order = startOn.map((v, i) => [v.drawOrder, sources[i]]).sort((a, b) => a[0] - b[0]);
    for (const [, ds] of order) if (ds) await viewer.dataSources.add(ds);
  });
  const ready = Promise.all([refresh(), vectorsReady, basesChecked, terrainChecked]);
  return { refresh, suspend, ready, terrainAt };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}
