import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5183, strictPort: true },
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_'],
  build: { target: 'chrome105', outDir: 'dist' },
  test: { environment: 'node', setupFiles: ['src/test/setup.js'], include: ['src/**/*.test.js'] },
});
