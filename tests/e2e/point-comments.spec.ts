import { expect, test } from '@playwright/test'

const source = `# Point comments

Measure canopy area weekly.
`

test.describe('DM-P4-01 rendered point comments', () => {
  test('anchors a zero-width comment without changing accepted prose and reopens it', async ({ page }) => {
    await page.addInitScript((portableSource) => {
      if (!localStorage.getItem('draftmatter.structured-mode.v1')) {
        localStorage.setItem('draftmatter.structured-source.v1', portableSource)
        localStorage.setItem('draftmatter.structured-mode.v1', 'true')
      }
    }, source)
    await page.goto('/draft')

    const manuscript = page.getByRole('article', { name: 'Editable manuscript' })
    await page.locator('.topbar').getByRole('button', { name: /^Review,/ }).click()
    const review = page.getByRole('complementary', { name: 'Review feedback' })
    await manuscript.getByText('Measure canopy area weekly.', { exact: true }).evaluate((element) => {
      const editor = element.closest<HTMLElement>('[contenteditable="true"]')
      const selection = window.getSelection()
      const text = element.firstChild
      if (!editor || !selection || !text) throw new Error('Rendered point-comment selection is unavailable')
      const start = text.textContent?.indexOf('canopy area') ?? -1
      if (start < 0) throw new Error('Nearby point-comment text is unavailable')
      editor.focus()
      const range = document.createRange()
      range.setStart(text, start)
      range.setEnd(text, start + 'canopy area'.length)
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    })

    await review.getByRole('button', { name: 'New comment' }).click()
    const composer = review.getByRole('group', { name: 'New comment' })
    await composer.getByLabel('Attach to').selectOption('point-after')
    await expect(composer.getByLabel('Exact nearby manuscript text')).toHaveValue('canopy area')
    await composer.getByLabel('Comment').fill('Add the sampling date here.')
    await composer.getByRole('button', { name: 'Add' }).click()

    const acceptedProse = async () => manuscript.locator('.structured-editor-content p').evaluate((paragraph) =>
      [...paragraph.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join(''),
    )
    await expect.poll(acceptedProse).toBe('Measure canopy area weekly.')
    await expect(review.getByText('Add the sampling date here.', { exact: true })).toBeVisible()
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')).toMatch(/canopy area\[\]\{#dm-[^}]+data-edge="point"[^}]*\} weekly/)

    const portable = await page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')
    expect(portable.match(/data-edge="point"/g)).toHaveLength(1)
    expect(portable).not.toContain('data-edge="end"')

    await page.reload()
    await expect.poll(acceptedProse).toBe('Measure canopy area weekly.')
    await page.locator('.topbar').getByRole('button', { name: /^Review,/ }).click()
    await expect(page.getByRole('complementary', { name: 'Review feedback' }).getByText('Add the sampling date here.', { exact: true })).toBeVisible()
  })
})
