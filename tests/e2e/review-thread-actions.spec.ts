import { expect, test } from '@playwright/test'

test.describe('DM-P4-01 review thread actions', () => {
  test('copies an ordinary portable figure reference', async ({ context, page }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.goto('/')

    await page.getByRole('button', { name: 'Copy figure reference @fig-canopy-result' }).click()
    await expect(page.getByText('Copied @fig-canopy-result')).toBeVisible()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('@fig-canopy-result')
  })

  test('removes a sample comment from the active queue and reopens its deleted audit record', async ({ page }) => {
    await page.goto('/')
    const review = page.getByRole('complementary', { name: 'Review feedback' })
    await expect(review.getByText('Can we quantify this increase in the main text?')).toBeVisible()

    await review.getByRole('button', { name: 'Remove' }).click()
    await expect(review.getByText('Can we quantify this increase in the main text?')).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')).toContain('data-status="deleted"')

    await page.reload()
    await expect(page.getByRole('complementary', { name: 'Review feedback' }).getByText('Can we quantify this increase in the main text?')).toHaveCount(0)
    const portable = await page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')
    expect(portable).toContain('{#dm-comment-01 .dm-thread')
    expect(portable).toContain('data-status="deleted"')
  })
})
