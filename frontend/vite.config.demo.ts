import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

const src = resolve(__dirname, 'src');

export default defineConfig({
  plugins: [react()],
  base: '/photo-visor/',
  resolve: {
    alias: [
      // Swap config → demo config (cloudFrontUrl = picsum, indexBase = /photo-visor)
      { find: /^(.+)\/config$/, replacement: resolve(src, 'config.demo.ts') },
      // Swap useIndex → demo hook (fetches from /photo-visor base)
      { find: /^(.+)\/hooks\/useIndex$/, replacement: resolve(src, 'hooks/useIndex.demo.ts') },
      // Swap contexts → no-auth demo versions
      { find: /^(.+)\/context\/PrivacyContext$/, replacement: resolve(src, 'context/PrivacyContext.demo.tsx') },
      { find: /^(.+)\/context\/TagsContext$/,    replacement: resolve(src, 'context/TagsContext.demo.tsx') },
    ],
  },
  build: {
    outDir: 'dist-demo',
    rollupOptions: {
      input: resolve(__dirname, 'index.demo.html'),
      output: {
        manualChunks: {
          leaflet: ['leaflet', 'react-leaflet', 'react-leaflet-cluster'],
        },
      },
    },
  },
});
