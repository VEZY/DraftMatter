import { expect, test } from '@playwright/test'

test.describe('DM-P0-06 rendered vertical slice', () => {
  test('renders, reviews, and projects the portable manuscript without exposing review source', async ({ page }) => {
    await page.goto('/')

    const manuscript = page.getByRole('article', { name: 'Editable manuscript' })
    const reviewPanel = page.getByRole('complementary', { name: 'Review feedback' })

    await expect(manuscript).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Manuscript title' })).toContainText('Drought acclimation reshapes canopy development')
    await expect(page.getByRole('button', { name: 'Open citation details' })).toHaveText('(Vezy et al., 2024)')
    await expect(page.locator('.code-cell-label')).toContainText('Canopy response over time')
    await expect(page.getByRole('img', { name: /Line chart comparing control and drought/ })).toBeVisible()
    await expect(reviewPanel.getByText('2 overlapping alternatives')).toBeVisible()
    await expect(reviewPanel.getByText(/Can we quantify this increase/)).toBeVisible()
    await expect(page.locator('body')).not.toContainText('.dm-anchor')
    await expect(page.locator('body')).not.toContainText('.draftmatter-reviews')

    await expect(page).toHaveScreenshot('rendered-vertical-slice.png')

    await page.getByRole('button', { name: /View source/ }).click()
    const sourceInspector = page.getByRole('dialog', { name: 'Portable source inspector' })
    await sourceInspector.getByRole('tab', { name: 'Clean final' }).click()
    await expect(sourceInspector.getByRole('alert')).toContainText('dm-c01 (Alice Martin, open); dm-c02 (Marcus Chen, open)')
    await expect(sourceInspector.getByRole('button', { name: 'Resolve review first' })).toBeDisabled()

    await page.getByRole('button', { name: 'Close source inspector' }).click()
    await reviewPanel.locator('.proposal-option').nth(1).click()
    await reviewPanel.getByRole('button', { name: 'Accept' }).click()
    await expect(reviewPanel.locator('.proposal-option').nth(1)).toContainText('Accepted')
    await expect(reviewPanel.locator('.proposal-option').first()).toContainText('Needs rebase')

    await page.getByRole('button', { name: /View source/ }).click()
    await sourceInspector.getByRole('tab', { name: 'Clean final' }).click()
    const cleanProjection = sourceInspector.locator('pre')
    await expect(cleanProjection).toContainText('lowered leaf expansion during the treatment period')
    await expect(cleanProjection).not.toContainText('.dm-anchor')
    await expect(cleanProjection).not.toContainText('.draftmatter-reviews')
    await expect(sourceInspector.getByRole('button', { name: 'Download projection' })).toBeEnabled()
  })

  test('keeps the primary writing and review controls keyboard reachable', async ({ page }) => {
    await page.goto('/')

    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
    const palette = page.getByRole('dialog', { name: 'Command menu' })
    await expect(palette).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(palette).toBeHidden()

    await page.getByRole('textbox', { name: 'Manuscript title' }).focus()
    await expect(page.getByRole('textbox', { name: 'Manuscript title' })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(page.locator(':focus')).toBeVisible()
  })
})
