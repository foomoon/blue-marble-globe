// Dev-only: the Regions panel's API inside the Vite dev server (npm run dev). It never exists in
// the production build: `apply: "serve"`. The API itself is server/studio-api.js; the map server's
// builder container runs it standalone (server/admin-api.js).
import { createStudioApi } from "./studio-api.js";

export { validateRegion } from "./studio-api.js";

export default function studio({ dir = "regions" } = {}) {
  return {
    name: "studio-api",
    apply: "serve",
    configureServer(server) {
      const api = createStudioApi({ projectRoot: server.config.root, dir });
      server.middlewares.use((req, res, next) => api.handle(req, res, next));
      server.httpServer?.on("close", () => api.close());
    },
  };
}
