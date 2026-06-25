import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
  plugins: [
    react(),
  ],
  base: process.env.BASE_URL ?? './',
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks: {
          leaflet: ['leaflet', 'react-leaflet'],
          aws:     ['aws-amplify', '@aws-amplify/ui-react'],
          s3sdk:   ['@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner'],
        },
      },
    },
  },
});
