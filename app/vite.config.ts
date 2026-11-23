import { defineConfig } from "vite";

// Configurazione pensata per Tauri: porta fissa, nessun clear dello schermo.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: { target: "es2022", sourcemap: !!process.env.TAURI_ENV_DEBUG },
});
