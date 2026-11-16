import { expect, test, type Page } from '@playwright/test'

interface FileTabsFixture {
  editOnDisk(path: string, text: string): void
  text(path: string): string | null
  reads(): { path: string; maxBytes: number; returnedBytes: number }[]
  writes(): { path: string; content: string; expectedHash: string }[]
}
declare global { interface Window { fileTabsFixture: FileTabsFixture; __fixtureScriptExecuted: boolean } }

const scriptPath = 'scripts/analysis.js'
const replacement = 'globalThis.__fixtureScriptExecuted = true;\nlet threshold = 2;\n'
const activePanel = (page: Page) => page.getByRole('tabpanel').filter({ visible: true })
const sourceEditor = (page: Page) => activePanel(page).locator('.cm-content')

test('keeps real CodeMirror drafts across tabs, rejects stale saves and reloads before retrying', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/tests/e2e/fixtures/file-tabs-editor.html')
  const manuscript = page.getByRole('textbox', { name: 'Manuscript editor', exact: true })
  await manuscript.fill('A manuscript change that has not been saved.')
  await page.getByRole('button', { name: 'Open script', exact: true }).click()
  await expect(sourceEditor(page)).toHaveAttribute('contenteditable', 'false')
  await expect(sourceEditor(page)).toContainText('let threshold = 1;')
  expect(await page.evaluate(() => window.__fixtureScriptExecuted)).toBe(false)
  await activePanel(page).getByRole('button', { name: 'Edit source', exact: true }).click()
  await expect(sourceEditor(page)).toHaveAttribute('contenteditable', 'true')
  await sourceEditor(page).fill(replacement)
  await expect(page.getByRole('tab', { name: /analysis\.js/ })).toContainText('●')
  await expect(activePanel(page).getByRole('button', { name: 'Reload file', exact: true })).toBeDisabled()

  await page.getByRole('button', { name: 'Open notes', exact: true }).click()
  await expect(activePanel(page).getByRole('heading', { name: 'Methods note', exact: true })).toBeVisible()
  await expect(activePanel(page).locator('img,script,iframe')).toHaveCount(0)
  await page.getByRole('tab', { name: /paper\.qmd/ }).click()
  await expect(manuscript).toHaveText('A manuscript change that has not been saved.')
  await page.getByRole('tab', { name: /analysis\.js/ }).click()
  await expect(sourceEditor(page)).toContainText('let threshold = 2;')
  await expect(sourceEditor(page)).toHaveAttribute('contenteditable', 'true')

  const concurrent = 'let threshold = 100;\n'
  await page.evaluate(([path, text]) => window.fileTabsFixture.editOnDisk(path, text), [scriptPath, concurrent])
  await activePanel(page).getByRole('button', { name: 'Save file', exact: true }).click()
  await expect(activePanel(page).getByRole('alert')).toContainText('changed outside DraftMatter')
  await expect(sourceEditor(page)).toContainText('let threshold = 2;')
  expect(await page.evaluate((path) => window.fileTabsFixture.text(path), scriptPath)).toBe(concurrent)
  expect(await page.evaluate(() => window.fileTabsFixture.writes())).toHaveLength(0)
  await activePanel(page).getByRole('button', { name: 'Discard changes', exact: true }).click()
  await expect(sourceEditor(page)).toContainText('let threshold = 1;')
  await activePanel(page).getByRole('button', { name: 'Reload file', exact: true }).click()
  await expect(sourceEditor(page)).toContainText('let threshold = 100;')
  await expect(sourceEditor(page)).toHaveAttribute('contenteditable', 'false')
  await activePanel(page).getByRole('button', { name: 'Edit source', exact: true }).click()
  await sourceEditor(page).fill('let threshold = 101;\n')
  await sourceEditor(page).press('ControlOrMeta+s')
  await expect.poll(() => page.evaluate((path) => window.fileTabsFixture.text(path), scriptPath)).toBe('let threshold = 101;\n')
  await expect(activePanel(page).getByRole('button', { name: 'Save file', exact: true })).toBeDisabled()
  expect(await page.evaluate(() => window.fileTabsFixture.writes())).toHaveLength(1)
  expect(await page.evaluate(() => window.__fixtureScriptExecuted)).toBe(false)
  expect(errors).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('file-tabs-script-editor.png'), fullPage: true })
})

test('supports ignore files, real undo/redo and unsupported-file details with bounded reads', async ({ page }) => {
  await page.goto('/tests/e2e/fixtures/file-tabs-editor.html')
  await page.getByRole('button', { name: 'Open .gitignore', exact: true }).click()
  await expect(sourceEditor(page)).toHaveAttribute('contenteditable', 'false')
  await activePanel(page).getByRole('button', { name: 'Edit source', exact: true }).click()
  await sourceEditor(page).click()
  await sourceEditor(page).press('ControlOrMeta+End')
  await sourceEditor(page).pressSequentially('scratch/')
  await expect(sourceEditor(page)).toContainText('scratch/')
  await sourceEditor(page).press('ControlOrMeta+z')
  await expect(sourceEditor(page)).not.toContainText('scratch/')
  await activePanel(page).getByRole('button', { name: 'Redo', exact: true }).click()
  await expect(sourceEditor(page)).toContainText('scratch/')
  await activePanel(page).getByRole('button', { name: 'Save file', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.fileTabsFixture.text('.gitignore'))).toContain('scratch/')
  await page.getByRole('button', { name: 'Open binary', exact: true }).click()
  await expect(activePanel(page)).toContainText('No preview is available')
  await expect(activePanel(page)).toContainText('Local · SHA-256')
  await expect(activePanel(page)).toContainText('4 B')
  await expect(activePanel(page).locator('.cm-editor')).toHaveCount(0)
  const reads = await page.evaluate(() => window.fileTabsFixture.reads())
  expect(reads.map((read) => read.path)).toEqual(['.gitignore', 'data/archive.bin'])
  expect(reads.every((read) => read.maxBytes <= 1024 * 1024 && read.returnedBytes <= read.maxBytes)).toBe(true)
  expect(await page.evaluate(() => window.__fixtureScriptExecuted)).toBe(false)
})
