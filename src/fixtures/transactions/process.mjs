// Child-process fixture shared by Vitest and native Rust integration tests.
import { createServer } from 'vite'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import filesystem from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
const [root, mode] = process.argv.slice(2)
const server = await createServer({ configFile: false, root: resolve(import.meta.dirname, '../../..'), appType: 'custom', server: { middlewareMode: true, hmr: false, ws: false, watch: null } })
const { NodeAgentProjectStore } = await server.ssrLoadModule('/src/agentProjectStore.ts')
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const hold = async () => { send({ kind: 'held' }); await new Promise(() => { setInterval(() => {}, 1000) }) }
if (mode === 'hold-recovery' || mode === 'hold-committed' || mode === 'fail-committed') {
  const rename = filesystem.rename
  filesystem.rename = async (...args) => {
    await rename(...args)
    if (mode === 'hold-recovery' && String(args[1]).endsWith('/references.json')) await hold()
    if ((mode === 'hold-committed' || mode === 'fail-committed') && String(args[1]).endsWith('/manifest.json')) {
      if (JSON.parse(await filesystem.readFile(args[1], 'utf8')).state === 'committed') { if (mode === 'fail-committed') throw new Error('Injected failure after commit marker rename'); await hold() }
    }
  }
  syncBuiltinESMExports()
}

try {
  const store = await NodeAgentProjectStore.open(root, mode === 'hold' ? { afterReplacement: async (count) => { if (count === 1) await hold() } } : {})
  if (mode === 'recover') send({ kind: 'snapshot', paper: (await store.readText('paper.qmd')).content, references: (await store.readText('references.json')).content })
  else {
    const paper = await store.readText('paper.qmd')
    const references = await store.readText('references.json')
    if (mode === 'race') {
      const input = createInterface({ input: process.stdin })
      send({ kind: 'ready' })
      await new Promise((resolve) => input.once('line', resolve))
      input.close()
    }
    try {
      await store.commit([{ path: 'paper.qmd', content: `new-paper-${process.pid}`, expectedRevision: paper.revision }, { path: 'references.json', content: 'new-references', expectedRevision: references.revision }])
      send({ kind: 'result', ok: true })
    } catch (error) { send({ kind: 'result', ok: false, code: error.code, message: error.message }) }
  }
} finally { await server.close() }
