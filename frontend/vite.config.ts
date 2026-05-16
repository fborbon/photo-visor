import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons/*.png'],
      manifest: false,               // we use our own public/manifest.json
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        runtimeCaching: [
          {
            // Cache thumbnails aggressively
            urlPattern: /\/thumbs\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'thumbs-cache',
              expiration: { maxEntries: 5000, maxAgeSeconds: 30 * 24 * 60 * 60 },
            },
          },
          {
            // Cache index files with network-first (fresh data preferred)
            urlPattern: /\/index\//,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'index-cache',
              expiration: { maxEntries: 200, maxAgeSeconds: 24 * 60 * 60 },
            },
          },
        ],
      },
    }),
  ],
  base: '/app/',
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks: {
          leaflet: ['leaflet', 'react-leaflet', 'react-leaflet-cluster'],
          aws:     ['aws-amplify', '@aws-amplify/ui-react'],
          s3sdk:   ['@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner'],
        },
      },
    },
  },
});
