import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

// The map server's address for npm run test:server: HTTPS when it has a certificate
// (mapserver/tls/: then plain HTTP only redirects), else HTTP. Workers inherit it.
process.env.MAPSERVER_URL ??= existsSync("mapserver/tls/server.crt") ? "https://localhost:8443" : "http://localhost:8080";

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
    // The Docker map server (npm run test:server). Its certificate is from the project's own CA,
    // which the test browser doesn't know: a test checks it against mapserver/tls/ca.crt instead.
    { name: "server", testMatch: "server.spec.js", use: { ignoreHTTPSErrors: true } },
  ],
  webServer: [
    {
      command: "npx vite build && npx vite preview --port 4173 --strictPort",
      url: "http://localhost:4173",
      timeout: 180_000,
      reuseExistingServer: false,
      env: { VITE_MAP_SERVER_URL: "" }, // tested reading its own files, whatever .env.local says
    },
    {
      command: "npx vite --port 5174 --strictPort",
      url: "http://localhost:5174",
      reuseExistingServer: false,
      env: { VITE_MAP_SERVER_URL: "" }, // tested reading its own files, whatever .env.local says
    },
    // With the map server tests: a globe that takes its data from the map server
    ...(process.env.SERVER_TEST
      ? [{
          command: "npx vite --port 5175 --strictPort",
          url: "http://localhost:5175",
          env: { VITE_MAP_SERVER_URL: process.env.MAPSERVER_URL },
          reuseExistingServer: false,
        }]
      : []),
  ],
});
