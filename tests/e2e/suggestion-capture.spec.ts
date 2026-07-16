import { expect, test } from '@playwright/test'

const source = `# Suggestion capture

Replace this sentence.

Paste over this sentence.

Delete this sentence.

Insert after this sentence.

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
  test.beforeEach(async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.addInitScript((portableSource) => {
      localStorage.setItem('draftmatter.structured-source.v1', portableSource)
      localStorage.setItem('draftmatter.structured-mode.v1', 'true')
    }, source)
    await page.goto('/')
    await page.getByRole('button', { name: 'Turn on track changes' }).click()
    await expect(page.getByRole('button', { name: 'Turn off track changes' })).toHaveAttribute('aria-pressed', 'true')
  })

  test('groups typing, paste, deletion, and insertion without changing accepted prose', async ({ page }) => {
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
    await expect(page.getByRole('complementary', { name: 'Review feedback' }).getByText('A carefully replaced')).toBeVisible()
  })

  test('captures toolbar formatting and block structure without changing accepted prose', async ({ page }) => {
    const manuscript = page.getByRole('article', { name: 'Editable manuscript' })

    await manuscript.getByText('Format this phrase.', { exact: true }).selectText()
    await page.getByRole('button', { name: 'Bold' }).click()
    await waitForChangeCount(page, 1)

    await manuscript.getByText('Promote this paragraph.', { exact: true }).selectText()
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
