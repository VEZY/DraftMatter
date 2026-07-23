import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

const fixtureRoot = new URL('../../src/fixtures/projects/alpha-article/', import.meta.url)
const source = await readFile(new URL('paper.qmd', fixtureRoot), 'utf8')
const figureFiles = new Map([
  ['python-canopy.svg', await readFile(new URL('figures/python-canopy.svg', fixtureRoot))],
  ['r-allocation.svg', await readFile(new URL('figures/r-allocation.svg', fixtureRoot))],
  ['julia-model.svg', await readFile(new URL('figures/julia-model.svg', fixtureRoot))],
])

const citations = [
  {
    citekey: 'vezy2024',
    type: 'article-journal',
    title: 'Portable evidence chains in multilingual plant phenotyping',
    authors: ['Remi Vezy', 'Ada Martin'],
    year: '2024',
    container: 'Journal of Synthetic Plant Methods',
    source: 'csl-json',
    availability: 'cached',
    provenance: { origin: 'project-file', locator: 'references.json' },
  },
  {
    citekey: 'chen2025',
    type: 'article-journal',
    title: 'Review-aware drought analysis in executable manuscripts',
    authors: ['Lin Chen', 'Marta Silva'],
    year: '2025',
    container: 'Methods and Evidence',
    source: 'csl-json',
    availability: 'cached',
    provenance: { origin: 'project-file', locator: 'references.json' },
  },
]

