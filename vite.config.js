import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // onnxruntime-web ships large wasm chunks; don't let Vite inline or warn on them
  build: { chunkSizeWarningLimit: 2000, assetsInlineLimit: 0 },
  optimizeDeps: { exclude: ['@imgly/background-removal'] },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
});
