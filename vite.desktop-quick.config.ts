import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const DEV_API_PORT = Number(process.env.WEMAIL_DEV_API_PORT ?? 3001);

export default defineConfig({
  root: path.join(repoRoot, "desktop-quick"),
  publicDir: path.join(repoRoot, "public"),
  plugins: [
    react(),
    tailwindcss(),
    tsconfigPaths({ projects: [path.join(repoRoot, "tsconfig.app.json")] }),
  ],
  resolve: {
    alias: {
      "~": path.join(repoRoot, "app"),
    },
  },
  server: {
    fs: {
      allow: [repoRoot],
    },
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${DEV_API_PORT}`,
        changeOrigin: false,
      },
    },
  },
});
