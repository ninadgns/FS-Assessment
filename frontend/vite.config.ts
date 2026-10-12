import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: { '/api': 'http://localhost:8000' },
  },
  build: {
    // MapLibre alone is ~800 kB minified; it is loaded once and cached immutably.
    chunkSizeWarningLimit: 1200,
  },
})
