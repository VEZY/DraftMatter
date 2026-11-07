import { expect, type Page } from '@playwright/test'

export async function reloadWithPortableSource(page: Page, portableSource: string) {
  await page.evaluate((nextSource) => {
    sessionStorage.setItem('draftmatter.e2e-next-source', nextSource)
  }, portableSource)
  await page.addInitScript(() => {
    const nextSource = sessionStorage.getItem('draftmatter.e2e-next-source')
    if (nextSource === null) return
    localStorage.setItem('draftmatter.structured-source.v1', nextSource)
    sessionStorage.removeItem('draftmatter.e2e-next-source')
  })
  await page.reload()
  await expect(page.getByRole('textbox', { name: 'Rendered manuscript editor' })).toBeVisible()
}
