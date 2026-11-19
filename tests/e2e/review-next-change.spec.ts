import { expect, test, type Page } from '@playwright/test'
import { createReviewChange, createReviewThread } from '../../src/reviewOperations'
import { parseReviewMarkup } from '../../src/reviewMarkup'
import { selectRenderedTextWithMouse } from './rendered-selection'

const alice = { id: 'dm-alice', name: 'Alice Martin' }
const marcus = { id: 'dm-marcus', name: 'Marcus Chen' }
const sections = (start: number) => Array.from({ length: 8 }, (_, i) =>
  `## Site ${start + i}\n\nWe measured canopy cover and soil moisture throughout the dry season.`)

function manuscript() {
  let source = [
    '# Water in the canopy', 'The trial began in February.', ...sections(1),
    'We monitored both sites through spring.', '## Results', 'Water loss increased under shade.',
    ...sections(9), '## Discussion', 'The measurements support a seasonal effect.',
  ].join('\n\n') + '\n'
  // Create the records out of order. Review should follow their passages in the paper.
  for (const [id, quote, proposal, author] of [
    ['season', 'seasonal', 'seasonal canopy', alice],
    ['date', 'February', 'March', alice],
    ['loss', 'increased', 'decreased', marcus],
  ] as const) {
    const start = source.indexOf(quote)
    source = createReviewChange(source, {
      changeId: `dm-change-${id}`, anchorId: `dm-anchor-${id}`, kind: 'replace',
      start, end: start + quote.length, proposal, author,
    }).document.source
  }
  const quote = 'both sites'
  const start = source.indexOf(quote)
  return createReviewThread(source, {
    start, end: start + quote.length, threadId: 'dm-thread-sites', author: marcus, message: 'Add the site coordinates.',
  }).document.source
}

const acceptName = 'Accept and go to next change'
const rejectName = 'Reject and go to next change'

async function decisions(page: Page) {
  const source = await page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')
  const document = parseReviewMarkup(source)
  return document.decisions.map(({ changeId, action }) => [changeId, action])
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript((source) => {
    if (!localStorage.getItem('draftmatter.structured-mode.v1')) {
      localStorage.setItem('draftmatter.structured-source.v1', source)
      localStorage.setItem('draftmatter.structured-mode.v1', 'true')
    }
  }, manuscript())
  await page.goto('/draft')
})

test('decides each suggestion from the top bar in manuscript order and scrolls to the next passage', async ({ page }, testInfo) => {
  const toolbar = page.locator('.topbar')
  const accept = toolbar.getByRole('button', { name: acceptName, exact: true })
  const reject = toolbar.getByRole('button', { name: rejectName, exact: true })
  const results = page.locator('.ProseMirror p').filter({ hasText: 'Water loss' })
  const discussion = page.locator('.ProseMirror p').filter({ hasText: 'The measurements support' })
  await expect(results).not.toBeInViewport()
  await accept.click()
  await expect.poll(() => decisions(page)).toEqual([['dm-change-date', 'accepted']])
  await expect(results).toBeInViewport()
  await expect(accept).toBeInViewport()
  const card = page.locator('[data-review-balloon="dm-change-loss"]')
  await expect(card.getByRole('checkbox')).toHaveCount(0)
  await expect(card).not.toContainText('dm-anchor-')
  await expect(card.getByRole('button', { name: 'Reject', exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('review-next-change.png') })
  await toolbar.locator('.topbar-completion-actions').screenshot({ path: testInfo.outputPath('review-next-change-toolbar.png') })
  await accept.click()
  await expect.poll(() => decisions(page)).toHaveLength(2)
  await expect(discussion).toBeInViewport()
  await reject.click()
  await expect.poll(() => decisions(page)).toEqual([
    ['dm-change-date', 'accepted'], ['dm-change-loss', 'accepted'], ['dm-change-season', 'rejected'],
  ])
  await expect(accept).toBeHidden()
  await expect(reject).toBeHidden()
  const source = await page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')
  expect(parseReviewMarkup(source).threads).toMatchObject([{ id: 'dm-thread-sites', status: 'open' }])
  await page.getByRole('button', { name: 'Turn on track changes' }).click()
  await selectRenderedTextWithMouse(page, discussion, 'measurements')
  await page.keyboard.type('observations')
  await expect(accept).toBeVisible()
  await expect(reject).toBeVisible()
})

test('reviewing one author leaves the other author’s suggestions pending', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('button', { name: acceptName })).toBeInViewport({ ratio: 1 })
  await expect(page.getByRole('button', { name: rejectName })).toBeInViewport({ ratio: 1 })
  expect(await page.locator('.topbar').evaluate((header) => header.scrollWidth)).toBeLessThanOrEqual(390)
  const options = page.getByRole('dialog', { name: 'Review options', exact: true })
  async function filter(authorId: string) {
    await page.getByRole('button', { name: 'Review options', exact: true }).click()
    await options.getByLabel('Review author').selectOption(authorId)
    await options.getByRole('button', { name: 'Close review options' }).click()
  }
  await filter(alice.id)
  const reject = page.getByRole('button', { name: rejectName, exact: true })
  await reject.click()
  await reject.click()
  await expect.poll(() => decisions(page)).toEqual([
    ['dm-change-date', 'rejected'], ['dm-change-season', 'rejected'],
  ])
  const accept = page.getByRole('button', { name: acceptName, exact: true })
  await expect(accept).toBeHidden()
  await expect(reject).toBeHidden()
  await filter('all')
  await expect(accept).toBeVisible()
  await expect(reject).toBeVisible()
  await accept.click()
  await expect.poll(() => decisions(page)).toEqual([
    ['dm-change-date', 'rejected'], ['dm-change-season', 'rejected'], ['dm-change-loss', 'accepted'],
  ])
})
