// Dev-only Regions panel: draw a rectangle on the globe, see what it would cost,
// save it as regions/<name>.json, and build its Landsat layer with live progress.
// Talks to the dev server's studio API (server/studio.js).
import * as Cesium from "cesium";
import { regionLayer } from "../layers.js";
import { areaKm2, bboxOf, estimate, fmtBytes, fmtInt, polygonAreaKm2 } from "./tiles.js";
import "./studio.css";

const ACCENT = Cesium.Color.fromCssColorString("#7cb7ff");
const SAVED = Cesium.Color.fromCssColorString("#ffd27c");
const DONE = Cesium.Color.fromCssColorString("#7cffb2");
const FAILED = Cesium.Color.fromCssColorString("#ff8a7c");
const MONTHS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
const DEFAULTS = { dates: ["2023-06-01", "2024-09-30"], months: [6, 7, 8, 9], max_cloud_percent: 20, scenes_per_location: 4, zoom: [8, 12] };
const STAGES = [
  { id: "search", label: "Search", weight: 0.03 },
  { id: "download", label: "Download", weight: 0.5 },
  { id: "composite", label: "Composite", weight: 0.27 },
  { id: "tile", label: "Tile", weight: 0.2 },
];
// USGS asks for this credit; `true` shows it on screen next to NASA's, not only under "Data attribution"
const LANDSAT_CREDIT = new Cesium.Credit("Landsat imagery courtesy of the U.S. Geological Survey", true);

