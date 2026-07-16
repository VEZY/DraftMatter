import { describe, expect, it } from 'vitest'
import identicalSource from './fixtures/portable/25-review-identical.qmd?raw'
import { runDraftMatterCli, type DraftMatterCliIo } from './draftmatterCli'

function harness(source = identicalSource) {
  const stdout: string[] = []
  const stderr: string[] = []
  const writes: Array<{ path: string; content: string }> = []
  const io: DraftMatterCliIo = {
    async readText() { return source },
    async writeText(path, content) {
      if (path === '-') stdout.push(content)
      else writes.push({ path, content })
    },
    stdout(content) { stdout.push(content) },
    stderr(content) { stderr.push(content) },
  }
  return { io, stdout, stderr, writes }
}

describe('DraftMatter CLI', () => {
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
})
