import { expect, test } from '@playwright/test'

test('opens recovery history from the left rail and closes it with Escape', async ({ page }) => {
  await page.goto('/draft')
  const navigation = page.getByRole('navigation', { name: 'Workspace navigation' })
  const history = navigation.getByRole('button', { name: 'History', exact: true })
  await expect(history).toBeVisible()
  await history.click()
  const dialog = page.getByRole('dialog', { name: 'Recovery history', exact: true })
  await expect(dialog).toBeVisible()
  await expect(history).toHaveAttribute('aria-expanded', 'true')
  await expect(dialog).toContainText('Restoring creates a new autosaved state')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(history).toHaveAttribute('aria-expanded', 'false')
  await history.focus()
  await page.keyboard.press('Enter')
  await expect(dialog).toBeVisible()
})

test('keeps downloads for a paper that lives only in this browser', async ({ page }) => {
  await page.goto('/draft')
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Files', exact: true }).click()
  const file = page.getByRole('region', { name: 'Selected project file', exact: true })
  await expect(file).toBeVisible()
  await expect(file.getByRole('button', { name: /^Download / })).toBeVisible()
})
