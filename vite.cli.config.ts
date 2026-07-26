import { defineConfig } from 'vite'
import { chmod, copyFile, cp, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export default defineConfig({
  publicDir: false,
  plugins: [{
    name: 'draftmatter-cli-executable',
    async writeBundle() {
      const rootPackage = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as { version: string }
      await Promise.all([
        chmod(resolve('dist-cli/draftmatter.js'), 0o755),
        copyFile(resolve('LICENSE'), resolve('dist-cli/LICENSE')),
        cp(resolve('integrations'), resolve('dist-cli/integrations'), { recursive: true }),
        writeFile(resolve('dist-cli/package.json'), `${JSON.stringify({
          name: 'draftmatter',
          version: rootPackage.version,
          description: 'DraftMatter clean exports and provider-neutral local AI authoring tools.',
          type: 'module',
          bin: { draftmatter: 'draftmatter.js' },
          files: ['draftmatter.js', 'draftmatter.js.map', 'integrations/**'],
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

The package also contains the canonical \`draftmatter-authoring\` skill and
Codex plugin under \`integrations/\`. Local MCP computation requires the
platform \`draftmatter-agent-host\` executable from the matching DraftMatter
desktop release on PATH or in \`DRAFTMATTER_AGENT_HOST\`.
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
