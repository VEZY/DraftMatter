import { expect, test } from '@playwright/test'

const source = `# Review identity

Comment on this sentence.

Suggest on this sentence.
`

async function selectRenderedText(locator: import('@playwright/test').Locator, quote: string) {
  await locator.evaluate((element, selected) => {
    const editor = element.closest<HTMLElement>('[contenteditable="true"]')
    const selection = window.getSelection()
    const nodes: Text[] = []
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) nodes.push(walker.currentNode as Text)
    const complete = nodes.map((node) => node.data).join('')
    const start = complete.indexOf(selected)
    if (!editor || !selection || nodes.length === 0) throw new Error('Rendered review selection is unavailable')
    if (start < 0) throw new Error('Rendered review text is unavailable')
    const locate = (offset: number) => {
      let consumed = 0
      for (const node of nodes) {
        if (offset <= consumed + node.length) return { node, offset: offset - consumed }
        consumed += node.length
      }
      return { node: nodes.at(-1)!, offset: nodes.at(-1)!.length }
    }
    const from = locate(start)
    const to = locate(start + selected.length)
    editor.focus()
    const range = document.createRange()
    range.setStart(from.node, from.offset)
    range.setEnd(to.node, to.offset)
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  }, quote)
}

test.describe('local review identity settings', () => {
  test('persists one author identity across comments, suggestions, and reload', async ({ page }) => {
    await page.addInitScript((portableSource) => {
      if (!localStorage.getItem('draftmatter.structured-mode.v1')) {
        localStorage.setItem('draftmatter.structured-source.v1', portableSource)
        localStorage.setItem('draftmatter.structured-mode.v1', 'true')
      }
    }, source)
    await page.goto('/')

    await page.getByRole('button', { name: 'Settings' }).click()
    const settings = page.getByRole('dialog', { name: 'Review identity' })
    await settings.getByLabel('Display name').fill('Zoé Dupont')
    await settings.getByRole('button', { name: 'Save identity' }).click()
    await expect(page.locator('.topbar-actions .avatar')).toHaveAttribute('aria-label', 'Zoé Dupont')
    await expect(page.locator('.topbar-actions .avatar')).toHaveText('ZD')

    const manuscript = page.getByRole('article', { name: 'Editable manuscript' })
    await page.locator('.topbar').getByRole('button', { name: /^Review,/ }).click()
    const review = page.getByRole('complementary', { name: 'Review feedback' })
    await selectRenderedText(manuscript.getByText('Comment on this sentence.', { exact: true }), 'Comment on this sentence.')
    await review.getByRole('button', { name: 'New comment' }).click()
    const composer = review.getByRole('group', { name: 'New comment' })
    await composer.getByLabel('Comment').fill('Please retain the confidence interval.')
    await composer.getByRole('button', { name: 'Add' }).click()

    await page.getByRole('button', { name: 'Turn on track changes' }).click()
    await selectRenderedText(manuscript.getByText('Suggest on this sentence.', { exact: true }), 'Suggest on this sentence.')
    await page.keyboard.type('Use this revised sentence.')

    const storedSettings = await page.evaluate(() => JSON.parse(localStorage.getItem('draftmatter.user-settings.v1') ?? 'null')) as { author: { id: string; name: string } }
    expect(storedSettings).toMatchObject({ author: { id: expect.stringMatching(/^dm-author-/), name: 'Zoé Dupont' } })
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')).toContain('Use this revised')
    const portable = await page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')
    expect(portable.match(/data-name="Zoé Dupont"/g)).toHaveLength(1)
    expect(portable).toContain(`data-author="${storedSettings.author.id}"`)
    expect(portable).toMatch(new RegExp(`\\.dm-thread[^\\n]*data-author="${storedSettings.author.id}"`))
    expect(portable).toMatch(new RegExp(`\\.dm-change[^\\n]*data-author="${storedSettings.author.id}"`))
    await expect(manuscript.locator('.dm-review-change').filter({ hasText: 'Suggest on this' })).toBeVisible()

    await page.reload()
    await expect(page.locator('.topbar-actions .avatar')).toHaveAttribute('aria-label', 'Zoé Dupont')
    await page.locator('.topbar').getByRole('button', { name: /^Review,/ }).click()
    await expect(page.getByRole('complementary', { name: 'Review feedback' }).getByText('Please retain the confidence interval.', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Settings' }).click()
    await expect(page.getByRole('dialog', { name: 'Review identity' }).getByLabel('Display name')).toHaveValue('Zoé Dupont')
  })
})
