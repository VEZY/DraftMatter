import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: path.resolve(import.meta.dirname, 'website'),
  publicDir: path.resolve(import.meta.dirname, 'public'),
  base: process.env.DRAFTMATTER_SITE_BASE || '/DraftMatter/',
  plugins: [react()],
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist-website'),
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 4174,
  },
})
