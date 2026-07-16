import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const cli = join(root, 'dist-cli', 'draftmatter.js')
const fixture = join(root, 'src', 'fixtures', 'portable', '25-review-identical.qmd')
const temporary = await mkdtemp(join(tmpdir(), 'draftmatter-cli-'))

function run(arguments_, input) {
  return spawnSync(process.execPath, [cli, ...arguments_], {
    cwd: temporary,
    encoding: 'utf8',
    input,
  })
}

try {
  const source = await readFile(fixture, 'utf8')
  const input = join(temporary, 'paper.qmd')
  await writeFile(input, source, 'utf8')

  const blocked = run(['render', input, '--view', 'final'])
  assert.equal(blocked.status, 2)
  assert.equal(blocked.stdout, '')
  assert.match(blocked.stderr, /conflict:dm-i01\+dm-i02 requires exactly one proposal/)

  const output = join(temporary, 'final.qmd')
  const rendered = run(['render', input, '--select', 'dm-i02', '--output', output])
  assert.equal(rendered.status, 0, rendered.stderr)
  assert.equal(rendered.stdout, '')
  const finalSource = await readFile(output, 'utf8')
  assert.match(finalSource, /leaf expansion slowed/)
  assert.doesNotMatch(finalSource, /\.dm-anchor|\.draftmatter-reviews|data-anchor=/)

  const piped = run(['render', '-', '--view', 'original'], source)
  assert.equal(piped.status, 0, piped.stderr)
  assert.match(piped.stdout, /leaf area declined/)
  assert.doesNotMatch(piped.stdout, /\.dm-anchor|\.draftmatter-reviews|data-anchor=/)

  process.stdout.write('DraftMatter CLI verified: conflict failure, atomic file output, and stdin/stdout projection.\n')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
