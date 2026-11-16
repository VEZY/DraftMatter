import { expect, type Page } from '@playwright/test'

/** Reveal the unpinned toolbar through the same reachable tab a reader uses. */
export async function showWritingTools(page: Page) {
  const reveal = page.getByRole('button', { name: 'Show writing tools', exact: true })
  await reveal.hover()
  await reveal.click()
  await expect(page.getByRole('toolbar', { name: 'Formatting toolbar', exact: true })).toHaveCSS('opacity', '1')
}
