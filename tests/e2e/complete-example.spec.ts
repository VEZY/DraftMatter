import { expect, test } from '@playwright/test'

test.describe('built-in complete example', () => {
  test('keeps Code, Review, and Export prioritized across header breakpoints', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/draft')

    const code = page.locator('.topbar-code-workspace')
    await expect(code).toBeVisible()
    await expect(code.locator('.code-workspace-label-full')).toBeVisible()
    await expect(page.locator('.topbar').getByRole('button', { name: /^Review,/ })).toBeVisible()
    await expect(page.locator('.topbar').getByRole('button', { name: 'Export' })).toBeVisible()
    const wideHeaderGap = await page.locator('.topbar').evaluate((header) => {
      const saveState = header.querySelector('.document-state')!.getBoundingClientRect()
      const codeWorkspace = header.querySelector('.topbar-code-workspace')!.getBoundingClientRect()
      return codeWorkspace.left - saveState.right
    })
    expect(wideHeaderGap).toBeGreaterThanOrEqual(18)

    await page.setViewportSize({ width: 1024, height: 768 })
    await expect(code).toBeVisible()
    await expect(code.locator('.code-workspace-label-short')).toBeVisible()
    await expect(code.locator('.code-workspace-label-full')).toBeHidden()
    await expect(page.locator('.topbar').getByRole('button', { name: /^Review,/ })).toBeVisible()
    await expect(page.locator('.topbar').getByRole('button', { name: 'Export' })).toBeVisible()
  })

  test('keeps long-outline click and keyboard navigation inside their panels', async ({ page }) => {
    await page.goto('/draft')
    await page.evaluate(() => localStorage.clear())
    await page.reload()

    await page.locator('.project-switcher').click()
    await page.getByRole('button', { name: /Open complete example/ }).click()

    const outline = page.getByRole('complementary', { name: 'Manuscript outline' })
    const tree = outline.locator('.outline-tree')
    await expect.poll(() => tree.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight)).toBe(await page.evaluate(() => window.innerHeight))
    await expect(page.locator('.editor-area')).toHaveCSS('scroll-behavior', 'auto')

    const finalSection = tree.getByRole('button').filter({ hasText: 'Data and code availability' })
    await finalSection.click()
    await expect.poll(() => page.locator('.editor-area').evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)

    await finalSection.press('ArrowUp')
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)

    await page.getByRole('heading', { name: 'Data and code availability', exact: true }).click()
    await page.getByRole('textbox', { name: 'Rendered manuscript editor' }).press('ArrowUp')
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
  })

  test('opens from the project menu and remains complete after reload', async ({ page }) => {
    await page.goto('/draft')
    await page.evaluate(() => localStorage.clear())
    await page.reload()

    await page.locator('.project-switcher').click()
    await page.getByRole('button', { name: /Open complete example/ }).click()

    const manuscript = page.getByRole('article', { name: 'Editable manuscript' })
    await expect(page.locator('.project-switcher-name')).toHaveText('Complete example paper')
    await expect(manuscript.getByRole('heading', { level: 1 })).toHaveText('A reproducible cross-language analysis of synthetic canopy drought responses')
    await expect(page.getByRole('button', { name: 'Manage manuscript authors, 3 listed' })).toBeVisible()
    await expect(manuscript.getByText(/Chen and Silva, 2025; Vezy and Martin, 2024/)).toBeVisible()
    await expect(manuscript.locator('.structured-cross-reference[data-reference-status="valid"]')).toHaveCount(7)
    const inlineReferenceWidths = await manuscript.locator('.structured-cross-reference[data-reference-status="valid"]').evaluateAll((references) =>
      references.map((reference) => ({
        reference: reference.getBoundingClientRect().width,
        link: reference.querySelector('.structured-cross-reference-link')!.getBoundingClientRect().width,
        editPosition: getComputedStyle(reference.querySelector('.structured-cross-reference-edit')!).position,
      })),
    )
    expect(inlineReferenceWidths.every(({ reference, link, editPosition }) =>
      editPosition === 'absolute' && Math.abs(reference - link) <= 1,
    )).toBe(true)
    await expect(manuscript.locator('.structured-output-image')).toHaveCount(3)
    await expect(manuscript.locator('.structured-output-table')).toHaveCount(3)
    await expect(manuscript.locator('.structured-code-cell[data-language="python"]')).toHaveCount(2)
    await expect(manuscript.locator('.structured-code-cell[data-language="r"]')).toHaveCount(2)
    await expect(manuscript.locator('.structured-code-cell[data-language="julia"]')).toHaveCount(2)
    await expect(manuscript.locator('.structured-output-image img').first()).toHaveAttribute('src', /^data:image\/svg\+xml/)

    await page.locator('.topbar').getByRole('button', { name: /^Review,/ }).click()
    const review = page.getByRole('complementary', { name: 'Review feedback' })
    await expect(review.getByText('drought treatment reduced canopy expansion by 18.4%', { exact: true })).toBeVisible()
    await expect(review.getByText('Please confirm that the ±3.0 cm² diagnostic threshold was fixed before the model check.', { exact: true })).toBeVisible()

    await page.reload()
    await expect(page.locator('.project-switcher-name')).toHaveText('Complete example paper')
    await expect(manuscript.locator('.structured-output-image img')).toHaveCount(3)
    await expect(manuscript.locator('.structured-output-image img').first()).toHaveAttribute('src', /^data:image\/svg\+xml/)
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('draftmatter.citations.v1') ?? '[]').length)).toBe(2)

    await page.locator('.project-switcher').click()
    await expect(page.locator('.project-menu-current')).toContainText('Built-in example · copy before execution')
    await expect(page.getByRole('button', { name: /Open complete example/ })).toBeVisible()
  })
})
