import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const API = process.env.VITE_API_URL ?? "http://127.0.0.1:4100";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // The console calls the API on its own origin; the dev server forwards those calls.
    proxy: { "/v1": API },
  },
  preview: {
    proxy: { "/v1": API },
  },
});
