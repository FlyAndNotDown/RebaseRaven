import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, normalizePath } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;
const root = path.dirname(fileURLToPath(import.meta.url));
const temporaryFiles = `${normalizePath(path.resolve(root, "temp"))}/**`;

export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(root, "./src"),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    fs: {
      deny: [".env", ".env.*", "*.{crt,pem,key,p12,pfx,cer,der}", ".npmrc", ".yarnrc.yml", "**/.git/**", temporaryFiles],
    },
    watch: {
      ignored: ["**/src-tauri/**", temporaryFiles],
    },
  },
}));
