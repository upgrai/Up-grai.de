import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Lokale Entwicklung: `npm run preview` baut die Oberfläche und startet den Worker (wrangler dev) auf :8787.
// `npm run dev` startet nur die Oberfläche und leitet API-Aufrufe an einen laufenden Worker weiter.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
      '/mcp': 'http://localhost:8787',
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
