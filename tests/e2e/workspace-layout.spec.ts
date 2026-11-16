import { expect, test, type Locator, type Page } from '@playwright/test'

const navigation = (page: Page) => page.getByRole('navigation', { name: 'Workspace navigation' })
const sidebar = (page: Page) => page.locator('#project-navigation-panel')

async function wheelWithin(page: Page, target: Locator, delta = 12_000) {
  const bounds = await target.boundingBox()
  expect(bounds).not.toBeNull()
  await page.mouse.move(bounds!.x + bounds!.width - 12, bounds!.y + bounds!.height / 2)
  await page.mouse.wheel(0, delta)
}

async function layout(page: Page) {
  return page.evaluate(() => {
    const bounds = (selector: string) => {
      const element = document.querySelector(selector)!
      const rect = element.getBoundingClientRect()
      return { top: rect.top, bottom: rect.bottom, height: rect.height }
    }
    return {
      viewport: innerHeight,
      documentHeight: document.documentElement.scrollHeight,
      header: bounds('.topbar'), workspace: bounds('.workspace'), editor: bounds('.editor-area'),
      tabs: bounds('.project-document-tabs'), rail: bounds('.app-rail'), settings: bounds('[aria-label="Settings"]'),
    }
  })
}

for (const viewport of [{ width: 1440, height: 960 }, { width: 1024, height: 720 }, { width: 390, height: 844 }]) {
  test(`uses the full viewport with Files, Outline and no sidebar at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport)
    await page.goto('/tests/e2e/fixtures/workspace-layout.html')
    const article = page.getByRole('article', { name: 'Editable manuscript', exact: true })
    await expect(article.getByRole('heading', { name: 'Section 48', exact: true })).toHaveCount(1)
    await page.locator('.structured-manuscript-editor').evaluate((editor) => { (window as unknown as { layoutEditor: Element }).layoutEditor = editor })
    const measurements = []
    for (const state of ['Outline', 'Files', 'Closed'] as const) {
      if (state === 'Closed') {
        await navigation(page).getByRole('button', { name: 'Files', exact: true }).click()
        await expect(sidebar(page)).toHaveCount(0)
      }
      else if (await navigation(page).getByRole('button', { name: state, exact: true }).getAttribute('aria-pressed') !== 'true') {
        await navigation(page).getByRole('button', { name: state, exact: true }).click()
      }
      await expect.poll(async () => (await layout(page)).workspace.bottom).toBeCloseTo(viewport.height, 0)
      const size = await layout(page)
      measurements.push({ state, ...size })
      expect(size.workspace.top).toBeCloseTo(size.header.bottom, 0)
      expect(size.editor.top).toBeCloseTo(size.tabs.bottom, 0)
      expect(size.editor.bottom).toBeCloseTo(viewport.height, 0)
      expect(size.editor.height).toBeGreaterThan(viewport.height - size.header.height - size.tabs.height - 3)
      expect(size.rail.bottom).toBeCloseTo(viewport.height, 0)
      expect(size.settings.bottom).toBeGreaterThan(viewport.height - 65)
      expect(size.settings.bottom).toBeLessThanOrEqual(viewport.height)
      expect(size.documentHeight).toBeLessThanOrEqual(viewport.height + 1)
      if (state === 'Closed') {
        await page.keyboard.press('ControlOrMeta+f')
        await expect(page.getByPlaceholder('Find in document…', { exact: true })).toBeVisible()
        expect((await layout(page)).editor.bottom).toBeCloseTo(viewport.height, 0)
        await page.keyboard.press('Escape')
      }
      const editor = page.locator('.editor-area')
      await editor.evaluate((element) => { element.scrollTop = 0 })
      await wheelWithin(page, editor, 700)
      await expect.poll(() => editor.evaluate((element) => element.scrollTop)).toBeGreaterThan(300)
      expect(await page.locator('.structured-manuscript-editor').evaluate((editor) => editor === (window as unknown as { layoutEditor: Element }).layoutEditor)).toBe(true)
    }
    await testInfo.attach('workspace-layout-measurements', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' })
    await page.screenshot({ path: testInfo.outputPath(`workspace-sidebar-closed-${viewport.width}.png`) })
  })
}

test('scrolls Files and Outline independently while keeping their controls accessible', async ({ page }, testInfo) => {
  await page.goto('/tests/e2e/fixtures/workspace-layout.html')
  await expect(page.getByRole('article', { name: 'Editable manuscript', exact: true })).toBeVisible()
  await navigation(page).getByRole('button', { name: 'Files', exact: true }).click()
  const files = sidebar(page)
  await expect(files.locator('[data-path="observations-120.csv"]')).toHaveCount(1)
  const editor = page.locator('.editor-area')
  const originalDocumentScroll = await editor.evaluate((element) => element.scrollTop)
  await wheelWithin(page, files)
  const sharing = files.locator('.project-file-explorer-transfers > summary')
  await expect(sharing).toBeInViewport()
  await expect(files.getByRole('button', { name: 'Close project files', exact: true })).toBeInViewport()
  expect(await editor.evaluate((element) => element.scrollTop)).toBe(originalDocumentScroll)
  await sharing.click()
  await wheelWithin(page, files)
  const connect = files.getByRole('button', { name: 'Connect project…', exact: true })
  await expect(connect).toBeInViewport()
  // The same control must remain reachable without pointer scrolling.
  await files.locator('.project-files-workspace-body').evaluate((element) => { element.scrollTop = 0 })
  await sharing.focus()
  await page.keyboard.press('Tab')
  await expect(connect).toBeFocused()
  await expect(connect).toBeInViewport()
  await page.screenshot({ path: testInfo.outputPath('files-sharing-scroll.png') })

  await navigation(page).getByRole('button', { name: 'Outline', exact: true }).click()
  const outline = page.locator('.outline-tree')
  await wheelWithin(page, outline)
  await expect(outline.getByRole('button', { name: 'Section 48', exact: true })).toBeInViewport()
  await expect(sidebar(page).getByRole('button', { name: 'View source', exact: true })).toBeInViewport()
  expect(await editor.evaluate((element) => element.scrollTop)).toBe(originalDocumentScroll)
  await page.screenshot({ path: testInfo.outputPath('outline-scroll.png') })
})
