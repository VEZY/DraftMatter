import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { PROJECT_FILE_CHUNK_BYTES, PROJECT_FILE_QUOTA_BYTES, type ProjectFile, type ProjectFileUpload } from '../../src/collaboration/projectFiles'

test('uploads bounded parts, pauses across a reload, rejects a different file, resumes and downloads verified bytes', async ({ page }, testInfo) => {
  const input = Buffer.alloc(PROJECT_FILE_CHUNK_BYTES + 64, 7)
  let upload: ProjectFileUpload | undefined
  let file: ProjectFile | undefined
  const parts = new Map<number, Buffer>()
  const requestSizes: number[] = []
  let secondWaiting = false
  let releaseSecond!: () => void
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve })
  let holdSecond = true
  const api = '/api/workspaces/lab/projects/paper/files'
  await page.route('**/api/workspaces/lab/projects/paper/files**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.slice(api.length)
    const method = request.method()
    expect(await request.headerValue('authorization')).toBe('Bearer project-files-browser-test')
    if (!path) return route.fulfill({ json: { files: file ? [file] : [], uploads: upload?.status === 'uploading' ? [upload] : [], quota: { limitBytes: PROJECT_FILE_QUOTA_BYTES, usedBytes: file?.size ?? 0, reservedBytes: upload?.status === 'uploading' ? upload.size : 0 } } })
    if (path === '/uploads' && method === 'POST') {
      upload = { ...request.postDataJSON(), id: 'upload-one', createdBy: 'alice', createdAt: '2026-11-11T10:00:00Z', updatedAt: '2026-11-11T10:00:00Z', status: 'uploading', chunkSize: PROJECT_FILE_CHUNK_BYTES, parts: [] }
      return route.fulfill({ status: 201, json: upload })
    }
    if (path === '/uploads/upload-one' && method === 'GET') return route.fulfill({ json: upload })
    const uploading = path.match(/^\/uploads\/upload-one\/parts\/(\d+)$/)
    if (uploading) {
      const bytes = request.postDataBuffer()!
      requestSizes.push(bytes.length)
      expect(bytes.length).toBeLessThanOrEqual(PROJECT_FILE_CHUNK_BYTES)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      expect(await request.headerValue('x-draftmatter-sha256')).toBe(sha256)
      const partNumber = Number(uploading[1])
      if (partNumber === 2 && holdSecond) {
        secondWaiting = true
        await secondGate
        await route.abort('aborted').catch(() => {})
        return
      }
      parts.set(partNumber, bytes)
      upload!.parts = [...upload!.parts.filter((part) => part.partNumber !== partNumber), { partNumber, size: bytes.length, sha256 }].sort((left, right) => left.partNumber - right.partNumber)
      return route.fulfill({ json: upload })
    }
    if (path === '/uploads/upload-one/complete') {
      expect(parts.size).toBe(2)
      upload!.status = 'completed'
      file = { id: 'file-version-one', path: upload!.path, size: upload!.size, mediaType: upload!.mediaType, createdBy: upload!.createdBy, createdAt: upload!.createdAt, chunkSize: upload!.chunkSize, parts: [...upload!.parts] }
      return route.fulfill({ json: file })
    }
    const downloading = path.match(/^\/file-version-one\/parts\/(\d+)$/)
    if (downloading) {
      const partNumber = Number(downloading[1])
      return route.fulfill({ body: parts.get(partNumber), contentType: 'application/octet-stream', headers: { 'x-draftmatter-sha256': file!.parts.find((part) => part.partNumber === partNumber)!.sha256 } })
    }
    throw new Error(`Unexpected file route ${method} ${path}`)
  })
  await page.goto('/tests/fixtures/project-files.html')
  await page.getByRole('button', { name: /Shared data files/ }).click()
  await page.getByLabel('Choose a data file', { exact: true }).setInputFiles({ name: 'input.csv', mimeType: 'text/csv', buffer: input })
  await page.getByRole('button', { name: 'Upload new version', exact: true }).click()
  await expect.poll(() => secondWaiting).toBe(true)
  await page.getByRole('button', { name: 'Pause upload', exact: true }).click()
  await expect(page.getByText('Upload paused.', { exact: false })).toBeVisible()
  releaseSecond(); holdSecond = false
  expect(upload!.parts).toHaveLength(1)

  await page.reload()
  await page.getByRole('button', { name: /Shared data files/ }).click()
  await expect(page.getByRole('heading', { name: 'Unfinished uploads · 1' })).toBeVisible()
  const chooseOriginal = async (buffer: Buffer) => {
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Resume upload of data/input.csv', exact: true }).click()
    await (await chooser).setFiles({ name: 'input.csv', mimeType: 'text/csv', buffer })
  }
  const different = Buffer.from(input); different[0] = 99
  await chooseOriginal(different)
  await expect(page.getByRole('alert')).toContainText('different file')
  expect(requestSizes).toHaveLength(2)
  await chooseOriginal(input)
  await expect(page.getByText('Saved a new version of data/input.csv.', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Files and versions · 1' })).toBeVisible()
  expect(requestSizes).toEqual([PROJECT_FILE_CHUNK_BYTES, 64, 64])

  const handoff = page.waitForEvent('download')
  await page.getByRole('button', { name: /^Download data\/input.csv/ }).click()
  const downloaded = await handoff
  expect(downloaded.suggestedFilename()).toBe('input.csv')
  expect(createHash('sha256').update(await readFile((await downloaded.path())!)).digest('hex')).toBe(createHash('sha256').update(input).digest('hex'))
  await expect(page.getByText('Download started for data/input.csv.', { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('project-files-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('button', { name: 'Refresh files', exact: true })).toBeVisible()
  expect(await page.locator('.project-files-panel').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('project-files-mobile.png'), fullPage: true })
})
