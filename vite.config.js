import { copyFileSync, rmSync } from "node:fs";
import { defineConfig } from "vite";
import cesium from "vite-plugin-cesium";
import studio from "./server/studio.js";

// After the build: leave out Cesium's moon texture, whose source isn't documented as
// public domain (the app never draws the moon; see src/main.js), and ship Cesium's
// Apache-2.0 licence with its runtime. See LICENSING.md.
const licenceHygiene = {
  name: "licence-hygiene",
  apply: "build",
  enforce: "post",
  closeBundle: {
    order: "post",
    sequential: true, // run after vite-plugin-cesium has copied its assets
    handler() {
      rmSync("dist/cesium/Assets/Textures/moonSmall.jpg", { force: true });
      // Apache-2.0 requires the licence to travel with redistributed Cesium code
      copyFileSync("node_modules/cesium/LICENSE.md", "dist/cesium/LICENSE.md");
    },
  },
};

export default defineConfig({
  plugins: [cesium(), licenceHygiene, studio()],
});
