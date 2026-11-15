import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'

const source = `---
title: "Field response study"
---

# Field response study

## Results

The observed response belongs here.
`

const figure = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><rect width="320" height="180" fill="#f5f8f5"/><path d="M20 150L90 110L160 95L230 45L300 25" fill="none" stroke="#426b51" stroke-width="4"/></svg>')

function storedZipFiles(archive: Buffer) {
  const files = new Map<string, Buffer>()
  let cursor = 0
  while (cursor + 30 <= archive.length && archive.readUInt32LE(cursor) === 0x04034b50) {
    const size = archive.readUInt32LE(cursor + 18)
    const nameLength = archive.readUInt16LE(cursor + 26)
    const extraLength = archive.readUInt16LE(cursor + 28)
    const nameStart = cursor + 30
    const contentStart = nameStart + nameLength + extraLength
    files.set(archive.subarray(nameStart, nameStart + nameLength).toString('utf8'), archive.subarray(contentStart, contentStart + size))
    cursor = contentStart + size
  }
  return files
}

test.describe('ordinary writing and portable figure files', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined })
    })
  })

  test('inserts an image through the writing toolbar and keeps it after reload', async ({ page }, testInfo) => {
    await page.addInitScript((portableSource) => {
      if (localStorage.getItem('draftmatter.structured-source.v1')) return
      localStorage.setItem('draftmatter.project-meta.v1', JSON.stringify({ filename: 'field-response.qmd', projectName: 'Field response study', citationStyle: 'draftmatter-author-date', citationLocale: 'en-US' }))
      localStorage.setItem('draftmatter.structured-source.v1', portableSource)
      localStorage.setItem('draftmatter.structured-mode.v1', 'true')
    }, source)
    await page.goto('/draft')
    const manuscript = page.getByRole('article', { name: 'Editable manuscript' })
    await manuscript.getByText('The observed response belongs here.', { exact: true }).click()
    await page.getByRole('button', { name: 'Insert', exact: true }).click()
    await page.locator('.toolbar-insert-menu').getByRole('button', { name: /^Figure/ }).click()
    const dialog = page.getByRole('dialog', { name: 'Insert figure', exact: true })
    await dialog.getByLabel('Choose figure image').setInputFiles({ name: 'field-response.svg', mimeType: 'image/svg+xml', buffer: figure })
    await dialog.getByLabel('Accessible description').fill('Measured field response')
    await dialog.getByLabel('Caption', { exact: true }).fill('Observed response through time.')
    await dialog.getByRole('button', { name: 'Insert', exact: true }).click()
    await expect(dialog).toBeHidden()

    const renderedFigure = manuscript.getByRole('img', { name: 'Measured field response', exact: true })
    await expect(renderedFigure).toBeVisible()
    await expect.poll(() => renderedFigure.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
    await expect.poll(() => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')).toMatch(/figures\/field-response-[a-f\d]{8}\.svg/)
    const portable = await page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')
    const path = portable.match(/figures\/field-response-[a-f\d]{8}\.svg/)![0]
    expect(portable).toContain(`![Measured field response](${path})`)
    expect(portable).not.toContain('data:image')
    expect(portable).not.toContain(figure.toString('base64'))

    await page.reload()
    await expect(renderedFigure).toBeVisible()
    const restoredImagePaths = await page.evaluate(async () => {
      const scope = localStorage.getItem('draftmatter.browser-asset-scope.v1')
      if (!scope) return []
      return new Promise<string[]>((resolvePaths, reject) => {
        const request = indexedDB.open('draftmatter-project-assets-v1', 1)
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const database = request.result
          const transaction = database.transaction('projects', 'readonly')
          const read = transaction.objectStore('projects').get(scope)
          transaction.oncomplete = () => { database.close(); resolvePaths((read.result ?? []).map((image: { path: string }) => image.path)) }
          transaction.onerror = () => { database.close(); reject(transaction.error) }
        }
      })
    })
    expect(restoredImagePaths).toContain(path)
    expect(await page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')).toContain(path)
    await testInfo.attach('restored-figure-storage', { body: JSON.stringify({ sourcePath: path, storedImagePaths: restoredImagePaths, renderedSrc: await renderedFigure.getAttribute('src') }), contentType: 'application/json' })
    await expect.poll(() => renderedFigure.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
    const artifactsDirectory = resolve('test-results/writing-workspace')
    await mkdir(artifactsDirectory, { recursive: true })
    await page.screenshot({ path: resolve(artifactsDirectory, 'toolbar-and-manuscript.png') })
    await expect(manuscript.locator('.structured-figure-label')).toContainText('Figure 1')
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Files', exact: true }).click()
    const files = page.getByRole('complementary', { name: 'Project files', exact: true })
    await files.getByRole('button', { name: 'Expand figures', exact: true }).click()
    const imageFile = files.getByRole('button', { name: `Select ${path}`, exact: true })
    await expect(imageFile).toBeVisible()
    await imageFile.click()
    const selected = files.getByRole('region', { name: 'Selected project file', exact: true })
    await expect(selected).toContainText('This browser')
    await expect(selected.getByRole('button', { name: `Download ${path}`, exact: true })).toBeVisible()
    await page.screenshot({ path: resolve(artifactsDirectory, 'project-files.png') })
  })

  test('drops an image at the paragraph pointer and preserves the text before and after it', async ({ page }) => {
    const dropSource = '# Image drop study\n\n## Results\n\nText before the drop. Text after the drop.\n\nFinal paragraph stays after both.\n'
    await page.addInitScript((portableSource) => {
      localStorage.setItem('draftmatter.structured-source.v1', portableSource)
      localStorage.setItem('draftmatter.structured-mode.v1', 'true')
    }, dropSource)
    await page.goto('/draft')
    const manuscript = page.getByRole('article', { name: 'Editable manuscript' })
    const paragraph = manuscript.getByText('Text before the drop. Text after the drop.', { exact: true })
    await expect(paragraph).toBeVisible()
    // Leave the text selection elsewhere: the image must follow the drop pointer.
    await manuscript.getByRole('heading', { name: 'Results', exact: true }).click()
    const point = await paragraph.evaluate((element) => {
      const text = element.firstChild!
      const boundary = text.textContent!.indexOf('Text after the drop.')
      const range = document.createRange()
      range.setStart(text, boundary)
      range.collapse(true)
      const bounds = range.getBoundingClientRect()
      return { x: bounds.left + .1, y: bounds.top + bounds.height / 2 }
    })
    const transfer = await page.evaluateHandle((svg) => {
      const data = new DataTransfer()
      data.items.add(new File([svg], 'dropped-response.svg', { type: 'image/svg+xml' }))
      return data
    }, figure.toString('utf8'))
    await paragraph.dispatchEvent('drop', { dataTransfer: transfer, clientX: point.x, clientY: point.y })
    const renderedFigure = manuscript.getByRole('img', { name: 'dropped response', exact: true })
    await expect(renderedFigure).toBeVisible()
    await expect.poll(() => renderedFigure.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
    await expect.poll(() => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')).toMatch(/figures\/dropped-response-[a-f\d]{8}\.svg/)
    const portable = await page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')
    const before = portable.indexOf('Text before the drop.')
    const image = portable.indexOf('![dropped response](figures/dropped-response-')
    const after = portable.indexOf('Text after the drop.')
    expect(before).toBeGreaterThan(-1)
    expect(image).toBeGreaterThan(before)
    expect(after).toBeGreaterThan(image)
    expect(portable.indexOf('Final paragraph stays after both.')).toBeGreaterThan(after)
    expect(portable).not.toContain('data:image')
    await transfer.dispose()
  })

  test('exports an imported WebP to Word with a PNG fallback and its original aspect ratio', async ({ page }) => {
    await page.addInitScript((portableSource) => {
      localStorage.setItem('draftmatter.structured-source.v1', portableSource)
      localStorage.setItem('draftmatter.structured-mode.v1', 'true')
      localStorage.setItem('draftmatter.citations.v1', '[]')
    }, source)
    await page.goto('/draft')
    const webp = await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 96; canvas.height = 32
      canvas.getContext('2d')!.fillRect(0, 0, 96, 32)
      const url = canvas.toDataURL('image/webp')
      if (!url.startsWith('data:image/webp;')) throw new Error('The test browser did not encode WebP.')
      return url.split(',')[1]
    })
    await page.getByText('The observed response belongs here.', { exact: true }).click()
    await page.getByRole('button', { name: 'Insert', exact: true }).click()
    await page.locator('.toolbar-insert-menu').getByRole('button', { name: /^Figure/ }).click()
    const insertion = page.getByRole('dialog', { name: 'Insert figure', exact: true })
    await insertion.getByLabel('Choose figure image').setInputFiles({ name: 'wide-result.webp', mimeType: 'image/webp', buffer: Buffer.from(webp, 'base64') })
    await insertion.getByRole('button', { name: 'Insert', exact: true }).click()
    await expect(insertion).toBeHidden()
    await page.getByRole('button', { name: 'Export', exact: true }).click()
    await page.getByRole('button', { name: /Word document/ }).click()
    const destination = page.getByRole('dialog', { name: 'Save clean Word document', exact: true })
    const downloadEvent = page.waitForEvent('download')
    await destination.getByRole('button', { name: 'Choose location…', exact: true }).click()
    const downloadPath = await (await downloadEvent).path()
    const files = storedZipFiles(await readFile(downloadPath!))
    const png = files.get('word/media/image1.png')!
    expect(png, 'Word receives a compatible PNG image').toBeDefined()
    expect(png.readUInt32BE(16) / png.readUInt32BE(20)).toBe(3)
    const document = files.get('word/document.xml')!.toString('utf8')
    const extent = document.match(/<wp:extent cx="(\d+)" cy="(\d+)"/)
    expect(Number(extent?.[1]) / Number(extent?.[2])).toBeCloseTo(3, 4)
  })

  test('downloads a complete example project with data, figures, references, and configuration', async ({ page }) => {
    await page.goto('/draft')
    await page.locator('.project-switcher').click()
    await page.getByRole('button', { name: /Open complete example/ }).click()
    await expect(page.locator('.project-switcher-name')).toHaveText('Complete example paper')
    await page.getByRole('button', { name: 'Export', exact: true }).click()
    await page.getByText('Advanced options', { exact: true }).click()
    await page.getByRole('button', { name: /Project source/ }).click()
    const dialog = page.getByRole('dialog', { name: 'Save project with figures and references', exact: true })
    await expect(dialog.getByLabel('File name')).toHaveValue('complete-example.project.zip')
    const downloadEvent = page.waitForEvent('download')
    await dialog.getByRole('button', { name: 'Choose location…', exact: true }).click()
    const download = await downloadEvent
    expect(download.suggestedFilename()).toBe('complete-example.project.zip')
    const downloadPath = await download.path()
    expect(downloadPath).not.toBeNull()
    const bytes = await readFile(downloadPath!)
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    const files = storedZipFiles(bytes)
    for (const path of ['.draftmatter/project.json', 'complete-example.qmd', 'references.json', 'data/canopy.csv', 'data/allocation.csv', 'data/model-predictions.csv', 'figures/python-canopy.svg', 'figures/r-allocation.svg', 'figures/julia-model.svg']) {
      expect(files.has(path), `${path} should be included`).toBe(true)
      expect(files.get(path)!.length).toBeGreaterThan(0)
    }
    const config = JSON.parse(files.get('.draftmatter/project.json')!.toString('utf8'))
    expect(config).toMatchObject({ schemaVersion: 1, name: 'Complete example paper', mainDocument: 'complete-example.qmd' })
    const manuscript = files.get(config.mainDocument)!.toString('utf8')
    expect(manuscript).toContain('figures/python-canopy.svg')
    expect(manuscript).toContain('bibliography: references.json')
    expect(manuscript).not.toContain('data:image')
    expect(JSON.parse(files.get('references.json')!.toString('utf8'))).toHaveLength(2)
  })
})
