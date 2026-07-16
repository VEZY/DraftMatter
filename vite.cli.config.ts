import { defineConfig } from 'vite'
import { chmod, copyFile, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export default defineConfig({
  publicDir: false,
  plugins: [{
    name: 'draftmatter-cli-executable',
    async closeBundle() {
      const rootPackage = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as { version: string }
      await Promise.all([
        chmod(resolve('dist-cli/draftmatter.js'), 0o755),
        copyFile(resolve('LICENSE'), resolve('dist-cli/LICENSE')),
        writeFile(resolve('dist-cli/package.json'), `${JSON.stringify({
          name: 'draftmatter',
          version: rootPackage.version,
          description: 'Clean, inert Markdown/Quarto review projections from DraftMatter.',
          type: 'module',
          bin: { draftmatter: 'draftmatter.js' },
          files: ['draftmatter.js', 'draftmatter.js.map'],
          engines: { node: '>=20' },
          license: 'MIT',
        }, null, 2)}\n`, 'utf8'),
        writeFile(resolve('dist-cli/README.md'), `# DraftMatter CLI

Create clean Original or Final projections from portable DraftMatter Markdown and Quarto manuscripts without executing document code.

\`\`\`sh
draftmatter render paper.qmd --view original -o original.qmd
draftmatter render paper.qmd --view final --select dm-change-id -o final.qmd
draftmatter render paper.qmd --view final --format html -o article.html
draftmatter review-report paper.qmd -o review-report.md
\`\`\`

Final rendering exits with status 2 and writes no output while a review conflict is unresolved. Use \`draftmatter --help\` for the complete command reference.
`, 'utf8'),
      ])
    },
  }],
  ssr: {
    noExternal: true,
  },
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
