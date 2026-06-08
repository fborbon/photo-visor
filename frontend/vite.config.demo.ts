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
      // Full-string regex aliases: replace() swaps the ENTIRE import specifier with
      // the absolute replacement path. Partial regexes would leave a dangling prefix.
      { find: /^.*\/hooks\/useIndex$/,        replacement: resolve(src, 'hooks/useIndex.demo.ts') },
      { find: /^.*\/context\/PrivacyContext$/, replacement: resolve(src, 'context/PrivacyContext.demo.tsx') },
      { find: /^.*\/context\/TagsContext$/,    replacement: resolve(src, 'context/TagsContext.demo.tsx') },
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
