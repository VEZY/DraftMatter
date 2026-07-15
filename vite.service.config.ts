import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    target: 'node20',
    outDir: 'dist-service',
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    ssr: 'services/collaboration/main.ts',
    rollupOptions: {
      output: { entryFileNames: 'main.js' },
    },
  },
})
