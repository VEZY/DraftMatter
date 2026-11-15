import { expect, test } from '@playwright/test'
import { selectRenderedTextWithMouse } from './rendered-selection'

test('opens a focused single-field comment from the manuscript context menu', async ({ page }) => {
  const source = '# Context comments\n\nAttach the review directly to this sentence.\n'
  await page.addInitScript((portableSource) => {
    localStorage.setItem('draftmatter.structured-source.v1', portableSource)
    localStorage.setItem('draftmatter.structured-mode.v1', 'true')
  }, source)
  await page.goto('/draft')

  await page.getByText('Attach the review directly to this sentence.', { exact: true }).click({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'Review selection' })
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', { name: /Add comment/ }).click()

  const composer = page.getByRole('group', { name: 'New comment' })
  await expect(composer).toBeVisible()
  await expect(composer.locator('input, select, blockquote, .comment-quote')).toHaveCount(0)
  await expect(composer.locator('textarea')).toHaveCount(1)
  await expect(composer.locator('textarea')).toBeFocused()
  await expect(composer.getByText('New comment', { exact: true })).toHaveCount(0)
  await expect(composer.getByText('Comment', { exact: true })).toHaveCount(0)
  await composer.getByLabel('Comment', { exact: true }).fill('Explain which result supports this sentence.')
  await composer.getByRole('button', { name: 'Add comment', exact: true }).click()
  const comment = page.locator('.portable-comment-bubble').filter({ hasText: 'Explain which result supports this sentence.' })
  await expect(comment).toBeVisible()
  await expect(comment.locator('.comment-quote')).toHaveCount(0)
  await expect(page.getByRole('article', { name: 'Editable manuscript' }).locator('.dm-review-thread')).toHaveText('Attach the review directly to this sentence.')
})

test('opens a focused comment for a retained figure without quoting the figure in the composer', async ({ page }) => {
  const source = `# Figure comments

<!-- dm-output:start cell="cell-growth" run="sha256:one" -->
![Growth response over time](/fixtures/canopy-response.svg){#fig-growth}
<!-- dm-output:end -->
`
  await page.addInitScript((portableSource) => {
    localStorage.setItem('draftmatter.structured-source.v1', portableSource)
    localStorage.setItem('draftmatter.structured-mode.v1', 'true')
  }, source)
  await page.goto('/draft')

  await page.getByRole('img', { name: 'Growth response over time' }).click({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'Review selection' })
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', { name: /Add comment/ }).click()

  const composer = page.getByRole('group', { name: 'New comment' })
  await expect(composer.locator('input, select, blockquote, .comment-quote')).toHaveCount(0)
  await expect(composer.locator('textarea')).toHaveCount(1)
  await expect(composer.locator('textarea')).toBeFocused()
})