export function mountStudio(viewer, layers) {
  const { scene } = viewer;
  let draft = null;
  let saved = [];
  let drawing = false;
  let dragStart = null;
  let editing = null; // name of the saved region loaded into the form, or null for a new one
  let shape = "rect"; // what "New region" / "Redraw area" draws: "rect" or "poly"
  let polyPts = []; // corners placed so far while drawing a polygon
  let hoverPt = null; // where the next corner would go (follows the cursor)
  let lastClick = null; // screen position of the last placed corner
  let job = null; // the build being watched

  // ---- Globe: draft shape, saved outlines, build visuals ----
  const drawingPoly = () => drawing && shape === "poly";
  const polyPoints = () => (drawingPoly() ? (hoverPt ? [...polyPts, hoverPt] : polyPts) : draft?.boundary ?? []);
  let lastHierarchy = new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray([0, 0, 0.001, 0, 0, 0.001]));
  const draftEntity = viewer.entities.add({
    show: false,
    rectangle: {
      show: new Cesium.CallbackProperty(() => !!draft && !draft.boundary && !drawingPoly(), false),
      coordinates: new Cesium.CallbackProperty(() => (draft ? Cesium.Rectangle.fromDegrees(...draft.bbox) : undefined), false),
      material: ACCENT.withAlpha(0.18),
      height: 0,
      outline: true,
      outlineColor: ACCENT,
    },
  });
  viewer.entities.add({
    parent: draftEntity, // shown and hidden along with the draft rectangle
    polygon: {
      show: new Cesium.CallbackProperty(() => polyPoints().length >= 3, false),
      hierarchy: new Cesium.CallbackProperty(() => {
        const pts = polyPoints();
        if (pts.length >= 3) lastHierarchy = new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(pts.flat()));
        return lastHierarchy;
      }, false),
      material: ACCENT.withAlpha(0.18),
      height: 0,
    },
    polyline: {
      show: new Cesium.CallbackProperty(() => polyPoints().length >= 2, false),
      positions: new Cesium.CallbackProperty(() => {
        const pts = polyPoints();
        if (pts.length < 2) return [];
        return Cesium.Cartesian3.fromDegreesArray((drawingPoly() ? pts : [...pts, pts[0]]).flat());
      }, false),
      width: 2,
      material: ACCENT,
    },
  });
  // Cesium's default double-click flies to the entity under the cursor; double-click finishes a polygon here
  viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
  const savedSource = new Cesium.CustomDataSource("saved-regions");
  const buildSource = new Cesium.CustomDataSource("build-progress");
  viewer.dataSources.add(savedSource);
  viewer.dataSources.add(buildSource);

  // The live layer shown while a build writes tiles (cache-busted so new tiles appear)
  function liveLayer(r, url, cacheBust) {
    const layer = regionLayer(r, { url: `${url}?v=${cacheBust}` });
    viewer.imageryLayers.add(layer);
    return layer;
  }

  // ---- Panel ----
  const toggle = el("button", "studio-toggle", "Regions");
  const panel = el("aside", "studio-panel");
  panel.hidden = true;
  panel.innerHTML = `
    <header class="studio-header"><strong>Regions</strong><span class="studio-badge">dev only</span>
      <button class="studio-close" aria-label="Close regions">×</button></header>
    <div class="studio-body">
      <section class="studio-job" hidden>
        <div class="job-head"><strong class="job-title"></strong><span class="job-state"></span></div>
        <ol class="job-stages"></ol>
        <div class="job-time"></div>
        <div class="job-message" role="status"></div>
        <div class="job-actions">
          <button class="job-cancel">Cancel</button>
          <button class="job-logtoggle" aria-expanded="false">Log</button>
          <button class="job-dismiss" hidden>Dismiss</button>
        </div>
        <pre class="job-log" hidden></pre>
      </section>
      <div class="studio-newrow">
        <button class="studio-draw">New region</button>
        <div class="studio-shape" role="group" aria-label="Shape">
          <button type="button" data-shape="rect" aria-pressed="true">Rectangle</button>
          <button type="button" data-shape="poly" aria-pressed="false">Polygon</button>
        </div>
      </div>
      <p class="studio-hint"></p>
      <form class="studio-form" hidden>
        <div class="studio-formhead"><strong class="studio-mode"></strong>
          <button type="button" class="studio-redraw">Redraw area</button>
          <button type="button" class="studio-closeform" aria-label="Close the form without saving">Close</button></div>
        <label>Name <input name="name" required pattern="[a-z0-9][a-z0-9\\-]{0,39}" placeholder="colorado"></label>
        <label>Title <input name="title" placeholder="Colorado"></label>
        <div class="studio-bbox"></div>
        <div class="studio-row">
          <label>From <input type="date" name="from"></label>
          <label>To <input type="date" name="to"></label>
        </div>
        <fieldset class="studio-months"><legend>Months</legend></fieldset>
        <div class="studio-row">
          <label>Max cloud % <input type="number" name="cloud" min="0" max="100" step="5"></label>
          <label title="How many of the clearest scenes to combine per Landsat path/row">Scenes/spot <input type="number" name="per" min="1" max="10"></label>
        </div>
        <div class="studio-row">
          <label>Zoom <select name="z0"></select></label>
          <label>to <select name="z1"></select></label>
        </div>
        <table class="studio-estimate"></table>
        <div class="studio-actions">
          <button type="submit" class="studio-save">Save</button>
          <button type="button" class="studio-build">Save &amp; build</button>
          <span class="studio-status" role="status"></span>
        </div>
      </form>
      <h3>Saved</h3>
      <ul class="studio-list"></ul>
    </div>`;
  document.body.append(toggle, panel);

  const $ = (sel) => panel.querySelector(sel);
  const form = $(".studio-form");
  const drawBtn = $(".studio-draw");
  const months = $(".studio-months");
  MONTHS.forEach((m, i) => {
    const b = el("button", "studio-month", m);
    b.type = "button";
    b.title = new Date(2000, i).toLocaleString("en", { month: "long" });
    b.addEventListener("click", () => {
      const set = new Set(draft.months);
      set.has(i + 1) ? set.delete(i + 1) : set.add(i + 1);
      draft.months = [...set].sort((a, b) => a - b);
      render();
    });
    months.append(b);
  });
  for (let z = 0; z <= 13; z++) {
    form.z0.append(new Option(String(z), z));
    form.z1.append(new Option(z === 12 ? "12 (30 m)" : z === 13 ? "13 (15 m)" : String(z), z));
  }

  toggle.addEventListener("click", () => setOpen(panel.hidden));
  $(".studio-close").addEventListener("click", () => setOpen(false));
  drawBtn.addEventListener("click", () => {
    if (drawing) return setDrawing(false);
    // A new region always starts from a blank form, never from the one being edited
    draft = null;
    editing = null;
    draftEntity.show = false;
    status("");
    render();
    setDrawing(true);
  });
  $(".studio-redraw").addEventListener("click", () => setDrawing(true));
  $(".studio-closeform").addEventListener("click", closeForm);
  function closeForm() {
    setDrawing(false);
    draft = null;
    editing = null;
    draftEntity.show = false;
    status("");
    render();
  }
  panel.querySelectorAll(".studio-shape button").forEach((b) =>
    b.addEventListener("click", () => {
      setShape(b.dataset.shape);
      if (drawing) setDrawing(true); // restart the drawing in the new shape
    }),
  );
  function setShape(next) {
    shape = next;
    panel.querySelectorAll(".studio-shape button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.shape === shape)));
    updateHint();
  }
  function updateHint() {
    $(".studio-hint").textContent = shape === "rect"
      ? "Drag a rectangle on the globe. The camera is locked while you draw."
      : "Click to place corners; you can still move the globe between clicks. Double-click, Enter, or click the first corner to finish. Backspace removes the last corner, Esc cancels.";
  }

  form.addEventListener("input", () => {
    if (!draft) return;
    draft.name = form.name.value.trim();
    draft.title = form.title.value;
    draft.dates = [form.from.value, form.to.value];
    draft.max_cloud_percent = Number(form.cloud.value);
    draft.scenes_per_location = Number(form.per.value);
    draft.zoom = [Number(form.z0.value), Number(form.z1.value)];
    if (draft.zoom[0] > draft.zoom[1]) draft.zoom[1] = draft.zoom[0];
    render(false);
  });

  async function save() {
    if (saved.some((r) => r.name === draft.name) && draft.name !== editing) {
      status(`"${draft.name}" is already a saved region. Choose another name, or open it from the list to edit it.`, true);
      return null;
    }
    status("Saving…");
    const res = await fetch(`/api/regions/${encodeURIComponent(draft.name)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    });
    const body = await res.json();
    if (!res.ok) {
      status(body.errors ? body.errors.join("; ") : body.error, true);
      return null;
    }
    editing = body.region.name;
    status(`Saved regions/${body.region.name}.json`);
    await loadSaved();
    render(false); // the form now edits the saved region
    return body.region;
  }
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    save();
  });
  $(".studio-build").addEventListener("click", async () => {
    if (!form.reportValidity()) return;
    const region = await save();
    if (region) startBuild(region.name);
  });

  // ---- Drawing ----
  const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
  const pick = (pos) => {
    const c = viewer.camera.pickEllipsoid(pos, scene.globe.ellipsoid);
    if (!c) return null;
    const g = Cesium.Cartographic.fromCartesian(c);
    return [Cesium.Math.toDegrees(g.longitude), Cesium.Math.toDegrees(g.latitude)];
  };
  const clampLat = (v) => Math.max(-85.05, Math.min(85.05, v));
  handler.setInputAction((e) => {
    if (drawing && shape === "rect") dragStart = pick(e.position);
  }, Cesium.ScreenSpaceEventType.LEFT_DOWN);
  handler.setInputAction((e) => {
    if (drawingPoly()) {
      hoverPt = pick(e.endPosition);
      return;
    }
    if (!drawing || !dragStart) return;
    const p = pick(e.endPosition);
    if (!p) return;
    const [w, e2] = [Math.min(dragStart[0], p[0]), Math.max(dragStart[0], p[0])];
    const [s, n] = [clampLat(Math.min(dragStart[1], p[1])), clampLat(Math.max(dragStart[1], p[1]))];
    draft = { ...DEFAULTS, ...(draft ?? {}), bbox: [w, s, e2, n] };
    delete draft.boundary;
    draftEntity.show = true;
    render();
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
  handler.setInputAction(() => {
    if (!drawing || shape !== "rect") return;
    dragStart = null;
    if (draft) setDrawing(false);
  }, Cesium.ScreenSpaceEventType.LEFT_UP);

  // Polygon: click to add corners, finish on double-click / Enter / clicking the first corner
  const near = (a, b, px) => a && b && Cesium.Cartesian2.distance(a, b) < px;
  handler.setInputAction((e) => {
    if (!drawingPoly()) return;
    const first = polyPts.length && scene.cartesianToCanvasCoordinates(Cesium.Cartesian3.fromDegrees(...polyPts[0]));
    if (polyPts.length >= 3 && near(first, e.position, 12)) return finishPolygon();
    if (near(lastClick, e.position, 4)) return; // second click of a double-click
    const p = pick(e.position);
    if (!p) return;
    polyPts.push([p[0], Math.max(-85.05, Math.min(85.05, p[1]))]);
    lastClick = Cesium.Cartesian2.clone(e.position);
    draftEntity.show = true;
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  handler.setInputAction(() => {
    if (drawingPoly()) finishPolygon();
  }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
  document.addEventListener("keydown", (e) => {
    if (!drawingPoly() || e.target.closest?.("input, select, textarea")) return;
    if (e.key === "Backspace") {
      polyPts.pop();
      lastClick = null;
      e.preventDefault();
    } else if (e.key === "Enter") finishPolygon();
    else if (e.key === "Escape") setDrawing(false);
  });

  function finishPolygon() {
    if (polyPts.length < 3) return;
    const boundary = polyPts.map(([lon, lat]) => [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5]);
    draft = { ...DEFAULTS, ...(draft ?? {}), boundary, bbox: bboxOf(boundary) };
    draftEntity.show = true;
    setDrawing(false);
    render();
  }

  function setDrawing(on) {
    drawing = on;
    polyPts = [];
    hoverPt = null;
    lastClick = null;
    // Rectangles are dragged, so the camera must hold still; polygons are clicked, so it can move
    scene.screenSpaceCameraController.enableInputs = !(on && shape === "rect");
    drawBtn.classList.toggle("active", on);
    drawBtn.textContent = on ? "Cancel drawing" : "New region";
    $(".studio-hint").hidden = !on && !!draft;
    viewer.container.style.cursor = on ? "crosshair" : "";
  }

  function setOpen(open) {
    panel.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    draftEntity.show = open && !!draft;
    savedSource.show = open;
    if (!open) setDrawing(false);
  }

  // ---- Form rendering ----
  function render(syncInputs = true) {
    form.hidden = !draft;
    if (!draft) return;
    const current = saved.find((r) => r.name === editing);
    $(".studio-mode").textContent = current ? `Editing ${current.title}` : "New region";
    $(".studio-redraw").hidden = !current;
    if (syncInputs) {
      form.name.value = draft.name ?? "";
      form.title.value = draft.title ?? "";
      form.from.value = draft.dates[0];
      form.to.value = draft.dates[1];
      form.cloud.value = draft.max_cloud_percent;
      form.per.value = draft.scenes_per_location ?? 4;
      form.z0.value = draft.zoom[0];
    }
    form.z1.value = draft.zoom[1];
    months.querySelectorAll(".studio-month").forEach((b, i) => b.classList.toggle("on", draft.months.includes(i + 1)));

    const [w, s, e, n] = draft.bbox;
    $(".studio-bbox").textContent = draft.boundary
      ? `Polygon · ${draft.boundary.length} corners  ·  ${fmtInt(polygonAreaKm2(draft.boundary))} km²`
      : `${w.toFixed(3)}, ${s.toFixed(3)} → ${e.toFixed(3)}, ${n.toFixed(3)}  ·  ${fmtInt(areaKm2(draft.bbox))} km²`;
    const est = estimate(draft.bbox, draft.zoom, draft.boundary);
    $(".studio-estimate").innerHTML =
      `<tr><th>Zoom</th><th>Tiles</th></tr>` +
      est.levels.map((l) => `<tr><td>${l.z}</td><td>${fmtInt(l.tiles)}</td></tr>`).join("") +
      `<tr class="total"><td>Total</td><td>${est.exact ? "" : "~"}${fmtInt(est.tiles)} tiles ≈ ${fmtBytes(est.bytes)}</td></tr>`;
  }

  function status(text, isError = false) {
    const s = $(".studio-status");
    s.textContent = text;
    s.classList.toggle("error", isError);
  }

  // ---- Saved regions + their built layers ----
  async function loadSaved() {
    const res = await fetch("/api/regions");
    saved = (await res.json()).regions;
    savedSource.entities.removeAll();

    const building = job?.state === "running" ? job.region : null;

    const list = $(".studio-list");
    list.innerHTML = saved.length ? "" : `<li class="studio-empty">None yet</li>`;
    for (const r of saved) {
      const color = r.build ? DONE : SAVED;
      savedSource.entities.add(
        r.boundary
          ? {
              polygon: { hierarchy: Cesium.Cartesian3.fromDegreesArray(r.boundary.flat()), material: SAVED.withAlpha(r.build ? 0 : 0.06), height: 0 },
              polyline: { positions: Cesium.Cartesian3.fromDegreesArray([...r.boundary, r.boundary[0]].flat()), width: 1.5, material: color },
            }
          : {
              rectangle: {
                coordinates: Cesium.Rectangle.fromDegrees(...r.bbox),
                material: SAVED.withAlpha(r.build ? 0 : 0.06),
                height: 0,
                outline: true,
                outlineColor: color,
              },
            },
      );
      const est = estimate(r.bbox, r.zoom, r.boundary);
      const li = el("li", "studio-item");
      li.innerHTML = `<button class="studio-open" title="Fly to this region"><strong></strong><span></span></button>
        <button class="studio-edit">Edit</button><button class="studio-itembuild"></button><button class="studio-del">Delete</button>`;
      li.querySelector("strong").textContent = r.title;
      li.querySelector("span").textContent = r.build
        ? `built · ${fmtInt(r.build.tiles)} tiles · ${fmtBytes(r.build.bytes)} · ${Math.round(r.build.seconds)} s`
        : `${r.name} · z${r.zoom[0]}–${r.zoom[1]} · ≈ ${fmtBytes(est.bytes)}`;
      const buildBtn = li.querySelector(".studio-itembuild");
      buildBtn.textContent = r.build ? "Rebuild" : "Build";
      buildBtn.disabled = !!building;
      buildBtn.addEventListener("click", () => startBuild(r.name));
      const flyTo = () => viewer.camera.flyTo({ destination: Cesium.Rectangle.fromDegrees(...r.bbox), duration: 1.2 });
      // Clicking a region only flies there; changing it is an explicit step (Edit)
      li.querySelector(".studio-open").addEventListener("click", flyTo);
      li.querySelector(".studio-edit").addEventListener("click", () => {
        draft = structuredClone(r);
        delete draft.build;
        editing = r.name;
        setShape(r.boundary ? "poly" : "rect");
        draftEntity.show = true;
        status("");
        render();
        $(".studio-form").scrollIntoView({ block: "nearest" });
        flyTo();
      });
      const del = li.querySelector(".studio-del");
      del.addEventListener("click", async () => {
        if (del.dataset.armed !== "1") {
          del.dataset.armed = "1";
          del.textContent = "Confirm";
          setTimeout(() => ((del.dataset.armed = ""), (del.textContent = "Delete")), 3000);
          return;
        }
        await fetch(`/api/regions/${encodeURIComponent(r.name)}`, { method: "DELETE" });
        await loadSaved();
      });
      list.append(li);
    }
  }

  // ---- Builds: progress card + globe visuals ----
  const card = $(".studio-job");
  const stageList = $(".job-stages");
  const logBox = $(".job-log");

  $(".job-cancel").addEventListener("click", async () => {
    if (!job) return;
    $(".job-cancel").disabled = true;
    $(".job-message").textContent = "Cancelling…";
    await fetch(`/api/jobs/${job.id}/cancel`, { method: "POST" });
  });
  $(".job-logtoggle").addEventListener("click", (e) => {
    logBox.hidden = !logBox.hidden;
    e.currentTarget.setAttribute("aria-expanded", String(!logBox.hidden));
    logBox.scrollTop = logBox.scrollHeight;
  });
  $(".job-dismiss").addEventListener("click", () => {
    card.hidden = true;
    buildSource.entities.removeAll();
  });

  async function startBuild(name) {
    const res = await fetch(`/api/regions/${encodeURIComponent(name)}/build`, { method: "POST" });
    const body = await res.json();
    if (!res.ok && !body.job) return status(body.error, true);
    watch(body.job); // on 409 this attaches to the build already running
  }

  function watch(summary) {
    job?.source?.close();
    clearInterval(job?.timer);
    clearInterval(job?.refresh);
    if (job?.layer) viewer.imageryLayers.remove(job.layer);
    job = {
      ...summary,
      stages: Object.fromEntries(STAGES.map((s) => [s.id, { status: "pending", frac: 0, detail: "" }])),
      lastSeq: -1,
      scenes: new Map(),
      log: [],
    };
    layers.suspend(summary.region, true); // the live layer replaces it until the build ends
    buildSource.entities.removeAll();
    logBox.textContent = "";
    card.hidden = false;
    card.dataset.state = "running";
    $(".job-cancel").disabled = false;
    $(".job-cancel").hidden = false;
    $(".job-dismiss").hidden = true;
    $(".job-message").textContent = "";
    $(".job-title").textContent = saved.find((r) => r.name === summary.region)?.title ?? summary.region;
    setOpen(true);
    $(".studio-body").scrollTop = 0;
    renderJob();
    job.timer = setInterval(renderTime, 1000);
    loadSaved();

    const watched = job;
    const source = new EventSource(`/api/jobs/${summary.id}/events`);
    watched.source = source;
    source.onmessage = (m) => {
      if (job !== watched) return source.close();
      const ev = JSON.parse(m.data);
      if (ev.seq <= watched.lastSeq) return; // replayed after a reconnect
      watched.lastSeq = ev.seq;
      onEvent(ev);
    };
  }

  const regionOf = () => saved.find((r) => r.name === job.region);

  function onEvent(ev) {
    const st = ev.stage && job.stages[ev.stage];
    switch (ev.type) {
      case "stage":
        st.status = ev.status;
        if (ev.detail) st.detail = ev.detail;
        if (ev.status === "done") st.frac = 1;
        if (ev.stage === "tile" && ev.status === "running") {
          fadeBuildVisuals();
          startLiveLayer(ev.url);
        }
        break;
      case "progress":
        st.frac = ev.total ? Math.min(1, ev.done / ev.total) : 0;
        st.detail =
          ev.stage === "search" ? `${fmtInt(ev.done)} found`
          : ev.stage === "download" ? `${ev.done.toFixed(1)} / ${ev.total} scenes`
          : ev.stage === "composite" ? `block ${fmtInt(ev.done)} / ${fmtInt(ev.total)}`
          : `${fmtInt(ev.done)} / ~${fmtInt(ev.total)} tiles`;
        break;
      case "scene":
        sceneVisual(ev);
        break;
      case "block":
        buildSource.entities.add({
          rectangle: {
            coordinates: Cesium.Rectangle.fromDegrees(...ev.bounds),
            material: (ev.scenes ? DONE : FAILED).withAlpha(0.22),
            height: 0,
          },
        });
        break;
      case "log":
        job.log.push(ev.message);
        if (job.log.length > 400) job.log.shift();
        logBox.textContent = job.log.join("\n");
        if (!logBox.hidden) logBox.scrollTop = logBox.scrollHeight;
        break;
      case "done":
        $(".job-message").textContent = `Done: ${fmtInt(ev.tiles)} tiles, ${fmtBytes(ev.bytes)}. Record: ${ev.provenance}`;
        break;
      case "error":
        $(".job-message").textContent = ev.message;
        break;
      case "cancelled":
        $(".job-message").textContent = "Cancelled. Partial output removed.";
        break;
      case "end":
        finish(ev.state);
        break;
    }
    renderJob();
  }

  function sceneVisual(ev) {
    if (ev.state === "found") {
      job.scenes.set(
        ev.id,
        buildSource.entities.add({
          polygon: {
            hierarchy: Cesium.Cartesian3.fromDegreesArray(ev.footprint.flat()),
            material: ACCENT.withAlpha(0),
            height: 0,
            outline: true,
            outlineColor: Cesium.Color.WHITE.withAlpha(0.35),
          },
        }),
      );
      return;
    }
    const ent = job.scenes.get(ev.id);
    if (!ent) return;
    if (ev.state === "skipped") return buildSource.entities.remove(ent);
    const style = {
      downloading: [ACCENT.withAlpha(0.08), ACCENT],
      loaded: [ACCENT.withAlpha(0.16), ACCENT.withAlpha(0.6)],
      failed: [FAILED.withAlpha(0.2), FAILED],
    }[ev.state];
    if (style) {
      ent.polygon.material = style[0];
      ent.polygon.outlineColor = style[1];
    }
  }

  function fadeBuildVisuals() {
    // Imagery is about to appear: drop the scene footprints, soften the block grid
    for (const ent of job.scenes.values()) buildSource.entities.remove(ent);
    for (const ent of buildSource.entities.values) if (ent.rectangle) ent.rectangle.material = DONE.withAlpha(0.06);
  }

  function startLiveLayer(url) {
    const r = regionOf();
    if (!r) return;
    let n = 1;
    job.layer = liveLayer(r, url, n);
    job.refresh = setInterval(() => {
      // Request again so tiles written since the last pass show up
      const old = job.layer;
      job.layer = liveLayer(r, url, ++n);
      setTimeout(() => viewer.imageryLayers.remove(old), 1500);
    }, 3000);
  }

  function finish(state) {
    job.state = state;
    job.ended = Date.now();
    clearInterval(job.refresh);
    clearInterval(job.timer);
    job.source?.close();
    card.dataset.state = state;
    $(".job-cancel").hidden = true;
    $(".job-dismiss").hidden = false;
    if (job.layer) viewer.imageryLayers.remove(job.layer);
    job.layer = null;
    if (state === "done") buildSource.entities.removeAll();
    renderJob();
    layers.suspend(job.region, false);
    layers.refresh(); // picks up the new build (or keeps the previous one if it was cancelled)
    loadSaved(); // build info in the list
  }

  const overall = () => STAGES.reduce((a, s) => a + s.weight * job.stages[s.id].frac, 0);

  function renderJob() {
    if (!job) return;
    $(".job-state").textContent = { running: "● building", done: "✓ done", failed: "✕ failed", cancelled: "cancelled" }[job.state];
    stageList.innerHTML = STAGES.map((s, i) => {
      const st = job.stages[s.id];
      const icon = st.status === "done" ? "✓" : st.status === "running" ? "●" : String(i + 1);
      return `<li data-status="${st.status}"><span class="ico">${icon}</span><span class="name">${s.label}</span>` +
        `<span class="bar"><i style="width:${(st.frac * 100).toFixed(1)}%"></i></span><span class="detail"></span></li>`;
    }).join("");
    STAGES.forEach((s, i) => (stageList.children[i].querySelector(".detail").textContent = job.stages[s.id].detail));
    renderTime();
  }

  function renderTime() {
    if (!job) return;
    const end = job.state === "running" ? Date.now() : job.ended ?? Date.now();
    const elapsed = (end - job.started) / 1000;
    const f = overall();
    let text = `${clock(elapsed)} elapsed · ${Math.round(f * 100)}%`;
    if (job.state === "running" && f > 0.04 && elapsed > 8) text += ` · ~${clock((elapsed * (1 - f)) / f)} left`;
    $(".job-time").textContent = text;
  }

  // ---- Start-up: reconnect to a build that's already running ----
  updateHint();
  savedSource.show = false;
  loadSaved()
    .then(() => fetch("/api/jobs/current"))
    .then((r) => r.json())
    .then(({ job: current }) => current?.state === "running" && watch(current))
    .catch((err) => status(`Couldn't load regions: ${err.message}`, true));
}

function clock(s) {
  s = Math.max(0, Math.round(s));
  const mm = String(Math.floor((s % 3600) / 60)).padStart(s >= 3600 ? 2 : 1, "0");
  return `${s >= 3600 ? Math.floor(s / 3600) + ":" : ""}${mm}:${String(s % 60).padStart(2, "0")}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}
