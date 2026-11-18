/** The public example is a fresh, disconnected copy for each browser tab. */
export function isBrowserDemoLocation(location: Pick<Location, 'pathname'>): boolean {
  return location.pathname === '/demo' || location.pathname === '/demo/'
}

export function createMemoryStorage(): Storage {
  const entries = new Map<string, string>()
  return {
    get length() { return entries.size },
    clear() { entries.clear() },
    getItem(key) { return entries.get(String(key)) ?? null },
    key(index) { return [...entries.keys()][Number(index) >>> 0] ?? null },
    removeItem(key) { entries.delete(String(key)) },
    setItem(key, value) { entries.set(String(key), String(value)) },
  }
}

/**
 * Call before importing the application on /demo. Do not inspect or seed from
 * the real Storage objects: they can contain a visitor's private browser draft
 * or an unfinished sign-in. Disable IndexedDB too so figure imports and recovery
 * journals use their existing Storage fallback in memory rather than a real
 * database. Failure must prevent the application from mounting.
 */
export function installBrowserDemoStorage(target: object = window): { localStorage: Storage; sessionStorage: Storage } {
  const names = ['localStorage', 'sessionStorage', 'indexedDB'] as const
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(target, name)
    if (descriptor && !descriptor.configurable) throw new Error('The example cannot isolate browser storage.')
  }
  const storage = { localStorage: createMemoryStorage(), sessionStorage: createMemoryStorage() }
  Object.defineProperties(target, {
    localStorage: { configurable: true, enumerable: true, value: storage.localStorage },
    sessionStorage: { configurable: true, enumerable: true, value: storage.sessionStorage },
    indexedDB: { configurable: true, enumerable: true, value: undefined },
  })
  return storage
}
