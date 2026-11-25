/// <reference types="vitest/config" />
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Der Python-Server (uv run splattwin serve) liefert /api und /runs. Im Entwicklungsmodus leitet Vite
// diese Pfade dorthin weiter, damit Seiten und Server wie ein einziger Server wirken.
const API = 'http://127.0.0.1:8931';

const pages = ['index', 'tracking', 'capture', 'viewer', 'live'];

export default defineConfig({
  server: {
    host: '127.0.0.1',
    proxy: { '/api': API, '/runs': API },
  },
  build: {
    target: 'es2023',
    rollupOptions: {
      input: Object.fromEntries(pages.map((p) => [p, resolve(import.meta.dirname, `${p}.html`)])),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
