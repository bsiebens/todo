/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Set by the Tauri CLI when it builds the desktop app. The desktop app loads its files
// from the app bundle, so it needs no service worker or install manifest.
const desktop = !!process.env.TAURI_ENV_PLATFORM;

export default defineConfig({
  clearScreen: false,
  plugins: [
    react(),
    VitePWA({
      disable: desktop,
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'ToDo',
        short_name: 'ToDo',
        description: 'Personal tasks for home and office',
        theme_color: '#2563eb',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
      },
      workbox: {
        importScripts: ['push-sw.js'],
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ['**/*.{js,css,html,svg,wasm}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
    }),
  ],
  // `npm run dev` and `npm run preview` talk to a sync server started with `npm run dev:server`.
  server: { strictPort: true, proxy: { '/api': { target: 'http://localhost:8080', ws: true } } },
  preview: { proxy: { '/api': { target: 'http://localhost:8080', ws: true } } },
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  worker: { format: 'es' },
  test: { environment: 'node', include: ['src/**/*.test.ts', 'server/**/*.test.ts'] },
});
