import { showWritingTools } from './writing-tools'
import { selectRenderedTextWithMouse } from './rendered-selection'
import { expect, test } from '@playwright/test'

const source = `# Suggestion capture

Replace this sentence.

Paste over this sentence.

Delete this sentence.

Insert after this sentence.

We recorded publication object.

Format this phrase.

Promote this paragraph.
`

async function reviewChangeCount(page: import('@playwright/test').Page) {
  return page.evaluate(() => (localStorage.getItem('draftmatter.structured-source.v1')?.match(/\.dm-change\b/g) ?? []).length)
}

async function waitForChangeCount(page: import('@playwright/test').Page, count: number) {
  await expect.poll(() => reviewChangeCount(page)).toBe(count)
}

test.describe('DM-P4-02 rendered suggestion transactions', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((portableSource) => {
      localStorage.setItem('draftmatter.structured-source.v1', portableSource)
      localStorage.setItem('draftmatter.structured-mode.v1', 'true')
    }, source)
    await page.goto('/draft')
    await page.getByRole('button', { name: 'Turn on track changes' }).click()
    await expect(page.getByRole('button', { name: 'Turn off track changes' })).toHaveAttribute('aria-pressed', 'true')
  })

  test('groups typing, paste, deletion, and insertion without changing accepted prose', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const manuscript = page.getByRole('article', { name: 'Editable manuscript' })

    await manuscript.getByText('Replace this sentence.', { exact: true }).selectText()
    await page.keyboard.type('A carefully replaced sentence.')
    await waitForChangeCount(page, 1)

    await manuscript.getByText('Paste over this sentence.', { exact: true }).selectText()
    await page.evaluate(() => navigator.clipboard.writeText('A pasted replacement sentence.'))
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V')
    await waitForChangeCount(page, 2)

    await manuscript.getByText('Delete this sentence.', { exact: true }).selectText()
    await page.keyboard.press('Backspace')
    await waitForChangeCount(page, 3)

    await manuscript.getByText('Insert after this sentence.', { exact: true }).click()
    await page.keyboard.press('End')
    await page.keyboard.type(' Added detail.')
    await waitForChangeCount(page, 4)

    const portable = await page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')
    expect(portable.match(/data-kind="replace"/g)).toHaveLength(2)
    expect(portable.match(/data-kind="delete"/g)).toHaveLength(1)
    expect(portable.match(/data-kind="insert"/g)).toHaveLength(1)
    expect(portable).toContain('A carefully replaced')
    expect(portable).toContain('A pasted replacement')
    expect(portable).toContain('Added detail.')

    await expect(manuscript.locator('.dm-review-change').filter({ hasText: 'Replace this' })).toBeVisible()
    await expect(manuscript.locator('.dm-review-change').filter({ hasText: 'Paste over this' })).toBeVisible()
    await expect(manuscript.locator('.dm-review-change').filter({ hasText: 'Delete this sentence.' })).toBeVisible()
    await expect(manuscript.locator('.structured-editor-content p').filter({ hasText: 'Insert after this sentence.' })).toContainText('Insert after this sentence.')
    await expect(page.getByRole('complementary', { name: 'Manuscript comments' }).getByText('A carefully replaced')).toBeVisible()
  })

  test('marks a suffix on its first painted frame and shows only the added letter in the margin', async ({ page }, testInfo) => {
    const passage = page.locator('.ProseMirror p').filter({ hasText: 'recorded publication object' })
    await selectRenderedTextWithMouse(page, passage, 'object')
    await page.keyboard.press('ArrowRight')
    await passage.evaluate(() => {
      document.addEventListener('beforeinput', () => {
        requestAnimationFrame(() => {
          const mark = document.querySelector('.ProseMirror .dm-review-insertion')
          const text = mark?.querySelector('textarea')?.value ?? mark?.textContent
          document.body.dataset.suffixAtFirstPaint = mark ? `${text}:${getComputedStyle(mark).textDecorationLine}` : 'unmarked'
        })
      }, { once: true, capture: true })
    })
    await page.keyboard.type('s')
    await expect(page.locator('body')).toHaveAttribute('data-suffix-at-first-paint', 's:underline')

    const note = page.locator('.review-margin [data-review-balloon]')
    await expect(note.locator('ins')).toHaveText('s')
    await expect(note.locator('del')).toHaveCount(0)
    await expect(note).not.toContainText('Point review')
    await expect(passage.locator('.dm-review-point')).toHaveCount(0)
    const marked = passage.locator('.dm-review-proposal.dm-review-insertion')
    await expect(marked).toBeVisible()
    expect(await marked.evaluate((element) => getComputedStyle(element, '::before').content)).toBe('none')

    const line = await passage.boundingBox()
    const card = await note.boundingBox()
    if (line && card) {
      const x = Math.floor(Math.min(line.x, card.x)) - 8
      const y = Math.floor(Math.min(line.y, card.y)) - 8
      await page.screenshot({ path: testInfo.outputPath('tracked-suffix.png'), clip: {
        x, y, width: Math.ceil(Math.max(line.x + line.width, card.x + card.width)) - x + 8,
        height: Math.ceil(Math.max(line.y + line.height, card.y + card.height)) - y + 8,
      } })
    }
    await page.getByRole('button', { name: 'Accept and go to next change' }).click()
    await expect(passage).toHaveText('We recorded publication objects.')
    await expect(note).toHaveCount(0)
  })

  test('continues typing in the same suggestion after a pause, with undo and redo', async ({ page }) => {
    const passage = page.locator('.ProseMirror p').filter({ hasText: 'recorded publication object' })
    await selectRenderedTextWithMouse(page, passage, 'object')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.type('s')
    const wording = passage.getByRole('textbox', { name: 'Edit suggested wording' })
    await expect(wording).toBeFocused()
    const originalId = await wording.getAttribute('data-proposal-id')
    await page.keyboard.type('!')
    const note = page.locator('.review-margin [data-review-balloon]')
    await expect(note.locator('ins')).toHaveText('s!')
    await expect(wording).toHaveAttribute('data-proposal-id', originalId!)
    await page.keyboard.press('ControlOrMeta+z')
    await expect(note.locator('ins')).toHaveText('s')
    await page.keyboard.press('ControlOrMeta+Shift+z')
    await expect(note.locator('ins')).toHaveText('s!')
    await page.getByRole('button', { name: 'Accept and go to next change' }).click()
    await expect(passage).toHaveText('We recorded publication objects!.')
  })

  test('reenters and formats an insertion, then comments on its selected words', async ({ page }) => {
    const passage = page.locator('.structured-editor-content > p').filter({ hasText: 'recorded publication object' })
    await selectRenderedTextWithMouse(page, passage, 'object')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.type('dhte')
    const wording = passage.getByRole('textbox', { name: 'Edit suggested wording' })
    await expect(wording).toBeFocused()
    const id = await wording.getAttribute('data-proposal-id')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('Backspace')
    await page.keyboard.type('a')
    await expect(wording).toHaveText('date')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('textbox', { name: 'Rendered manuscript editor' })).toBeFocused()
    await page.keyboard.press('ArrowLeft')
    if (!await wording.evaluate(element => element === document.activeElement)) await page.keyboard.press('ArrowLeft')
    await expect(wording).toBeFocused()

    await page.getByText('Promote this paragraph.', { exact: true }).click()
    await wording.click()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.press('ControlOrMeta+b')
    await expect(wording.locator('strong')).toHaveText('date')
    await showWritingTools(page)
    await page.getByRole('button', { name: 'Italic', exact: true }).click()
    await expect(wording.locator('em')).toHaveText('date')
    await expect(wording).toHaveAttribute('data-proposal-id', id!)
    await waitForChangeCount(page, 1)

    // Formatting leaves the entire word selected. Dragging from inside that
    // selection may move the text instead of starting a new selection.
    await wording.press('ArrowLeft')
    await selectRenderedTextWithMouse(page, wording, 'at')
    await page.getByRole('button', { name: 'Add comment to selection' }).click()
    const comment = page.getByRole('textbox', { name: 'Comment', exact: true })
    await comment.fill('Please check these letters.')
    await comment.press('ControlOrMeta+Enter')
    const balloon = page.locator('[data-review-balloon]').filter({ hasText: 'Please check these letters.' })
    await expect(balloon).toBeVisible()
    await balloon.getByText('Please check these letters.').click()
    const blue = wording.locator('.dm-review-proposal-comment.dm-review-active')
    await expect(blue).toHaveText('at')
    const savedSource = () => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')
    await expect.poll(savedSource).toContain('***date***')
    await expect.poll(savedSource).toContain('dm-proposal-target')
    await page.getByRole('button', { name: 'Accept and go to next change' }).click()
    await expect(passage.locator('strong em, em strong')).toHaveText('date')
    await expect(balloon).toBeVisible()
  })

  test('highlights a tracked insertion inside an ordinary comment range', async ({ page }) => {
    const passage = page.locator('.structured-editor-content > p').filter({ hasText: 'We recorded' })
    await selectRenderedTextWithMouse(page, passage, 'publication object')
    await page.getByRole('button', { name: 'Add comment to selection' }).click()
    const comment = page.getByRole('textbox', { name: 'Comment', exact: true })
    await comment.fill('Check the publication terminology.')
    await comment.press('ControlOrMeta+Enter')
    const note = page.locator('[data-review-balloon]').filter({ hasText: 'Check the publication terminology.' })
    await expect(note).toBeVisible()
    await selectRenderedTextWithMouse(page, passage, 'publication')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.type('s')
    await expect(passage.locator('.dm-review-proposal.dm-review-insertion')).toHaveText('s')
    await note.getByText('Check the publication terminology.').click()
    await expect(passage.locator('.dm-review-insertion.dm-review-proposal-comment.dm-review-active')).toHaveText('s')
  })

  test('captures toolbar formatting and block structure without changing accepted prose', async ({ page }) => {
    const manuscript = page.getByRole('article', { name: 'Editable manuscript' })

    await manuscript.getByText('Format this phrase.', { exact: true }).selectText()
    await showWritingTools(page)
    await page.getByRole('button', { name: 'Bold' }).click()
    await waitForChangeCount(page, 1)

    await manuscript.getByText('Promote this paragraph.', { exact: true }).selectText()
    await showWritingTools(page)
    await page.getByLabel('Block style').selectOption('heading-2')
    await waitForChangeCount(page, 2)

    const portable = await page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')
    expect(portable).toContain('data-kind="format"')
    expect(portable).toContain('data-kind="structural"')
    expect(portable).toContain('**Format this phrase.**')
    expect(portable).toContain('## Promote this paragraph.')
    const acceptedFormat = manuscript.locator('.dm-review-change').filter({ hasText: 'Format this phrase.' })
    await expect(acceptedFormat).toBeVisible()
    await expect(acceptedFormat).not.toHaveCSS('font-weight', '700')
    await expect(manuscript.locator('.dm-review-change').filter({ hasText: 'Promote this paragraph.' })).not.toHaveRole('heading')
  })
})
