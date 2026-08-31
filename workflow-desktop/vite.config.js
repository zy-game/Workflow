import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5183,
    strictPort: true,
    // Dev mode talks to Core same-origin through this proxy, so the browser
    // never makes a cross-origin request at all.
    proxy: {
      '/api': { target: 'http://127.0.0.1:8710', changeOrigin: true },
    },
  },
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_'],
  build: { target: 'chrome105', outDir: 'dist' },
  test: { environment: 'node', setupFiles: ['src/test/setup.js'], include: ['src/**/*.test.js'] },
});
