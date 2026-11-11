import { expect, test } from '@playwright/test'

test('real OPFS survives reload, rehashes corrupted parts, ignores progress hints, and isolates another account', async ({ page }) => {
  await page.goto('/tests/fixtures/project-files.html')
  const interrupted = await page.evaluate(async () => {
    const { downloadProjectFile, projectFileScopeKey } = await import('/src/collaboration/projectFileDownload.ts')
    const chunk = 8 * 1024 * 1024, first = new Uint8Array(chunk).fill(42), last = new TextEncoder().encode('end')
    const digest = async (value: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', value)), (byte) => byte.toString(16).padStart(2, '0')).join('')
    const file = { id: 'opfs-version', path: 'data/input.csv', size: chunk + 3, chunkSize: chunk, mediaType: 'text/csv', createdAt: '2026-11-11T00:00:00Z', createdBy: 'alice', parts: [{ partNumber: 1, size: chunk, sha256: await digest(first) }, { partNumber: 2, size: 3, sha256: await digest(last) }] }
    try {
      await downloadProjectFile({ file, scopeKey: projectFileScopeKey({ serviceUrl: location.origin, userId: 'alice', workspaceId: 'lab', projectId: 'paper', fileId: file.id }), readPart: async (number) => { if (number === 1) return first; throw new Error('Connection interrupted') } })
    } catch (error) { return String(error) }
    return 'unexpected-success'
  })
  expect(interrupted).toContain('Connection interrupted')
  await page.reload()
  const result = await page.evaluate(async () => {
    const { downloadProjectFile, projectFileScopeKey } = await import('/src/collaboration/projectFileDownload.ts')
    const chunk = 8 * 1024 * 1024, first = new Uint8Array(chunk).fill(42), last = new TextEncoder().encode('end')
    const digest = async (value: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', value)), (byte) => byte.toString(16).padStart(2, '0')).join('')
    const file = { id: 'opfs-version', path: 'data/input.csv', size: chunk + 3, chunkSize: chunk, mediaType: 'text/csv', createdAt: '2026-11-11T00:00:00Z', createdBy: 'alice', parts: [{ partNumber: 1, size: chunk, sha256: await digest(first) }, { partNumber: 2, size: 3, sha256: await digest(last) }] }
    const downloads = await (await navigator.storage.getDirectory()).getDirectoryHandle('draftmatter-downloads')
    let cached: FileSystemDirectoryHandle | undefined
    for await (const handle of (downloads as FileSystemDirectoryHandle & { values(): AsyncIterable<FileSystemDirectoryHandle> }).values()) { cached = handle; break }
    const corrupt = await (await cached!.getFileHandle('part-1')).createWritable(); await corrupt.write(new Uint8Array(chunk).fill(13)); await corrupt.close()
    const forged = await (await cached!.getFileHandle('progress.json')).createWritable(); await forged.write('{"completedParts":[1,2]}'); await forged.close()
    const reads: number[] = []; let saved: Blob | undefined; let oversizedReadAttempts = 0
    const original = Blob.prototype.arrayBuffer
    Blob.prototype.arrayBuffer = function () { if (this.size > chunk) { oversizedReadAttempts++; throw new Error('A whole file must never enter a byte buffer') }; return original.call(this) }
    let download
    try {
      download = await downloadProjectFile({ file, scopeKey: projectFileScopeKey({ serviceUrl: location.origin, userId: 'alice', workspaceId: 'lab', projectId: 'paper', fileId: file.id }), readPart: async (number) => { reads.push(number); return number === 1 ? first : last } }, { saveBlob: (blob) => { saved = blob } })
    } finally { Blob.prototype.arrayBuffer = original }
    // Reusing a completed file must not rewrite it: a previous browser download
    // may still be consuming the first disk-backed File snapshot.
    const originalSnapshot = saved!
    const repeated = await downloadProjectFile({ file, scopeKey: projectFileScopeKey({ serviceUrl: location.origin, userId: 'alice', workspaceId: 'lab', projectId: 'paper', fileId: file.id }), readPart: async () => { throw new Error('A complete verified cache must not fetch again') } }, { saveBlob: () => {} })
    const originalSnapshotTail = await originalSnapshot.slice(chunk).text()
    let otherAccountReads = 0
    try {
      await downloadProjectFile({ file, scopeKey: projectFileScopeKey({ serviceUrl: location.origin, userId: 'bob', workspaceId: 'lab', projectId: 'paper', fileId: file.id }), readPart: async () => { otherAccountReads++; throw new Error('Stop after verifying account isolation') } })
    } catch { /* Another account must fetch its own authorized parts. */ }
    return { status: download!.status, reads, size: saved!.size, isDiskFile: saved instanceof File, tail: await saved!.slice(chunk).text(), oversizedReadAttempts, otherAccountReads, repeatedParts: repeated.resumedParts, originalSnapshotTail }
  })
  expect(result).toEqual({ status: 'download-started', reads: [1, 2], size: 8 * 1024 * 1024 + 3, isDiskFile: true, tail: 'end', oversizedReadAttempts: 0, otherAccountReads: 1, repeatedParts: 2, originalSnapshotTail: 'end' })
})
