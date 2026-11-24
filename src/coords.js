// Lat/lon readout, bottom right: the point under the cursor, or the centre of the view
// when the cursor is off the globe (or on touch screens, where there's no cursor). With terrain
// on, the ground's altitude there too, and above it, where that altitude comes from and how much
// detail it has.
import * as Cesium from "cesium";
import "./coords.css";

const fmt = (deg, pos, neg) => `${Math.abs(deg).toFixed(4)}° ${deg >= 0 ? pos : neg}`;

export function mountCoords(viewer) {
  const { scene, camera } = viewer;
  const box = document.createElement("div");
  box.className = "coords";
  box.setAttribute("aria-live", "off");
  const terrainLine = document.createElement("div");
  terrainLine.className = "coords-terrain";
  terrainLine.hidden = true;
  const posLine = document.createElement("div");
  // What the numbers are measured against: the WGS84 ellipsoid (Cesium's Earth model, and GPS's)
  // for latitude and longitude; mean sea level for the altitude, which isn't the ellipsoid
  const datum = document.createElement("span");
  datum.className = "coords-datum";
  datum.textContent = "WGS84  ";
  datum.title = "Latitude and longitude on the WGS84 ellipsoid: Cesium's model of the Earth's shape, as used by GPS.";
  const posText = document.createElement("span");
  const altText = document.createElement("span"); // filled in when the terrain lookup returns
  altText.className = "coords-alt";
  posLine.append(datum, posText, altText);
  altText.title =
    "Altitude above mean sea level (MSL), as each terrain source defines it: EGM2008 for NOAA ETOPO, EGM96 for " +
    "NASADEM, the national datum for USGS 3DEP (e.g. NAVD88). Not above the WGS84 ellipsoid: sea level is up to " +
    "about 100 m above or below it, depending on place, so a GPS (ellipsoidal) altitude differs by that much.";
  box.append(terrainLine, posLine);
  document.body.append(box);

  let overGlobe = false;
  let terrainAt = null; // (lon, lat) => Promise<{source, height, detail, sea} | null>
  let wanted = null; // the latest point to look up
  let last = null; // the point shown
  let looking = false;

  // One lookup at a time, always for the latest point: moving the cursor fast doesn't queue up
  async function updateTerrain() {
    if (looking || !terrainAt) return;
    looking = true;
    while (wanted) {
      const [lon, lat] = wanted;
      wanted = null;
      let t = null;
      try {
        t = await terrainAt(lon, lat);
      } catch {}
      if (wanted) continue; // the cursor has moved on: skip showing this one
      terrainLine.hidden = !t;
      altText.textContent = t ? `  ${`${Math.round(t.sea ? 0 : t.height).toLocaleString("en")} m`.padStart(7)} MSL` : "";
      if (t) {
        const spacing = `≈${Number(t.detail.toPrecision(2)).toLocaleString("en")} m`;
        terrainLine.textContent = t.sea ? `${t.source} · sea level` : `${t.source} · ${spacing} detail`;
        terrainLine.title = t.sea
          ? `Terrain here: ${t.source}. Land only: the sea is shown at sea level.`
          : `Terrain here: ${t.source}. Altitude above sea level, averaged over ${spacing}: ` +
            `sharp peaks read lower than their summits, and features smaller than ${spacing} don't show.`;
      }
    }
    looking = false;
  }

  function show(screenPos, label) {
    // The terrain surface (so a tilted view over mountains reads the right place), else the ellipsoid
    const c = screenPos && (scene.globe.pick(camera.getPickRay(screenPos), scene) ?? camera.pickEllipsoid(screenPos, scene.globe.ellipsoid));
    if (!c) {
      posText.textContent = "—";
      altText.textContent = "";
      posLine.title = "";
      terrainLine.hidden = true;
      return false;
    }
    const g = Cesium.Cartographic.fromCartesian(c);
    const lat = Cesium.Math.toDegrees(g.latitude), lon = Cesium.Math.toDegrees(g.longitude);
    posText.textContent = `${fmt(lat, "N", "S")}  ${fmt(lon, "E", "W")}`;
    posLine.title = label;
    wanted = last = [lon, lat];
    updateTerrain();
    return true;
  }

  const centre = () => new Cesium.Cartesian2(scene.canvas.clientWidth / 2, scene.canvas.clientHeight / 2);
  const showCentre = () => show(centre(), "Centre of the view");

  const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
  handler.setInputAction((e) => {
    overGlobe = show(e.endPosition, "Under the cursor");
    if (!overGlobe) showCentre();
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
  scene.canvas.addEventListener("mouseleave", () => {
    overGlobe = false;
    showCentre();
  });
  camera.changed.addEventListener(() => !overGlobe && showCentre());
  camera.percentageChanged = 0.01;
  document.addEventListener("terrain:changed", () => {
    wanted = last;
    updateTerrain();
  });
  showCentre();

  return {
    /** Show the terrain under the point too; `fn(lon, lat)` resolves to its details, or null. */
    setTerrain(fn) {
      terrainAt = fn;
      showCentre();
    },
  };
}
