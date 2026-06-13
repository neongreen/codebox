import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Demo site for codebox. Built into ../docs and served from GitHub Pages at
// https://neongreen.github.io/codebox/, hence the base path.
export default defineConfig({
  base: "/codebox/",
  plugins: [react()],
  build: {
    outDir: "../docs",
    emptyOutDir: true,
  },
});
