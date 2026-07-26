import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const canonical = join(root, 'integrations', 'skills', 'draftmatter-authoring')
const targets = [
  join(root, 'integrations', 'plugins', 'draftmatter', 'skills', 'draftmatter-authoring'),
]
const files = [
  'SKILL.md',
  'agents/openai.yaml',
  'references/protocol.md',
  'references/examples.md',
]
const verify = process.argv.includes('--verify')

for (const relative of files) {
  const source = await readFile(join(canonical, relative), 'utf8')
  for (const target of targets) {
    const path = join(target, relative)
    if (verify) {
      assert.equal(await readFile(path, 'utf8'), source, `${path} is stale; run npm run agent:sync`)
    } else {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, source, 'utf8')
    }
  }
}

process.stdout.write(verify
  ? 'DraftMatter agent integration copies match the canonical skill.\n'
  : 'DraftMatter agent integration copies synchronized.\n')

