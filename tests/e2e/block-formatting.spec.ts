import { expect, test } from '@playwright/test'

const source = `# Formatting controls

Promote this paragraph.

Bullet this paragraph.

Number this paragraph.

Quote this paragraph.
`

test.describe('DM-P1-03 rendered block formatting', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((portableSource) => {
      if (!localStorage.getItem('draftmatter.structured-source.v1')) {
        localStorage.setItem('draftmatter.structured-source.v1', portableSource)
        localStorage.setItem('draftmatter.structured-mode.v1', 'true')
      }
    }, source)
    await page.goto('/')
  })

  test('applies heading, list, and quotation styles and reopens their portable source', async ({ page }) => {
    const manuscript = page.getByRole('article', { name: 'Editable manuscript' })
    const styles = page.getByLabel('Block style')

    await manuscript.getByText('Bullet this paragraph.', { exact: true }).selectText()
    await styles.selectOption('bullets')
    await expect(manuscript.getByRole('listitem').filter({ hasText: 'Bullet this paragraph.' })).toBeVisible()

    await manuscript.getByText('Promote this paragraph.', { exact: true }).selectText()
    await styles.selectOption('heading-2')
    await expect(manuscript.getByRole('heading', { level: 2, name: 'Promote this paragraph.' })).toBeVisible()

    await manuscript.getByText('Number this paragraph.', { exact: true }).selectText()
    await styles.selectOption('numbering')
    await expect(manuscript.getByRole('listitem').filter({ hasText: 'Number this paragraph.' })).toBeVisible()

    await manuscript.getByText('Quote this paragraph.', { exact: true }).selectText()
    await styles.selectOption('quote')
    await expect(manuscript.getByRole('blockquote')).toContainText('Quote this paragraph.')

    await expect.poll(() => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')).toContain('> Quote this paragraph.')
    const portable = await page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')
    expect(portable).toContain('## Promote this paragraph.')
    expect(portable).toContain('- Bullet this paragraph.')
    expect(portable).toContain('1. Number this paragraph.')
    expect(portable).toContain('> Quote this paragraph.')

    await page.reload()
    await expect(manuscript.getByRole('heading', { level: 2, name: 'Promote this paragraph.' })).toBeVisible()
    await expect(manuscript.getByRole('listitem')).toHaveCount(2)
    await expect(manuscript.getByRole('blockquote')).toContainText('Quote this paragraph.')
  })
})
