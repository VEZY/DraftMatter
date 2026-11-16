import { expect, test } from '@playwright/test'

declare global { interface Window { projectImagesFixture: { reads(): string[]; paper(): string; replaceImage(): Promise<void> } } }

test('renders a local PNG inserted from Files and reloads it from the portable manuscript path', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/tests/e2e/fixtures/project-images.html')
  const manuscript = page.getByRole('article', { name: 'Editable manuscript', exact: true })
  await manuscript.getByText('Place the figure after this paragraph.', { exact: true }).click()
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Files', exact: true }).click()
  const files = page.getByRole('complementary', { name: 'Project files', exact: true })
  await files.getByRole('searchbox', { name: 'Find a project file' }).fill('response plot.png')
  await files.locator('[data-path="figures/response plot.png"]').click()
  await expect(page.getByRole('region', { name: 'Image preview', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Insert as figure', exact: true }).click()
  const figure = manuscript.getByRole('img', { name: 'response plot', exact: true })
  await expect(figure).toHaveAttribute('src', /^blob:/)
  await expect.poll(() => figure.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(320)
  await expect.poll(() => page.evaluate(() => window.projectImagesFixture.paper())).toContain('figures/response plot.png')
  const source = await page.evaluate(() => window.projectImagesFixture.paper())
  expect(source).not.toMatch(/blob:|data:image|asset:/)
  await page.screenshot({ path: testInfo.outputPath('inserted-local-png.png') })

  await page.reload()
  await expect(figure).toHaveAttribute('src', /^blob:/)
  await expect.poll(() => figure.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(320)
  expect(await page.evaluate(() => window.projectImagesFixture.reads())).toEqual(['figures/response plot.png'])

  const previousUrl = await figure.getAttribute('src')
  await page.evaluate(() => window.projectImagesFixture.replaceImage())
  if (!await files.isVisible()) await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Files', exact: true }).click()
  await files.getByRole('searchbox', { name: 'Find a project file' }).fill('response plot.png')
  await files.locator('[data-path="figures/response plot.png"]').click()
  await page.getByRole('button', { name: 'Insert as figure', exact: true }).click()
  await expect(figure).toHaveCount(2)
  await expect(figure.first()).not.toHaveAttribute('src', previousUrl!)
  await expect.poll(() => figure.first().evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(320)
  const pixel = await figure.first().evaluate((image: HTMLImageElement) => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0)
    return [...context.getImageData(0, 0, 1, 1).data]
  })
  expect(pixel).toEqual([224, 75, 54, 255])
  expect(errors).toEqual([])
})