test('comments on the exact mouse-selected occurrence and preserves its anchor and replies after scrolling and reload', async ({ page }) => {
  const repeated = 'The measured response matched the measured response.'
  const quote = 'measured response'
  const source = `# Selection comments\n\n${Array.from({ length: 12 }, (_, index) => `Background paragraph ${index + 1} keeps this research manuscript scrollable.`).join('\n\n')}\n\n${repeated}\n\n${Array.from({ length: 16 }, (_, index) => `Follow-up paragraph ${index + 1} preserves space below the reviewed result.`).join('\n\n')}\n`
  await page.addInitScript((portableSource) => {
    if (!localStorage.getItem('draftmatter.structured-source.v1')) {
      localStorage.setItem('draftmatter.structured-source.v1', portableSource)
      localStorage.setItem('draftmatter.structured-mode.v1', 'true')
    }
  }, source)
  await page.goto('/draft')

  const manuscript = page.getByRole('article', { name: 'Editable manuscript' })
  const paragraph = manuscript.getByText(repeated, { exact: true })
  await selectRenderedTextWithMouse(page, paragraph, quote, 1)
  const addComment = page.getByRole('button', { name: 'Add comment to selection', exact: true })
  await expect(addComment).toBeVisible()
  await addComment.click()

  const composer = page.getByRole('group', { name: 'New comment' })
  await expect(composer.locator('textarea')).toBeFocused()
  await expect(composer.locator('input, select, blockquote, .comment-quote')).toHaveCount(0)
  await composer.getByLabel('Comment', { exact: true }).fill('Check this second measurement.')
  await composer.getByRole('button', { name: 'Add comment', exact: true }).click()
  const createdComment = page.locator('.portable-comment-bubble').filter({ hasText: 'Check this second measurement.' })
  await expect(createdComment).toBeVisible()
  const commentId = await createdComment.getAttribute('id')
  expect(commentId).toBeTruthy()
  const comment = page.locator(`#${commentId}`)
  await expect(comment.locator('time').first()).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/)
  await expect(comment.locator('.comment-quote')).toHaveCount(0)
  await expect(manuscript.locator('.dm-review-thread')).toHaveText(quote)
  const savedSource = () => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')
  await expect.poll(savedSource).toContain('Check this second measurement.')
  const portable = await savedSource()
  const selectedOffset = source.indexOf(quote, source.indexOf(quote) + quote.length)
  expect(portable.slice(0, portable.indexOf('[]{'))).toBe(source.slice(0, selectedOffset))

  await comment.getByRole('button', { name: 'Reply', exact: true }).click()
  await expect(comment.getByRole('button', { name: 'Reply', exact: true })).toHaveCount(0)
  await comment.getByRole('textbox', { name: /^Reply to / }).fill('The second measurement is independently confirmed.')
  await comment.getByRole('button', { name: 'Send reply', exact: true }).click()
  await expect(comment).toContainText('The second measurement is independently confirmed.')
  await expect(comment.getByRole('button', { name: 'Reply', exact: true })).toBeVisible()
  await comment.getByRole('button', { name: /^Collapse comment by / }).click()
  await expect(comment.getByRole('button', { name: /^Expand comment by / })).toHaveAttribute('aria-expanded', 'false')
  await expect(comment.getByText('The second measurement is independently confirmed.', { exact: true })).toBeHidden()
  await comment.getByRole('button', { name: /^Expand comment by / }).click()
  await expect(comment.getByText('The second measurement is independently confirmed.', { exact: true })).toBeVisible()

  const anchor = manuscript.locator('.dm-review-thread')
  await expect(comment).toHaveAttribute('data-review-balloon-aligned', 'true')
  try {
    await expect.poll(async () => {
      const mark = await anchor.boundingBox(), bubble = await comment.boundingBox()
      return mark && bubble ? Math.abs(mark.y - bubble.y) : Infinity
    }).toBeLessThanOrEqual(2)
  } catch (error) {
    const layout = await page.evaluate((id) => {
      const editor = document.querySelector<HTMLElement>('.editor-area')!
      const rail = document.querySelector<HTMLElement>('.review-margin .review-scroll')!
      const bubble = document.getElementById(id!)!
      const mark = document.querySelector<HTMLElement>('.editor-area .dm-review-thread')!
      return { editorScroll: editor.scrollTop, railScroll: rail.scrollTop, editor: editor.getBoundingClientRect().toJSON(), rail: rail.getBoundingClientRect().toJSON(), anchor: mark.getBoundingClientRect().toJSON(), bubble: bubble.getBoundingClientRect().toJSON(), transform: getComputedStyle(bubble).transform }
    }, commentId)
    await test.info().attach('comment-alignment', { body: JSON.stringify(layout, null, 2), contentType: 'application/json' })
    throw error
  }
  const anchorBox = await anchor.boundingBox(), commentBox = await comment.boundingBox()
  expect(anchorBox).not.toBeNull()
  expect(commentBox).not.toBeNull()
  expect(commentBox!.x).toBeGreaterThan(anchorBox!.x + anchorBox!.width)
  await page.locator('.editor-area').evaluate((element) => { element.scrollTop += 80 })
  await expect.poll(async () => {
    const mark = await anchor.boundingBox(), bubble = await comment.boundingBox()
    return mark && bubble ? Math.abs(mark.y - bubble.y) : Infinity
  }).toBeLessThanOrEqual(2)

  await page.reload()
  await manuscript.locator('.dm-review-thread').scrollIntoViewIfNeeded()
  await expect(comment).toContainText('The second measurement is independently confirmed.')
  await expect(manuscript.locator('.dm-review-thread')).toHaveText(quote)
  const reopened = await savedSource()
  expect(reopened.slice(0, reopened.indexOf('[]{'))).toBe(source.slice(0, selectedOffset))
})

test('opens a composer beside an earlier selection while an existing comment is anchored later in the paper', async ({ page }) => {
  const source = `# Composer placement

Comment on this earlier paragraph.

${Array.from({ length: 20 }, (_, index) => `Intermediate paragraph ${index + 1} separates the earlier selection from the existing comment.`).join('\n\n')}

The []{#dm-later-start .dm-anchor data-anchor="dm-later" data-edge="start"}later observation[]{#dm-later-end .dm-anchor data-anchor="dm-later" data-edge="end"} remains available.

::::: {.draftmatter-reviews .hidden data-schema="1"}
:::: {#dm-later-thread .dm-thread data-anchor="dm-later" data-author="dm-alice" data-status="open" data-created="2026-07-15T09:00:00.000Z"}
~~~{.dm-message}
Check the later observation.
~~~
::::
:::: {#dm-alice .dm-author data-name="Alice Martin"}
::::
:::::
`
  await page.addInitScript((portableSource) => {
    localStorage.setItem('draftmatter.structured-source.v1', portableSource)
    localStorage.setItem('draftmatter.structured-mode.v1', 'true')
  }, source)
  await page.goto('/draft')
  const manuscript = page.getByRole('article', { name: 'Editable manuscript' })
  await expect(page.locator('#review-item-dm-later-thread')).toHaveAttribute('data-review-balloon-aligned', 'true')
  await manuscript.getByText('Comment on this earlier paragraph.', { exact: true }).selectText()
  const selectionTop = await page.evaluate(() => window.getSelection()!.getRangeAt(0).getBoundingClientRect().top)
  await page.getByRole('button', { name: 'Add comment to selection', exact: true }).click()
  const composer = page.getByRole('group', { name: 'New comment' })
  await expect(composer.locator('textarea')).toBeFocused()
  await expect(composer).toHaveAttribute('data-review-balloon-aligned', 'true')
  await expect.poll(async () => Math.abs((await composer.boundingBox())!.y - selectionTop)).toBeLessThanOrEqual(2)
  expect((await composer.boundingBox())!.y).toBeLessThan((await page.locator('#review-item-dm-later-thread').boundingBox())!.y)
  await expect(composer.locator('input, select, blockquote, .comment-quote')).toHaveCount(0)
})

