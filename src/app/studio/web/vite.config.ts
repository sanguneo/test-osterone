import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const rootDir = dirname(fileURLToPath(import.meta.url));

// Built to ./dist and served as static assets by the Studio API server.
// publicDir points at the project-root `assets/` dir so logo.png / logo-forged.png
// stay the single source of truth and are copied verbatim to dist root (favicon + hero).
export default defineConfig({
	base: "./",
	publicDir: resolve(rootDir, "../../../../assets"),
	plugins: [react()],
	build: { outDir: "dist", emptyOutDir: true },
});
