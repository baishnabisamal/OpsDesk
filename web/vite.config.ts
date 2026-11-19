import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// In development the browser talks only to Vite (port 5173). Vite forwards
// API calls to the Express API (3000) and the WebSocket to the realtime
// gateway (3001). Same origin for the browser, so the API needs no CORS.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    // npm workspaces install packages (the fonts too) in the repository's
    // node_modules, one level up. Allow it explicitly, or the dev server
    // answers 403 for the font files.
    fs: { allow: [".."] },
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/healthz": "http://127.0.0.1:3000",
      "/openapi.json": "http://127.0.0.1:3000",
      "/socket.io": { target: "http://127.0.0.1:3001", ws: true },
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
