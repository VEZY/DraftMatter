import { defineConfig } from 'vite'
import { chmod } from 'node:fs/promises'
import { resolve } from 'node:path'

export default defineConfig({
  publicDir: false,
  plugins: [{
    name: 'draftmatter-cli-executable',
    async closeBundle() {
      await chmod(resolve('dist-cli/draftmatter.js'), 0o755)
    },
  }],
  build: {
    target: 'node20',
    outDir: 'dist-cli',
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    ssr: 'src/draftmatterCliMain.ts',
    rollupOptions: {
      output: {
        banner: '#!/usr/bin/env node',
        entryFileNames: 'draftmatter.js',
      },
    },
  },
})
