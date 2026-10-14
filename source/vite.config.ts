import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { outDir: 'dist', emptyOutDir: false, assetsInlineLimit: 0 },
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
});
