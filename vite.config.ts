import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `pnpm race --no-open` serves race.json on :4173; `pnpm dev` proxies to it.
export default defineConfig({
  root: 'viewer',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true, chunkSizeWarningLimit: 2000 },
  server: { proxy: { '/race.json': 'http://127.0.0.1:4173' } },
});