test.describe('DM-P7-05 article-sized rendered dogfood', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/figures/*.svg', async (route) => {
      const name = route.request().url().split('/').at(-1) ?? ''
      const body = figureFiles.get(name)
      if (!body) return route.abort()
      await route.fulfill({ body, contentType: 'image/svg+xml', status: 200 })
    })
    await page.addInitScript(({ portableSource, citationRecords }) => {
      Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined })
      Object.defineProperty(window, 'print', {
        configurable: true,
        value: () => {
          const state = window as Window & { __alphaPrintRequests?: number }
          state.__alphaPrintRequests = (state.__alphaPrintRequests ?? 0) + 1
        },
      })
      if (!localStorage.getItem('draftmatter.structured-source.v1')) {
        localStorage.setItem('draftmatter.structured-source.v1', portableSource)
        localStorage.setItem('draftmatter.structured-mode.v1', 'true')
        localStorage.setItem('draftmatter.citations.v1', JSON.stringify(citationRecords))
      }
    }, { portableSource: source, citationRecords: citations })
    await page.goto('/draft')
  })

  test('reviews, exports, closes, and reopens the representative project without exposing computation source', async ({ page }) => {
    test.setTimeout(60_000)
    const manuscript = page.getByRole('article', { name: 'Editable manuscript' })
    const renderedEditor = page.getByRole('textbox', { name: 'Rendered manuscript editor' })

    await expect(manuscript.getByRole('heading', { level: 1 })).toHaveText('A reproducible cross-language analysis of synthetic canopy drought responses')
    await expect(page.getByRole('button', { name: 'Manage manuscript authors, 3 listed' })).toBeVisible()
    await expect(manuscript.getByText(/Vezy.*2024.*Chen.*Silva.*2025/)).toBeVisible()
    await expect(manuscript.locator('.structured-cross-reference[data-reference-status="valid"]')).toHaveCount(7)
    await expect(manuscript.locator('.structured-output-image')).toHaveCount(3)
    await expect(manuscript.locator('.structured-output-table')).toHaveCount(3)
    await expect(manuscript.getByRole('img')).toHaveCount(3)
    await expect(manuscript.getByText(/Final canopy area was 18\.4 % lower under drought/)).toBeVisible()
    await expect(manuscript.getByText(/allocation contrast had p = 0\.032/)).toBeVisible()
    await expect(manuscript.locator('p').filter({ hasText: 'The result sentences above contain ordinary prose placeholders' })).toContainText(/of 0\.99/)
    await expect(manuscript.locator('.structured-code-cell')).toHaveCount(6)
    await expect(manuscript.locator('.structured-code-editor:not([hidden])')).toHaveCount(0)
    await expect(manuscript.getByRole('button', { name: /Move block .*source/ }).first()).not.toHaveAttribute('aria-label', /write_text|writeLines|println|Path\(/)
    await expect(renderedEditor.locator('.structured-code-editor').filter({ hasText: 'write_text' })).toBeHidden()
    await expect(renderedEditor.locator('.structured-code-editor').filter({ hasText: 'writeLines' })).toBeHidden()
    await expect(renderedEditor.getByText('@publish')).toHaveCount(0)

    await page.locator('.topbar').getByRole('button', { name: /^Review,/ }).click()
    const review = page.getByRole('complementary', { name: 'Review feedback' })
    await expect(review.getByText('drought treatment reduced canopy expansion by 18.4%', { exact: true })).toBeVisible()
    await expect(review.getByText('Please confirm that the ±3.0 cm² diagnostic threshold was fixed before the model check.', { exact: true })).toBeVisible()
    await review.getByRole('button', { name: 'Accept', exact: true }).click()
    await expect(page.getByText('Suggestion accepted')).toBeVisible()
    await manuscript.getByRole('button', { name: 'Open comment at this text' }).click()
    await review.getByRole('button', { name: 'Resolve thread', exact: true }).click()
    await expect(page.getByText('Comment thread resolved')).toBeVisible()
    await expect.poll(() => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? ''))
      .toContain('data-status="resolved"')

    const revised = await page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')
    expect(revised).toContain('drought treatment reduced canopy expansion by 18.4%')
    expect(revised).toContain('data-status="accepted"')
    expect(revised).toContain('data-status="resolved"')
    expect(revised).toContain('<!-- dm-output:start cell="cell-julia-table"')
    expect(revised).toContain('orcid: "0000-0002-1825-0097"')

    await page.getByRole('button', { name: 'Export' }).click()
    await page.getByRole('button', { name: /Web page/ }).click()
    await expect(page.getByText(/Publication export blocked/)).toBeVisible()
    await page.getByRole('button', { name: 'Export' }).click()
    await page.getByLabel('Require current computed values').uncheck()
    await page.getByRole('button', { name: /Web page/ }).click()
    const htmlDialog = page.getByRole('dialog', { name: 'Save clean HTML document' })
    const downloadEvent = page.waitForEvent('download')
    await htmlDialog.getByRole('button', { name: 'Choose location…' }).click()
    const download = await downloadEvent
    const htmlPath = await download.path()
    expect(htmlPath).not.toBeNull()
    const html = await readFile(htmlPath!, 'utf8')
    expect(html).toContain('<span class="author-name">Ada Researcher</span>')
    expect(html).toContain('ORCID 0000-0002-1825-0097')
    expect(html).toContain('<figure id="fig-python-canopy">')
    expect(html).toContain('<table id="tbl-julia-predictions">')
    expect(html).toContain('18.4 %')
    expect(html).toContain('drought treatment reduced canopy expansion by 18.4%')
    expect(html).not.toMatch(/cell-python|cell-r-|cell-julia|write_text|writeLines|@publish|\.dm-anchor|\.draftmatter-reviews|<script/)

    await page.getByRole('button', { name: 'Export' }).click()
    await page.getByRole('button', { name: /^PDF/ }).click()
    await expect(page.getByText('System print dialog opened · choose Save as PDF')).toBeVisible()
    expect(await page.evaluate(() => (window as Window & { __alphaPrintRequests?: number }).__alphaPrintRequests)).toBe(1)
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')))

    await page.reload()
    await expect(manuscript.getByText('The drought treatment reduced canopy expansion.', { exact: true })).toBeVisible()
    await expect(manuscript.locator('.structured-output-image')).toHaveCount(3)
    await expect(manuscript.locator('.structured-output-table')).toHaveCount(3)
    await expect(manuscript.locator('.structured-cross-reference[data-reference-status="valid"]')).toHaveCount(7)
    await page.locator('.topbar').getByRole('button', { name: /^Review,/ }).click()
    await expect(review.getByText('Accepted', { exact: true })).toBeVisible()
    await expect(review.locator('.comment-card.resolved')).toContainText('Please confirm that the ±3.0 cm² diagnostic threshold was fixed before the model check.')
    await review.getByText('More options', { exact: true }).click()
    await review.getByLabel('Review display and preview').selectOption('final')
    await expect(manuscript.getByText('The drought treatment reduced canopy expansion by 18.4%.', { exact: true })).toBeVisible()
  })
})
