import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
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
