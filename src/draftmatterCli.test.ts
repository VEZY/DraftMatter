import { describe, expect, it } from 'vitest'
import identicalSource from './fixtures/portable/25-review-identical.qmd?raw'
import { runDraftMatterCli, type DraftMatterCliIo } from './draftmatterCli'

function harness(source = identicalSource) {
  const stdout: string[] = []
  const stderr: string[] = []
  const writes: Array<{ path: string; content: string }> = []
  const opened: Array<string | undefined> = []
  const io: DraftMatterCliIo = {
    async readText() { return source },
    async writeText(path, content) {
      if (path === '-') stdout.push(content)
      else writes.push({ path, content })
    },
    async openApplication(projectPath) { opened.push(projectPath) },
    stdout(content) { stdout.push(content) },
    stderr(content) { stderr.push(content) },
  }
  return { io, stdout, stderr, writes, opened }
}

describe('DraftMatter CLI', () => {
  it('embeds confined image files into standalone HTML and fails closed when they cannot be read', async () => {
    const result = harness('# Paper\n\n![Response](figures/response.svg)\n')
    const reads: Array<{ input: string; paths: string[] }> = []
    result.io.readPublicationAssets = async (input, paths) => {
      reads.push({ input, paths })
      return [{ path: 'figures/response.svg', bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>') }]
    }
    expect(await runDraftMatterCli(['render', 'paper.qmd', '--format=html'], result.io)).toBe(0)
    expect(reads).toEqual([{ input: 'paper.qmd', paths: ['figures/response.svg'] }])
    expect(result.stdout.join('')).toContain('src="data:image/svg+xml;base64,')
    const unavailable = harness('# Paper\n\n![Response](figures/missing.png)\n')
    expect(await runDraftMatterCli(['render', '-', '--format=html'], unavailable.io)).toBe(2)
    expect(unavailable.stdout).toEqual([])
    expect(unavailable.stderr.join('')).toContain('figure files are unavailable')
  })
  it('opens like a regular application with no command or with one project folder', async () => {
    const result = harness()
    expect(await runDraftMatterCli([], result.io)).toBe(0)
    expect(await runDraftMatterCli(['open', '/research/paper'], result.io)).toBe(0)
    expect(result.opened).toEqual([undefined, '/research/paper'])
    expect(result.stdout).toEqual([])
    expect(result.stderr).toEqual([])
  })

  it('keeps the default help short and puts integration commands in advanced help', async () => {
    const basic = harness()
    expect(await runDraftMatterCli(['--help'], basic.io)).toBe(0)
    expect(basic.stdout.join('')).toContain('draftmatter open [project-folder]')
    expect(basic.stdout.join('')).not.toContain('draftmatter mcp')

    const advanced = harness()
    expect(await runDraftMatterCli(['help', 'advanced'], advanced.io)).toBe(0)
    expect(advanced.stdout.join('')).toContain('draftmatter mcp --stdio')
  })

  it('emits a clean Original projection to standard output', async () => {
    const result = harness()
    expect(await runDraftMatterCli(['render', 'paper.qmd', '--view', 'original'], result.io)).toBe(0)
    expect(result.stdout.join('')).toContain('leaf area declined')
    expect(result.stdout.join('')).not.toMatch(/\.dm-anchor|\.draftmatter-reviews|data-anchor=/)
    expect(result.stderr).toEqual([])
  })

  it('fails Final closed with an actionable conflict list and no output', async () => {
    const result = harness()
    expect(await runDraftMatterCli(['render', 'paper.qmd', '--view', 'final'], result.io)).toBe(2)
    expect(result.stdout).toEqual([])
    expect(result.writes).toEqual([])
    expect(result.stderr.join('')).toContain('conflict:dm-i01+dm-i02 requires exactly one proposal')
    expect(result.stderr.join('')).toContain('--select dm-i01')
  })

  it('materializes one selected alternative without review storage', async () => {
    const result = harness()
    expect(await runDraftMatterCli(['render', 'paper.qmd', '--select', 'dm-i02', '-o', 'final.qmd'], result.io)).toBe(0)
    expect(result.writes).toHaveLength(1)
    expect(result.writes[0]).toMatchObject({ path: 'final.qmd' })
    expect(result.writes[0].content).toContain('leaf expansion slowed')
    expect(result.writes[0].content).not.toMatch(/\.dm-anchor|\.draftmatter-reviews|data-anchor=/)
  })

  it('renders the selected clean projection through the inert native HTML renderer', async () => {
    const result = harness()
    expect(await runDraftMatterCli(['render', 'paper.qmd', '--select=dm-i01', '--format=html'], result.io)).toBe(0)
    expect(result.stdout.join('')).toContain('<!doctype html>')
    expect(result.stdout.join('')).toContain('leaf area declined by 18%')
    expect(result.stdout.join('')).not.toMatch(/\.dm-anchor|\.draftmatter-reviews|<script/)
  })

  it('exports a separate review report without portable storage syntax', async () => {
    const result = harness()
    expect(await runDraftMatterCli(['review-report', 'paper.qmd'], result.io)).toBe(0)
    expect(result.stdout.join('')).toContain('# DraftMatter review report')
    expect(result.stdout.join('')).toContain('dm-i01, dm-i02 — alternative')
    expect(result.stdout.join('')).not.toMatch(/\.dm-anchor|\.draftmatter-reviews|data-anchor=/)
  })

  it('reports invalid arguments without reading or writing a manuscript', async () => {
    const result = harness()
    expect(await runDraftMatterCli(['render', 'paper.qmd', '--view', 'preview'], result.io)).toBe(1)
    expect(result.stderr.join('')).toContain('Unknown review view “preview”')
    expect(result.stdout).toEqual([])
    expect(result.writes).toEqual([])
  })

  it('reports the agent protocol schema as one JSON document', async () => {
    const result = harness()
    expect(await runDraftMatterCli(['agent', 'schema'], result.io)).toBe(0)
    expect(result.stderr).toEqual([])
    expect(result.stdout).toHaveLength(1)
    expect(JSON.parse(result.stdout[0])).toMatchObject({
      protocolVersion: '1.0',
      command: 'draftmatter agent',
      operations: {
        project: expect.arrayContaining(['inspect']),
        manuscript: expect.arrayContaining(['read', 'mutate']),
      },
    })
  })

  it('rejects caller-selected generated identities before opening a project', async () => {
    const request = JSON.stringify({
      protocolVersion: '1.0',
      projectRoot: '/unopened',
      domain: 'computation',
      action: 'create',
      mode: 'apply',
      expectedRevision: `sha256:${'0'.repeat(64)}`,
      idempotencyKey: 'unsafe-cell-id-001',
      actor: { id: 'agent:test', name: 'Test agent' },
      cellId: 'chosen-by-caller',
      language: 'python',
      role: 'ordinary',
      source: '1 + 1',
      selector: { kind: 'document-boundary', edge: 'end' },
      placement: 'after',
    })
    const result = harness(request)
    expect(await runDraftMatterCli(['agent', '--request', '-'], result.io)).toBe(64)
    expect(result.stderr).toEqual([])
    expect(result.stdout).toHaveLength(1)
    expect(JSON.parse(result.stdout[0])).toMatchObject({
      ok: false,
      error: { category: 'invalid-request', code: 'unknown-field' },
    })
  })
})
