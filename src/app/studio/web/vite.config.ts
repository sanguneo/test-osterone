import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Built to ./dist and served as static assets by the Studio API server.
export default defineConfig({
	base: "./",
	plugins: [react()],
	build: { outDir: "dist", emptyOutDir: true },
});
