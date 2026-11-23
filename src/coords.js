// Lat/lon readout, bottom right: the point under the cursor, or the centre of the view
// when the cursor is off the globe (or on touch screens, where there's no cursor).
import * as Cesium from "cesium";
import "./coords.css";

const fmt = (deg, pos, neg) => `${Math.abs(deg).toFixed(4)}° ${deg >= 0 ? pos : neg}`;

export function mountCoords(viewer) {
  const { scene, camera } = viewer;
  const box = document.createElement("div");
  box.className = "coords";
  box.setAttribute("aria-live", "off");
  document.body.append(box);

  let overGlobe = false;

  function show(screenPos, label) {
    const c = screenPos && camera.pickEllipsoid(screenPos, scene.globe.ellipsoid);
    if (!c) {
      box.textContent = "—";
      box.title = "";
      return false;
    }
    const g = Cesium.Cartographic.fromCartesian(c);
    const lat = Cesium.Math.toDegrees(g.latitude), lon = Cesium.Math.toDegrees(g.longitude);
    box.textContent = `${fmt(lat, "N", "S")}  ${fmt(lon, "E", "W")}`;
    box.title = label;
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
  showCentre();
}
