import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  envDir: process.env.DIEZMOSSV_PRIVATE_BUILD === "1" ? false : undefined,
  plugins: [react()],
  build: {
    outDir: "dist/client",
    emptyOutDir: true
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/webhooks": "http://127.0.0.1:8787"
    }
  }
});
