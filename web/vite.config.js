import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

/**
 * Relative Web Paths (`base: './'`) required so bundled assets load inside both:
 * 1. Android WebViewAssetLoader (`https://appassets.androidplatform.net/assets/web/index.html`)
 * 2. GitHub Pages subpath deployments
 */
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
  },
});
