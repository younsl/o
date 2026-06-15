import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The build output is embedded into the Go binary (internal/webui/dist).
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../internal/webui/dist",
    emptyOutDir: true,
  },
  server: {
    // During `npm run dev`, proxy API and package routes to the Go server.
    proxy: {
      "/api": "http://localhost:8080",
      "/auth": "http://localhost:8080",
      "/maven": "http://localhost:8080",
      "/npm": "http://localhost:8080",
      "/cargo": "http://localhost:8080",
      "/go": "http://localhost:8080",
    },
  },
});