test('comments across bold and italic prose without rewriting its text or Markdown formatting', async ({ page }) => {
  const source = '# Formatted comments\n\nWe measured **canopy growth** under *water stress* in every trial.\n'
  const selected = 'canopy growth under water stress'
  await page.addInitScript((portableSource) => {
    if (!localStorage.getItem('draftmatter.structured-source.v1')) {
      localStorage.setItem('draftmatter.structured-source.v1', portableSource)
      localStorage.setItem('draftmatter.structured-mode.v1', 'true')
    }
  }, source)
  await page.goto('/draft')
  const manuscript = page.getByRole('article', { name: 'Editable manuscript' })
  const paragraph = manuscript.locator('.structured-editor-content p').filter({ hasText: 'We measured' })
  await selectRenderedTextWithMouse(page, paragraph, selected)
  await page.getByRole('button', { name: 'Add comment to selection', exact: true }).click()
  const composer = page.getByRole('group', { name: 'New comment' })
  await expect(composer.locator('input, select, blockquote, .comment-quote')).toHaveCount(0)
  await composer.getByLabel('Comment', { exact: true }).fill('Retain both treatments in this comparison.')
  await composer.getByRole('button', { name: 'Add comment', exact: true }).click()
  await expect(page.locator('.portable-comment-bubble')).toContainText('Retain both treatments in this comparison.')
  await expect(paragraph.locator('strong')).toHaveText('canopy growth')
  await expect(paragraph.locator('em')).toHaveText('water stress')
  expect((await paragraph.locator('.dm-review-thread').allTextContents()).join('')).toBe(selected)

  const savedSource = () => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')
  await expect.poll(savedSource).toContain('Retain both treatments in this comparison.')
  const portable = await savedSource()
  const reviewSection = portable.indexOf('::::: {.draftmatter-reviews')
  expect(reviewSection).toBeGreaterThan(0)
  const unannotated = portable.slice(0, reviewSection).replace(/\[\]\{[^}\n]*\.dm-anchor\b[^}\n]*\}/g, '')
  expect(unannotated.trimEnd()).toBe(source.trimEnd())

  await page.reload()
  await expect(page.locator('.portable-comment-bubble')).toContainText('Retain both treatments in this comparison.')
  await expect(paragraph.locator('strong')).toHaveText('canopy growth')
  await expect(paragraph.locator('em')).toHaveText('water stress')
  expect(await savedSource()).toBe(portable)
})

for (const shortcut of ['Control+Enter', 'Meta+Enter']) {
  test(`submits a nonempty comment with ${shortcut} while plain Enter inserts a newline`, async ({ page }) => {
    const source = '# Shortcut comments\n\nAssess this measurement.\n'
    await page.addInitScript((portableSource) => {
      localStorage.setItem('draftmatter.structured-source.v1', portableSource)
      localStorage.setItem('draftmatter.structured-mode.v1', 'true')
    }, source)
    await page.goto('/draft')
    const paragraph = page.getByRole('article', { name: 'Editable manuscript' }).getByText('Assess this measurement.', { exact: true })
    await selectRenderedTextWithMouse(page, paragraph, 'this measurement')
    await page.getByRole('button', { name: 'Add comment to selection', exact: true }).click()
    const composer = page.getByRole('group', { name: 'New comment' })
    const textarea = composer.getByRole('textbox', { name: 'Comment', exact: true })
    await expect(textarea).toHaveAttribute('placeholder', 'Write a comment…')
    await expect(composer.getByText('New comment', { exact: true })).toHaveCount(0)
    await expect(composer.getByText('Comment', { exact: true })).toHaveCount(0)

    await textarea.press(shortcut)
    await expect(composer).toBeVisible()
    await expect(page.locator('.portable-comment-bubble')).toHaveCount(0)
    await textarea.fill('First line')
    await textarea.press('Enter')
    await expect(textarea).toHaveValue('First line\n')
    await expect(composer).toBeVisible()
    await page.keyboard.type('Second line')
    await textarea.press(shortcut)
    await expect(composer).toHaveCount(0)
    await expect(page.locator('.portable-comment-body')).toHaveText('First line\nSecond line')
    await expect.poll(() => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')).toContain('First line\nSecond line')
  })
}
