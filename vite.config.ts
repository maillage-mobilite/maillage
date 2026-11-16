import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'

export default defineConfig({
  plugins: [preact()],
  base: './',
  server: { port: 5199, strictPort: true },
  // deux pages : l'application et l'encart « prochains départs » pour les sites des communes
  build: { rollupOptions: { input: { main: 'index.html', widget: 'widget.html' } } },
})
