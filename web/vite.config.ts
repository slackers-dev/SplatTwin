/// <reference types="vitest/config" />
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Der Python-Server (uv run splattwin serve) liefert /api, /ws, /runs und /stage. Im Entwicklungsmodus leitet Vite
// diese Pfade dorthin weiter, damit Seiten und Server wie ein einziger Server wirken.
const API = 'http://127.0.0.1:8931';

const pages = ['index', 'tracking', 'capture', 'viewer', 'live', 'control', 'login'];

export default defineConfig({
  server: {
    host: '127.0.0.1',
    proxy: { '/api': API, '/runs': API, '/stage': API, '/ws': { target: API.replace('http', 'ws'), ws: true } },
  },
  build: {
    target: 'es2023',
    // three.js und Spark sind zusammen gut 3 MB (vorher genauso gross vom CDN geladen).
    chunkSizeWarningLimit: 4000,
    rolldownOptions: {
      input: Object.fromEntries(pages.map((p) => [p, resolve(import.meta.dirname, `${p}.html`)])),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
