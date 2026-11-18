import { describe, expect, it, vi } from 'vitest'
import { createMemoryStorage, installBrowserDemoStorage, isBrowserDemoLocation } from './browserDemo'

describe('anonymous browser example isolation', () => {
  it.each(['/demo', '/demo/'])('recognizes only the public demo entry %s', (pathname) => {
    expect(isBrowserDemoLocation({ pathname })).toBe(true)
  })

  it.each(['/', '/draft', '/demo/project', '/demo//', '/demonstration', '/workspace/demo'])('does not isolate another route %s', (pathname) => {
    expect(isBrowserDemoLocation({ pathname })).toBe(false)
  })

  it('never reads real browser drafts or pending identity state', () => {
    const localStorage = vi.fn(() => { throw new Error('Private browser draft must not be read') })
    const sessionStorage = vi.fn(() => { throw new Error('Pending login must not be read') })
    const indexedDB = vi.fn(() => { throw new Error('Private project assets must not be read') })
    const target = Object.defineProperties({}, {
      localStorage: { configurable: true, get: localStorage },
      sessionStorage: { configurable: true, get: sessionStorage },
      indexedDB: { configurable: true, get: indexedDB },
    }) as { localStorage: Storage; sessionStorage: Storage; indexedDB?: IDBFactory }
    installBrowserDemoStorage(target)
    expect(localStorage).not.toHaveBeenCalled()
    expect(sessionStorage).not.toHaveBeenCalled()
    expect(indexedDB).not.toHaveBeenCalled()
    expect(target.indexedDB).toBeUndefined()
    expect(target.localStorage.length).toBe(0)
    expect(target.sessionStorage.length).toBe(0)
    target.localStorage.setItem('draftmatter.structured-source.v1', 'Example edit')
    expect(target.sessionStorage.getItem('draftmatter.structured-source.v1')).toBeNull()
  })

  it('keeps the visitor original storage unchanged and starts a fresh copy on each install', () => {
    const original = createMemoryStorage()
    original.setItem('draftmatter.structured-source.v1', 'Private manuscript')
    const target = { localStorage: original, sessionStorage: createMemoryStorage() }
    const first = installBrowserDemoStorage(target)
    first.localStorage.setItem('draftmatter.structured-source.v1', 'Edited demo manuscript')
    first.sessionStorage.setItem('pending-login', 'Demo value')
    const second = installBrowserDemoStorage(target)
    expect(second.localStorage.getItem('draftmatter.structured-source.v1')).toBeNull()
    expect(second.sessionStorage.getItem('pending-login')).toBeNull()
    expect(original.getItem('draftmatter.structured-source.v1')).toBe('Private manuscript')
  })

  it('fails before replacing either storage when isolation is unavailable', () => {
    const original = createMemoryStorage()
    const target = Object.defineProperties({}, {
      localStorage: { configurable: true, value: original },
      sessionStorage: { configurable: false, value: createMemoryStorage() },
    }) as { localStorage: Storage; sessionStorage: Storage }
    expect(() => installBrowserDemoStorage(target)).toThrow('cannot isolate browser storage')
    expect(target.localStorage).toBe(original)
  })

  it('supports ordinary storage reads, replacement, removal and enumeration', () => {
    const storage = createMemoryStorage()
    storage.setItem('draft', 'first')
    storage.setItem('draft', 'revised')
    storage.setItem('settings', 'true')
    expect(storage.length).toBe(2)
    expect(storage.getItem('draft')).toBe('revised')
    expect(storage.key(0)).toBe('draft')
    expect(storage.key(1)).toBe('settings')
    expect(storage.key(2)).toBeNull()
    storage.removeItem('draft')
    expect(storage.getItem('draft')).toBeNull()
    storage.clear()
    expect(storage.length).toBe(0)
  })
})
