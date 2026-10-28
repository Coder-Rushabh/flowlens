import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `npm run dev:ui` proxies the API to a running `flowlens ui --no-open` on 4870.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:4870" } },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 2500 },
});
