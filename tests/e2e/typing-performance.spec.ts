import { showWritingTools } from './writing-tools'
import { expect, test } from '@playwright/test'
import type { CitationRecord } from '../../src/types'

const SOURCE_KEY = 'draftmatter.structured-source.v1'
const CITATIONS_KEY = 'draftmatter.citations.v1'
const RECORD_COUNT = 2552
const TYPING_TARGET = 'The typing target preserves ordinary prose and its editing history.'
const WARMUP = ' w'
const MEASURED = 'arm text'
const INSERTED = WARMUP + MEASURED
const PAINT_BUDGET_MS = 500

// Entirely generated fixtures: comparable manuscript/library sizes, no private paper or bibliography.
function fixture() {
  const records: CitationRecord[] = Array.from({ length: RECORD_COUNT }, (_, index) => {
    const suffix = String(index).padStart(4, '0')
    return {
      citekey: `typing${suffix}`, type: 'article', title: `Synthetic research observation ${suffix}`,
      authors: [`Alex Scholar${suffix}`, `Morgan Reviewer${suffix}`], year: String(2000 + index % 24),
      container: 'Journal of Generated Evidence', source: 'csl-json',
      provenance: { origin: 'project-file', locator: 'synthetic-references.json' },
      cslData: { abstract: 'Generated metadata for a reproducible browser regression, containing no private research data. '.repeat(2) },
    }
  })
  const prose = [
    'The generated observations describe repeatable measurements across independent experimental conditions.',
    'Each paragraph preserves its methodological assumptions and explains how the evidence supports the interpretation.',
    'The analysis separates sampling variation from the response of interest and records the limits of the comparison.',
    'These ordinary sentences exercise the complete manuscript editor while keeping the data entirely synthetic.',
  ].join(' ')
  let source = `# Synthetic manuscript typing regression\n\n${TYPING_TARGET}\n\n`
  let paragraph = 0
  while (Buffer.byteLength(source, 'utf8') < 70_000) {
    if (paragraph % 10 === 0) source += `## Generated section ${paragraph / 10 + 1}\n\n`
    const first = String(paragraph * 2).padStart(4, '0'), second = String(paragraph * 2 + 1).padStart(4, '0')
    source += `${prose} This evidence is recorded in the synthetic literature [@typing${first}; @typing${second}].\n\n`
    paragraph++
  }
  return { source, records, citedRecords: paragraph * 2 }
}

interface PaintSample { key: string; start: number; paintMs?: number }
interface TypingProbe { samples: PaintSample[]; citationChanges: string[] }
declare global { interface Window { __dmTypingPerformance: TypingProbe } }
const percentile95 = (values: number[]) => [...values].sort((left, right) => left - right)[Math.ceil(values.length * .95) - 1]

// Keep the real pencil effects enabled; retain a trace for diagnosing timing/state regressions.
test.use({ reducedMotion: 'no-preference', trace: 'on' })

