import { defineConfig } from "@playwright/test";

// Two targets:
//   prod: the production build (`vite build` + `vite preview`), which is what gets
//         deployed and what LICENSING.md makes claims about
//   dev:  the dev server, for the dev-only Regions studio
// Ports differ from `npm run dev` (5173), so tests can run while you work.
export default defineConfig({
  testDir: "tests",
  timeout: 90_000,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    viewport: { width: 1280, height: 800 },
    launchOptions: {
      // Headless Chromium has no GPU: render WebGL in software (SwiftShader)
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    },
  },
  projects: [
    { name: "prod", testMatch: "globe.spec.js", use: { baseURL: "http://localhost:4173" } },
    { name: "dev", testMatch: /(studio|build)\.spec\.js/, use: { baseURL: "http://localhost:5174" } },
    { name: "server", testMatch: "server.spec.js" }, // the Docker map server (npm run test:server)
  ],
  webServer: [
    {
      command: "npx vite build && npx vite preview --port 4173 --strictPort",
      url: "http://localhost:4173",
      timeout: 180_000,
      reuseExistingServer: false,
    },
    {
      command: "npx vite --port 5174 --strictPort",
      url: "http://localhost:5174",
      reuseExistingServer: false,
    },
  ],
});
