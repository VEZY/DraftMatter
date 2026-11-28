import { setTrackChanges } from './writing-tools'
import { expect, test, type Page } from '@playwright/test'
import { createReviewChange, createReviewThread, decideReviewChange } from '../../src/reviewOperations'
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

async function savedChanges(page: Page) {
  const source = await page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')
  const document = parseReviewMarkup(source)
  return document.changes.map(({ id }) => id).sort()
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
  const acceptBounds = await accept.boundingBox()
  const rejectBounds = await reject.boundingBox()
  await expect(accept).toHaveAttribute('data-tooltip', acceptName)
  await expect(reject).toHaveAttribute('data-tooltip', rejectName)
  await expect(results).not.toBeInViewport()
  await accept.click()
  await expect.poll(() => savedChanges(page)).toEqual(['dm-change-loss', 'dm-change-season'])
  await expect(page.locator('.ProseMirror p').filter({ hasText: 'The trial began' })).toHaveText('The trial began in March.')
  await expect(results).toBeInViewport()
  await expect(accept).toBeInViewport()
  expect(await accept.boundingBox()).toEqual(acceptBounds)
  expect(await reject.boundingBox()).toEqual(rejectBounds)
  const card = page.locator('[data-review-balloon="dm-change-loss"]')
  await expect(card.getByRole('checkbox')).toHaveCount(0)
  await expect(card).not.toContainText('dm-anchor-')
  await expect(card.getByRole('button', { name: 'Reject', exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('review-next-change.png') })
  await toolbar.locator('.topbar-completion-actions').screenshot({ path: testInfo.outputPath('review-next-change-toolbar.png') })
  await accept.click()
  await expect.poll(() => savedChanges(page)).toEqual(['dm-change-season'])
  await expect(results).toHaveText('Water loss decreased under shade.')
  await expect(discussion).toBeInViewport()
  await reject.press('Enter')
  await expect.poll(() => savedChanges(page)).toEqual([])
  await expect(discussion).toHaveText('The measurements support a seasonal effect.')
  await expect(accept).toBeHidden()
  await expect(reject).toBeHidden()
  await expect(toolbar.getByRole('button', { name: 'Review options' })).toBeFocused()
  const source = await page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')
  expect(parseReviewMarkup(source).threads).toMatchObject([{ id: 'dm-thread-sites', status: 'open' }])
  await setTrackChanges(page)
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
    const trigger = page.getByRole('button', { name: 'Review options', exact: true })
    await expect(trigger.locator('.review-trigger-label')).toBeHidden()
    await trigger.click()
    await expect(options).toBeInViewport({ ratio: 1 })
    await options.getByLabel('Filter changes and comments by author').selectOption(authorId)
    await options.getByRole('button', { name: 'Close review options' }).click()
  }
  await filter(alice.id)
  const reject = page.getByRole('button', { name: rejectName, exact: true })
  await reject.click()
  await reject.click()
  await expect.poll(() => savedChanges(page)).toEqual(['dm-change-loss'])
  const accept = page.getByRole('button', { name: acceptName, exact: true })
  await expect(accept).toBeHidden()
  await expect(reject).toBeHidden()
  await page.getByRole('button', { name: 'Review options', exact: true }).click()
  await expect(options.getByRole('combobox')).toHaveValue(alice.id)
  await expect(options.locator('option:checked')).toHaveText(alice.name)
  await options.getByRole('combobox').selectOption('all')
  await options.getByRole('button', { name: 'Close review options' }).click()
  await expect(accept).toBeVisible()
  await expect(reject).toBeVisible()
  await accept.click()
  await expect.poll(() => savedChanges(page)).toEqual([])
})

