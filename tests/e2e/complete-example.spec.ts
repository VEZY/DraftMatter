import { expect, test } from '@playwright/test'

test.describe('built-in complete example', () => {
  test('opens from the project menu and remains complete after reload', async ({ page }) => {
    await page.goto('/')
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
    await expect(page.locator('.project-menu-current')).toContainText('Built-in example · editable browser copy')
    await expect(page.getByRole('button', { name: /Open complete example/ })).toBeVisible()
  })
})
