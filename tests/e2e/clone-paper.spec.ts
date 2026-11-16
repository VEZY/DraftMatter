import { expect, test } from '@playwright/test'

declare global { interface Window { clonePaperFixture: { operations(): { kind: string; request?: unknown }[] } } }

test('clones a paper from home into a chosen folder and opens the regular editor', async ({ page }, testInfo) => {
  await page.goto('/tests/e2e/fixtures/clone-paper.html')
  const newPaper = page.getByRole('button', { name: 'New paper', exact: true })
  const clonePaper = page.getByRole('button', { name: 'Clone a paper', exact: true })
  await expect(newPaper).toBeVisible()
  await expect(clonePaper).toBeVisible()
  const createBounds = await newPaper.boundingBox()
  const cloneBounds = await clonePaper.boundingBox()
  expect(createBounds).not.toBeNull()
  expect(cloneBounds).not.toBeNull()
  expect(cloneBounds!.y).toBe(createBounds!.y)
  expect(cloneBounds!.x).toBeGreaterThan(createBounds!.x)
  await clonePaper.click()
  const dialog = page.getByRole('dialog', { name: 'Clone a paper', exact: true })
  await expect(dialog).toBeVisible()
  const submit = dialog.getByRole('button', { name: 'Clone paper', exact: true })
  await expect(submit).toBeDisabled()
  await dialog.getByLabel('Repository URL', { exact: true }).fill('https://git.example.org/team/shared-paper.git')
  await expect(dialog.getByLabel('Folder name', { exact: true })).toHaveValue('shared-paper')
  await dialog.getByRole('button', { name: 'Choose folder…', exact: true }).click()
  await expect(dialog).toContainText('/fixture/cloned-papers')
  await expect(submit).toBeEnabled()
  expect(await page.evaluate(() => window.clonePaperFixture.operations())).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('clone-paper-dialog.png') })
  await submit.click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('article', { name: 'Editable manuscript', exact: true })).toContainText('The cloned manuscript opens without running its computations.')
  expect(await page.evaluate(() => window.clonePaperFixture.operations())).toEqual([
    { kind: 'clone', request: { url: 'https://git.example.org/team/shared-paper.git', parent: '/fixture/cloned-papers', folderName: 'shared-paper' } },
    { kind: 'open', request: '/fixture/cloned-papers/shared-paper' },
  ])
  await expect(page).toHaveURL(/\/local\//)
})
