import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

const projectRoot = join(process.cwd(), 'src/fixtures/projects/alpha-article')
const manuscriptPath = join(projectRoot, 'paper.qmd')
const checkOnly = process.argv.includes('--check')
const snapshotAt = '2026-07-18T08:00:00.000Z'
const cleanRunId = 'complete-example-snapshot-v1'

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}

function codeNodes(tree) {
  const nodes = []
  const visit = (node) => {
    if (node.type === 'code') nodes.push(node)
    if (Array.isArray(node.children)) node.children.forEach(visit)
  }
  visit(tree)
  return nodes
}

function attribute(meta, name) {
  const match = meta.match(new RegExp(`(?:^|\\s)${name}=(?:"([^"]*)"|'([^']*)'|([^\\s}]+))`))
  return match?.[1] ?? match?.[2] ?? match?.[3]
}

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function retainedOutput(source, cellId) {
  const match = source.match(new RegExp(
    `<!-- dm-output:start cell="${escaped(cellId)}"[^>]* -->[\\s\\S]*?<!-- dm-output:end -->`,
  ))
  if (!match) throw new Error(`Missing retained output for ${cellId}.`)
  return match[0]
}

async function manifests() {
  const source = await readFile(manuscriptPath, 'utf8')
  const tree = unified().use(remarkParse).parse(source)
  const sequenceByLanguage = new Map()
  const cells = codeNodes(tree).flatMap((node) => {
    const language = node.lang === 'python' || node.lang === 'r' || node.lang === 'julia'
      ? node.lang
      : undefined
    const meta = node.meta ?? ''
    const id = meta.match(/(?:^|[{\s])#([A-Za-z][A-Za-z0-9_.:-]{0,127})/)?.[1]
    return language && id && /(?:^|\s)\.execute(?:\s|}|$)/.test(meta)
      ? [{ id, language, source: node.value, meta }]
      : []
  })

  return await Promise.all(cells.map(async (cell, index) => {
    const executionSequence = (sequenceByLanguage.get(cell.language) ?? 0) + 1
    sequenceByLanguage.set(cell.language, executionSequence)
    const inputPaths = (attribute(cell.meta, 'inputs') ?? '').split(',').map((value) => value.trim()).filter(Boolean)
    const inputs = await Promise.all(inputPaths.map(async (path) => ({
      path,
      hash: sha256(await readFile(join(projectRoot, path))),
    })))
    const artifactPaths = (attribute(cell.meta, 'produces') ?? '').split(',').map((value) => value.trim()).filter(Boolean)
    const artifacts = await Promise.all(artifactPaths.map(async (path) => {
      const absolute = join(projectRoot, path)
      const bytes = await readFile(absolute)
      return {
        path,
        bytes: (await stat(absolute)).size,
        hash: sha256(bytes),
        ...(path.endsWith('.svg') ? { mediaType: 'image/svg+xml' } : {}),
      }
    }))
    const environment = {
      language: cell.language,
      identity: 'DraftMatter complete example snapshot',
      version: '1',
      details: { fixture: 'alpha-article' },
    }
    const retained = await retainedOutput(source, cell.id)
    const manifest = {
      schemaVersion: 2,
      cellId: cell.id,
      language: cell.language,
      status: 'succeeded',
      codeHash: sha256(cell.source),
      inputsHash: sha256(stableJson(inputs.sort((left, right) => left.path.localeCompare(right.path)))),
      environmentFingerprint: sha256(stableJson(environment)),
      environmentIdentity: environment.identity,
      environmentVersion: environment.version,
      resultHash: sha256(stableJson({ retained, artifacts })),
      artifacts,
      sessionGeneration: 1,
      executionSequence,
      executionCount: executionSequence,
      startedAt: snapshotAt,
      finishedAt: snapshotAt,
      durationMs: 0,
      sequence: index,
      cleanRunId,
    }
    const digest = sha256(cell.id).slice('sha256:'.length, 'sha256:'.length + 12)
    return {
      path: join(projectRoot, '.draftmatter', 'outputs', `${cell.id}--${digest}`, 'manifest.json'),
      content: `${JSON.stringify(manifest, null, 2)}\n`,
    }
  }))
}

const expected = await manifests()
const mismatches = []
for (const file of expected) {
  let current
  try {
    current = await readFile(file.path, 'utf8')
  } catch {
    current = undefined
  }
  if (current === file.content) continue
  if (checkOnly) mismatches.push(file.path)
  else {
    await mkdir(dirname(file.path), { recursive: true })
    await writeFile(file.path, file.content)
  }
}

if (checkOnly) {
  const outputsRoot = join(projectRoot, '.draftmatter', 'outputs')
  let existing = []
  try {
    const directories = await readdir(outputsRoot, { withFileTypes: true })
    existing = directories
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(outputsRoot, entry.name, 'manifest.json'))
  } catch {
    // A missing output directory is reported through the expected manifest mismatches.
  }
  const expectedPaths = new Set(expected.map((file) => file.path))
  mismatches.push(...existing.filter((path) => !expectedPaths.has(path)))
  if (mismatches.length) {
    throw new Error(`Complete-example manifests are not current:\n${mismatches.join('\n')}`)
  }
}

console.log(`${checkOnly ? 'Verified' : 'Updated'} ${expected.length} complete-example execution manifests.`)
