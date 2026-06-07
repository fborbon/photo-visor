import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

const src = resolve(__dirname, 'src');

export default defineConfig({
  plugins: [react()],
  base: '/photo-visor/',
  define: {
    // Injected at build time → IS_DEMO = true in config.ts → tree-shaking strips real credentials
    'import.meta.env.VITE_DEMO': '"true"',
  },
  resolve: {
    alias: [
      // Swap useIndex → demo hook (fetches from /photo-visor base path)
      { find: resolve(src, 'hooks/useIndex'), replacement: resolve(src, 'hooks/useIndex.demo.ts') },
      // Swap contexts → no-auth demo versions
      { find: resolve(src, 'context/PrivacyContext'), replacement: resolve(src, 'context/PrivacyContext.demo.tsx') },
      { find: resolve(src, 'context/TagsContext'),    replacement: resolve(src, 'context/TagsContext.demo.tsx') },
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