test('ordinary typing stays responsive with a large library without citation flicker or history loss', async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  const { source, records, citedRecords } = fixture()
  await page.addInitScript(({ source, records }) => {
    // Reload must exercise the saved edits rather than overwrite them with the fixture.
    if (sessionStorage.getItem('draftmatter.typing-regression.seeded')) return
    localStorage.setItem('draftmatter.structured-source.v1', source)
    localStorage.setItem('draftmatter.structured-mode.v1', 'true')
    localStorage.setItem('draftmatter.citations.v1', JSON.stringify(records))
    localStorage.setItem('draftmatter.project-meta.v1', JSON.stringify({
      filename: 'synthetic-typing.md', projectName: 'Synthetic typing regression',
      citationStyle: 'draftmatter-author-date', citationLocale: 'en-US',
    }))
    sessionStorage.setItem('draftmatter.typing-regression.seeded', 'true')
  }, { source, records })
  await page.goto('/draft')
  const editor = page.getByRole('textbox', { name: 'Rendered manuscript editor', exact: true })
  const citations = editor.locator('.structured-citation')
  const entries = page.locator('#references .bibliography-entries > p')
  await expect(editor).toBeVisible({ timeout: 30_000 })
  // A bibliography entry proves the actual WASM formatter completed; an absent loading icon does not.
  await expect(entries).toHaveCount(citedRecords, { timeout: 30_000 })
  await expect(citations.first()).toContainText('Scholar0000 and Reviewer0000')
  const initialLabels = await citations.allTextContents()
  const initialBibliography = await entries.allTextContents()
  expect(initialLabels.length).toBeGreaterThan(100)
  expect(Buffer.byteLength(source, 'utf8')).toBeGreaterThanOrEqual(70_000)

  await page.evaluate(() => {
    const article = document.querySelector('.manuscript')!
    const labels = () => [...article.querySelectorAll('.structured-citation')].map((element) => element.textContent ?? '')
    const initialLabels = labels()
    const initialCount = article.querySelectorAll('#references .bibliography-entries > p').length
    const expectedByTitle = new Map([...article.querySelectorAll<HTMLElement>('.structured-citation')].map((element) => [element.title, element.textContent ?? '']))
    const probe: TypingProbe = window.__dmTypingPerformance = { samples: [], citationChanges: [] }
    const problem = (message: string) => { if (probe.citationChanges.length < 8) probe.citationChanges.push(message) }
    new MutationObserver((mutations) => {
      if (JSON.stringify(labels()) !== JSON.stringify(initialLabels)) problem('citation-labels-changed')
      if (article.querySelectorAll('#references .bibliography-entries > p').length !== initialCount) problem('bibliography-disappeared')
      for (const mutation of mutations) {
        const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement
        const citation = target?.closest<HTMLElement>('.structured-citation')
        if (!citation) continue
        for (const added of mutation.addedNodes) {
          if (added.nodeType === Node.TEXT_NODE && added.textContent !== expectedByTitle.get(citation.title)) problem('transient-citation-fallback')
        }
      }
    }).observe(article, { subtree: true, childList: true, characterData: true })
    document.addEventListener('keydown', (event) => {
      if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return
      const sample: PaintSample = { key: event.key, start: performance.now() }
      probe.samples.push(sample)
      requestAnimationFrame(() => requestAnimationFrame(() => { sample.paintMs = performance.now() - sample.start }))
    }, true)
  })

  const target = editor.locator('p').filter({ hasText: TYPING_TARGET }).first()
  await target.scrollIntoViewIfNeeded()
  await target.evaluate((paragraph) => {
    const content = paragraph.closest<HTMLElement>('.structured-editor-content')!
    content.focus()
    const range = document.createRange()
    range.selectNodeContents(paragraph)
    range.collapse(false)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })
  const samples: PaintSample[] = []
  for (const key of INSERTED) {
    const index = await page.evaluate(() => window.__dmTypingPerformance.samples.length)
    await page.keyboard.type(key)
    await page.waitForFunction((index) => window.__dmTypingPerformance.samples[index]?.paintMs !== undefined, index)
    samples.push(await page.evaluate((index) => window.__dmTypingPerformance.samples[index], index))
  }
  const warmup = samples.slice(0, WARMUP.length), measured = samples.slice(WARMUP.length)
  const p95PaintMs = percentile95(measured.map((sample) => sample.paintMs!))
  const citationChanges = await page.evaluate(() => window.__dmTypingPerformance.citationChanges)
  await testInfo.attach('typing-latency.json', {
    body: JSON.stringify({ sourceBytes: Buffer.byteLength(source), records: records.length, libraryBytes: Buffer.byteLength(JSON.stringify(records)), citedRecords, warmup, measured, p95PaintMs, budgetMs: PAINT_BUDGET_MS, citationChanges }, null, 2),
    contentType: 'application/json',
  })
  expect(citationChanges, 'ordinary prose must not clear CSL labels or replace them with fallback text').toEqual([])
  expect(await citations.allTextContents()).toEqual(initialLabels)
  expect(await entries.allTextContents()).toEqual(initialBibliography)
  expect(p95PaintMs, 'real keydown to two animation frames exceeds the conservative 500 ms budget').toBeLessThan(PAINT_BUDGET_MS)

  const storedSource = () => page.evaluate((key) => localStorage.getItem(key) ?? '', SOURCE_KEY)
  await expect.poll(storedSource).toContain(TYPING_TARGET + INSERTED)
  const saved = await storedSource()
  await showWritingTools(page)
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect.poll(storedSource).not.toBe(saved)
  await showWritingTools(page)
  await page.getByRole('button', { name: 'Redo', exact: true }).click()
  await expect.poll(storedSource).toBe(saved)
  expect(await citations.allTextContents()).toEqual(initialLabels)

  const libraryBeforeReload = await page.evaluate((key) => localStorage.getItem(key), CITATIONS_KEY)
  expect(JSON.parse(libraryBeforeReload!).filter((record: CitationRecord) => /^typing\d{4}$/.test(record.citekey))).toHaveLength(RECORD_COUNT)
  await page.reload()
  await expect(entries).toHaveCount(citedRecords, { timeout: 30_000 })
  await expect.poll(storedSource).toBe(saved)
  await expect(target).toContainText(TYPING_TARGET + INSERTED)
  expect(await citations.allTextContents()).toEqual(initialLabels)
  expect(await entries.allTextContents()).toEqual(initialBibliography)
  expect(await page.evaluate((key) => localStorage.getItem(key), CITATIONS_KEY)).toBe(libraryBeforeReload)
})