test('undo and redo restore the exact proposals in order across the toolbar, margin and manuscript', async ({ page }) => {
  const dateCard = page.locator('[data-review-balloon="dm-change-date"]')
  const lossCard = page.locator('[data-review-balloon="dm-change-loss"]')
  const date = page.locator('.ProseMirror p').filter({ hasText: 'The trial began' })
  const loss = page.locator('.ProseMirror p').filter({ hasText: 'Water loss' })
  await page.getByRole('button', { name: acceptName }).click()
  await expect(date).toHaveText('The trial began in March.')
  await expect(dateCard).toHaveCount(0)
  await lossCard.getByRole('button', { name: 'Reject', exact: true }).click()
  await expect(lossCard).toHaveCount(0)
  await expect(loss).toHaveText('Water loss increased under shade.')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(lossCard).toContainText('decreased')
  await expect(dateCard).toHaveCount(0)
  await page.getByRole('button', { name: 'Review options', exact: true }).click()
  const options = page.getByRole('dialog', { name: 'Review options' })
  await options.getByRole('button', { name: 'Original text' }).click()
  await expect(page.getByRole('textbox', { name: 'Rendered manuscript editor' })).toHaveAttribute('contenteditable', 'false')
  await options.getByRole('button', { name: 'In text', exact: true }).click()
  await options.getByRole('button', { name: 'Close review options' }).click()
  await page.getByRole('textbox', { name: 'Rendered manuscript editor' }).focus()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(dateCard).toContainText('March')
  await expect(date).toContainText('February')
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(date).toHaveText('The trial began in March.')
  await expect(dateCard).toHaveCount(0)
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y')
  await expect(lossCard).toHaveCount(0)
  await expect.poll(() => savedChanges(page)).toEqual(['dm-change-season'])
  await page.reload()
  await expect(date).toHaveText('The trial began in March.')
  await expect(loss).toHaveText('Water loss increased under shade.')
  await expect(lossCard).toHaveCount(0)
  await expect(dateCard).toHaveCount(0)
  await expect(page.getByText('Add the site coordinates.', { exact: true })).toBeVisible()
})

test('opening a manuscript saved by an earlier alpha folds only its decided suggestions into the paper', async ({ page }) => {
  let old = parseReviewMarkup(manuscript())
  old = decideReviewChange(old, { changeId: 'dm-change-date', action: 'accepted', authorId: alice.id }).document
  old = decideReviewChange(old, { changeId: 'dm-change-loss', action: 'rejected', authorId: alice.id }).document
  await page.evaluate((source) => localStorage.setItem('draftmatter.structured-source.v1', source), old.source)
  await page.reload()
  await expect(page.locator('.ProseMirror p').filter({ hasText: 'The trial began' })).toHaveText('The trial began in March.')
  await expect(page.locator('.ProseMirror p').filter({ hasText: 'Water loss' })).toHaveText('Water loss increased under shade.')
  await expect(page.locator('[data-review-balloon="dm-change-date"], [data-review-balloon="dm-change-loss"]')).toHaveCount(0)
  await expect(page.locator('[data-review-balloon="dm-change-season"]')).toBeVisible()
  await expect(page.locator('[data-review-balloon="dm-thread-sites"]')).toBeVisible()
})

test('an ordinary edit after accepting is undone first and a new edit clears redo', async ({ page }) => {
  const date = page.locator('.ProseMirror p').filter({ hasText: 'The trial began' })
  const card = page.locator('[data-review-balloon="dm-change-date"]')
  await page.getByRole('button', { name: acceptName }).click()
  await expect(date).toHaveText('The trial began in March.')
  await selectRenderedTextWithMouse(page, date, 'March')
  await page.keyboard.type('April')
  await expect(date).toHaveText('The trial began in April.')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(date).toHaveText('The trial began in March.')
  await expect(card).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+z')
  await expect(card).toBeVisible()
  const discussion = page.locator('.ProseMirror p').filter({ hasText: 'support a seasonal' })
  await selectRenderedTextWithMouse(page, discussion, 'effect.')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.type(' Further observations.')
  await expect(discussion).toContainText('Further observations.')
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(card).toBeVisible()
  await expect(discussion).toContainText('Further observations.')
})
