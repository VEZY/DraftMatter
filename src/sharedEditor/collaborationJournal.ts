import * as Y from 'yjs'
import { base64ToBytes, bytesToBase64 } from './projectResources'

const MAX_STATE_BYTES = 16 * 1024 * 1024
export interface CollaborationJournal { load(): Promise<Uint8Array | undefined>; save(state: Uint8Array): Promise<void> }

export function collaborationJournalKey(service: string, workspace: string, project: string, user: string) {
  return JSON.stringify([service, workspace, project, user])
}

function checkedState(value: unknown): Uint8Array | undefined {
  if (value === undefined) return undefined
  if (!(value instanceof Uint8Array) && !(value instanceof ArrayBuffer)) throw new Error('Offline recovery contains an unsupported record.')
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  if (bytes.byteLength > MAX_STATE_BYTES) throw new Error('Offline recovery exceeds the 16 MB limit.')
  return Uint8Array.from(bytes)
}

function mergedState(previous: unknown, next: Uint8Array) {
  const old = checkedState(previous)
  // Binary mergeUpdates retains overwritten resource payloads forever. Integrate
  // both branches in a GC-enabled document to retain clocks and live branches
  // while discarding the contents of tombstoned figures and references.
  const compacted = new Y.Doc({ gc: true })
  try {
    if (old) Y.applyUpdate(compacted, old)
    Y.applyUpdate(compacted, next)
    const merged = Y.encodeStateAsUpdate(compacted)
    if (merged.byteLength > MAX_STATE_BYTES) throw new Error('Offline recovery exceeds the 16 MB limit.')
    return merged
  } finally {
    compacted.destroy()
  }
}

export function createCollaborationJournal(key: string): CollaborationJournal {
  const storageKey = `draftmatter.collaboration.recovery.v1:${key}`
  if (typeof indexedDB === 'undefined') return {
    async load() {
      const saved = localStorage.getItem(storageKey)
      if (saved && saved.length > Math.ceil(MAX_STATE_BYTES / 3) * 4) throw new Error('Offline recovery exceeds the 16 MB limit.')
      return saved ? checkedState(base64ToBytes(saved)) : undefined
    },
    async save(state) {
      const copy = checkedState(state)!
      const write = () => {
        const saved = localStorage.getItem(storageKey)
        if (saved && saved.length > Math.ceil(MAX_STATE_BYTES / 3) * 4) throw new Error('Offline recovery exceeds the 16 MB limit.')
        localStorage.setItem(storageKey, bytesToBase64(mergedState(saved ? base64ToBytes(saved) : undefined, copy)))
      }
      // Older embedded browsers can lack IndexedDB. Use an origin-wide lock when
      // available; the synchronous read/merge/write also preserves same-tab writers.
      if (typeof navigator !== 'undefined' && navigator.locks) await navigator.locks.request(storageKey, write)
      else write()
    },
  }
  let database: Promise<IDBDatabase> | undefined
  function openDatabase() {
    if (!database) {
      const opening = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('draftmatter-collaboration-recovery', 1)
        let abandoned = false
        request.onupgradeneeded = () => request.result.createObjectStore('documents')
        request.onsuccess = () => {
          const db = request.result
          if (abandoned) { db.close(); return }
          db.onversionchange = () => { db.close(); database = undefined }
          resolve(db)
        }
        request.onerror = () => reject(new Error('Offline collaboration recovery could not be opened.'))
        request.onblocked = () => { abandoned = true; reject(new Error('Close other DraftMatter windows to open offline recovery.')) }
      })
      database = opening
      void opening.catch(() => { if (database === opening) database = undefined })
    }
    return database
  }
  async function operation(mode: IDBTransactionMode, value?: Uint8Array) {
    const db = await openDatabase()
    return new Promise<Uint8Array | undefined>((resolve, reject) => {
      const transaction = db.transaction('documents', mode)
      const store = transaction.objectStore('documents')
      const request = store.get(key)
      let result: Uint8Array | undefined
      request.onsuccess = () => {
        try {
          if (mode === 'readonly') result = checkedState(request.result)
          else {
            // Read, merge and write in ONE transaction. IndexedDB serializes these
            // across tabs, preserving independent offline branches for the same user.
            store.put(mergedState(request.result, value!), key)
          }
        } catch {
          transaction.abort()
        }
      }
      transaction.oncomplete = () => resolve(result)
      transaction.onabort = transaction.onerror = () => reject(new Error('Offline collaboration recovery could not be saved. Keep this window open.'))
    })
  }
  return {
    load: () => operation('readonly'),
    async save(state) {
      await operation('readwrite', checkedState(state)!)
    },
  }
}

/** A full CRDT journal preserves identity clocks, review decisions and offline edits across reloads. */
export async function retainCollaborativeDocument(document: Y.Doc, journal: CollaborationJournal, onError: (message: string) => void) {
  const recovered = await journal.load()
  if (recovered) {
    if (recovered.byteLength > MAX_STATE_BYTES) throw new Error('The offline recovery exceeds its size limit.')
    Y.applyUpdate(document, recovered, 'draftmatter-offline-recovery')
  }
  let pending = false
  let failed = false
  let queue = Promise.resolve()
  let latest: Uint8Array | undefined
  let failedState: Uint8Array | undefined
  const drain = () => {
    if (pending) return
    pending = true
    queue = queue.then(async () => {
      while (latest) {
        const state = latest
        latest = undefined
        try { await journal.save(state); failed = false; failedState = undefined } catch {
          failed = true
          failedState = state
          onError('Offline recovery could not be saved. Keep this window open until your changes synchronize.')
        }
      }
    }).finally(() => {
      pending = false
      if (latest) drain()
    })
  }
  const save = () => {
    // Coalesce bursts while a disk transaction is pending; keep at most two full states.
    latest = Y.encodeStateAsUpdate(document)
    drain()
  }
  document.on('update', save)
  return {
    recovered: Boolean(recovered),
    get unsafeToClose() { return pending || failed },
    async flush() {
      if (!pending && failedState) { latest = failedState; drain() }
      let flushing: Promise<void>
      do { flushing = queue; await flushing } while (flushing !== queue)
    },
    close() { document.off('update', save) },
  }
}
