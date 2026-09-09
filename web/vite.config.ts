import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// GH Pages serves the site under /<repo-name>/, so asset URLs must be
// prefixed. Set VITE_BASE_PATH=/grubmaps/ at build time in CI.
// Locally (dev + prod build) VITE_BASE_PATH is unset → root '/'.
export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? "/",
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
