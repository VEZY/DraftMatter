import { expect, test } from '@playwright/test'

test('opens a pre-filled portable comment from the manuscript context menu', async ({ page }) => {
  const source = '# Context comments\n\nAttach the review directly to this sentence.\n'
  await page.addInitScript((portableSource) => {
    localStorage.setItem('draftmatter.structured-source.v1', portableSource)
    localStorage.setItem('draftmatter.structured-mode.v1', 'true')
  }, source)
  await page.goto('/')

  await page.getByText('Attach the review directly to this sentence.', { exact: true }).click({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'Review selection' })
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', { name: /Add comment/ }).click()

  const composer = page.getByRole('group', { name: 'New comment' })
  await expect(composer).toBeVisible()
  await expect(composer.locator('input')).toHaveValue('Attach the review directly to this sentence.')
  await expect(composer.locator('textarea')).toBeFocused()
})
