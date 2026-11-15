// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readBrowserProjectImages, saveBrowserProjectImages } from './browserProjectAssets'
import { MAX_PROJECT_RESOURCE_BYTES, sharedImage } from './sharedEditor/projectResources'

const prefix = 'draftmatter.browser-project-assets.v1:'
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const image = sharedImage('figures/growth.png', png)

/** Deliberately separates request success from transaction commit/abort. */
function indexedDatabase(value?: unknown) {
  const transactions: Array<{
    oncomplete: null | (() => void); onabort: null | (() => void); onerror: null | (() => void)
    error: Error | null; put: ReturnType<typeof vi.fn>; objectStore: ReturnType<typeof vi.fn>
  }> = []
  const db = {
    close: vi.fn(), onversionchange: null as null | (() => void),
    objectStoreNames: { contains: () => true }, createObjectStore: vi.fn(),
    transaction: vi.fn(() => {
      const request = { result: value, error: null, onsuccess: null as null | (() => void), onerror: null as null | (() => void) }
      const put = vi.fn()
      const transaction = {
        oncomplete: null as null | (() => void), onabort: null as null | (() => void), onerror: null as null | (() => void), error: null as Error | null,
        abort: vi.fn(),
        put, objectStore: vi.fn(() => ({ get: vi.fn(() => { queueMicrotask(() => request.onsuccess?.()); return request }), put })),
      }
      transactions.push(transaction)
      return transaction
    }),
  }
  const open = vi.fn(() => {
    const request = { result: db, onsuccess: null as null | (() => void), onerror: null, onupgradeneeded: null, onblocked: null }
    queueMicrotask(() => request.onsuccess?.())
    return request
  })
  vi.stubGlobal('indexedDB', { open })
  return { db, transactions }
}

describe('durable browser project figures', () => {
  beforeEach(() => { localStorage.clear(); vi.stubGlobal('indexedDB', undefined) })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear() })

  it('restores image bytes across reloads and keeps project scopes separate', async () => {
    expect(await readBrowserProjectImages('empty')).toEqual([])
    await saveBrowserProjectImages('study-one', [image])
    expect(await readBrowserProjectImages('study-one')).toEqual([image])
    expect(await readBrowserProjectImages('study-two')).toEqual([])
    await saveBrowserProjectImages('study-two', [sharedImage('figures/other.png', png)])
    expect(await readBrowserProjectImages('study-one')).toEqual([image])
  })

  it('rejects corrupt or unsafe saved images without overwriting their stored evidence', async () => {
    for (const invalid of ['{broken', '{}', JSON.stringify([image, image]), JSON.stringify([{ ...image, path: '../outside.png' }]), JSON.stringify([{ ...image, base64: 'broken!' }]), JSON.stringify([{ ...image, mimeType: 'image/svg+xml' }])]) {
      localStorage.setItem(prefix + 'study', invalid)
      await expect(readBrowserProjectImages('study')).rejects.toThrow()
      expect(localStorage.getItem(prefix + 'study')).toBe(invalid)
    }
  })

  it('merges imports from stale callers and rejects changes to an existing immutable path', async () => {
    const other = sharedImage('figures/other.png', png)
    await saveBrowserProjectImages('study', [image])
    expect(await saveBrowserProjectImages('study', [other])).toEqual([image, other])
    expect(await readBrowserProjectImages('study')).toEqual([image, other])
    const changed = sharedImage(image.path, new Uint8Array([...png, 1]))
    await expect(saveBrowserProjectImages('study', [changed])).rejects.toThrow('different saved contents')
    expect(await readBrowserProjectImages('study')).toEqual([image, other])
  })

  it('rejects an over-limit save or storage quota failure while retaining the previous catalogue', async () => {
    await saveBrowserProjectImages('study', [image])
    const oversized = { ...image, base64: 'a'.repeat(MAX_PROJECT_RESOURCE_BYTES) }
    await expect(saveBrowserProjectImages('study', [oversized])).rejects.toThrow('8 MB figure limit')
    expect(await readBrowserProjectImages('study')).toEqual([image])
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError') })
    await expect(saveBrowserProjectImages('study', [])).rejects.toThrow('Full')
    expect(await readBrowserProjectImages('study')).toEqual([image])
  })

  it('waits for the IndexedDB commit before reporting a save and snapshots caller data', async () => {
    const { db, transactions } = indexedDatabase()
    const images = [image]
    let completed = false
    const saving = saveBrowserProjectImages('study', images).then(() => { completed = true })
    images.length = 0
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(transactions).toHaveLength(1)
    expect(transactions[0].put).toHaveBeenCalledWith([image], 'study')
    expect(completed).toBe(false)
    transactions[0].oncomplete?.()
    await saving
    expect(completed).toBe(true)
    expect(db.close).toHaveBeenCalledOnce()
  })

  it('reports aborted transactions and validates data read from IndexedDB', async () => {
    const first = indexedDatabase()
    const saving = saveBrowserProjectImages('study', [image])
    const rejected = expect(saving).rejects.toThrow('cancelled')
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    first.transactions[0].onabort?.()
    await rejected
    expect(first.db.close).toHaveBeenCalledOnce()

    const second = indexedDatabase([{ ...image, base64: 'invalid' }])
    const reading = readBrowserProjectImages('study')
    const invalid = expect(reading).rejects.toThrow('invalid image')
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    second.transactions[0].oncomplete?.()
    await invalid
    expect(second.db.close).toHaveBeenCalledOnce()
  })
})
