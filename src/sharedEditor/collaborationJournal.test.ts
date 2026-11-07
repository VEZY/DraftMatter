import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { collaborationJournalKey, createCollaborationJournal, retainCollaborativeDocument, type CollaborationJournal } from './collaborationJournal'

afterEach(() => vi.unstubAllGlobals())

describe('collaboration crash and offline recovery', () => {
  it('restores offline text and CRDT history after closing, then merges with remote edits exactly once', async () => {
    let disk: Uint8Array | undefined
    const journal: CollaborationJournal = { load: async () => disk, save: async (bytes) => { disk = bytes.slice() } }
    const remote = new Y.Doc()
    remote.getText('paper').insert(0, 'Original')
    const offline = new Y.Doc()
    Y.applyUpdate(offline, Y.encodeStateAsUpdate(remote))
    const first = await retainCollaborativeDocument(offline, journal, () => {})
    offline.getText('paper').insert(8, ' local')
    await first.flush()
    first.close(); offline.destroy()
    remote.getText('paper').insert(0, 'Remote ')
    const reopened = new Y.Doc()
    const second = await retainCollaborativeDocument(reopened, journal, () => {})
    expect(second.recovered).toBe(true)
    Y.applyUpdate(reopened, Y.encodeStateAsUpdate(remote))
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(reopened))
    expect(remote.getText('paper').toString()).toBe('Remote Original local')
    expect(reopened.getText('paper').toString()).toBe(remote.getText('paper').toString())
    await second.flush()
    second.close(); reopened.destroy(); remote.destroy()
  })

  it('keeps storage failures visible and blocks unsafe closure until a successful retry', async () => {
    let fail = true
    const errors: string[] = []
    const doc = new Y.Doc()
    const retained = await retainCollaborativeDocument(doc, { load: async () => undefined, save: async () => { if (fail) throw new Error('Full disk') } }, (message) => errors.push(message))
    doc.getText('paper').insert(0, 'Keep me')
    await retained.flush()
    expect(retained.unsafeToClose).toBe(true)
    expect(errors).toHaveLength(1)
    fail = false
    await retained.flush() // Retry persistence without requiring an unrelated edit.
    expect(retained.unsafeToClose).toBe(false)
    retained.close(); doc.destroy()
  })

  it('merges independent journal writers instead of overwriting another offline branch', async () => {
    const disk = new Map<string, string>()
    vi.stubGlobal('indexedDB', undefined)
    vi.stubGlobal('localStorage', { getItem: (key: string) => disk.get(key) ?? null, setItem: (key: string, value: string) => disk.set(key, value) })
    const left = new Y.Doc()
    const right = new Y.Doc()
    left.getText('paper').insert(0, 'Left branch.')
    right.getText('paper').insert(0, 'Right branch.')
    const key = collaborationJournalKey('wss://test', 'lab', 'paper', 'alice')
    const first = createCollaborationJournal(key)
    const second = createCollaborationJournal(key)
    await Promise.all([first.save(Y.encodeStateAsUpdate(left)), second.save(Y.encodeStateAsUpdate(right))])
    const recovered = new Y.Doc()
    Y.applyUpdate(recovered, (await first.load())!)
    expect(recovered.getText('paper').toString()).toContain('Left branch.')
    expect(recovered.getText('paper').toString()).toContain('Right branch.')
    left.destroy(); right.destroy(); recovered.destroy()
  })

  it('compacts superseded figure payloads while preserving current resources and CRDT clocks', async () => {
    const disk = new Map<string, string>()
    vi.stubGlobal('indexedDB', undefined)
    vi.stubGlobal('localStorage', { getItem: (key: string) => disk.get(key) ?? null, setItem: (key: string, value: string) => disk.set(key, value) })
    const doc = new Y.Doc()
    const journal = createCollaborationJournal('replaced-figures')
    const payload = 'x'.repeat(512 * 1024)
    for (let index = 0; index < 40; index += 1) {
      doc.getMap('resources').set('figure', `${index}:${payload}`)
      await journal.save(Y.encodeStateAsUpdate(doc))
      expect((await journal.load())!.byteLength).toBeLessThan(600 * 1024)
    }
    const recovered = new Y.Doc()
    Y.applyUpdate(recovered, (await journal.load())!)
    expect(recovered.getMap('resources').get('figure')).toBe(`39:${payload}`)
    expect(Y.encodeStateVector(recovered)).toEqual(Y.encodeStateVector(doc))
    doc.destroy(); recovered.destroy()
  })

  it('preserves the previous journal when storage quota rejects a newer state', async () => {
    const disk = new Map<string, string>()
    let full = false
    vi.stubGlobal('indexedDB', undefined)
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => disk.get(key) ?? null,
      setItem: (key: string, value: string) => { if (full) throw new Error('Quota exceeded'); disk.set(key, value) },
    })
    const doc = new Y.Doc()
    const journal = createCollaborationJournal('quota-test')
    doc.getText('paper').insert(0, 'Saved work.')
    await journal.save(Y.encodeStateAsUpdate(doc))
    const original = [...disk.entries()]
    full = true
    doc.getText('paper').insert(0, 'New ')
    await expect(journal.save(Y.encodeStateAsUpdate(doc))).rejects.toThrow(/Quota/)
    expect([...disk.entries()]).toEqual(original)
    const reopened = new Y.Doc()
    Y.applyUpdate(reopened, (await journal.load())!)
    expect(reopened.getText('paper').toString()).toBe('Saved work.')
    doc.destroy(); reopened.destroy()
  })

  it('separates recoveries by service, project and authenticated account', () => {
    const key = collaborationJournalKey('wss://a', 'lab', 'paper', 'alice')
    expect(key).not.toBe(collaborationJournalKey('wss://a', 'lab', 'paper', 'bob'))
    expect(key).not.toBe(collaborationJournalKey('wss://b', 'lab', 'paper', 'alice'))
    expect(key).not.toBe(collaborationJournalKey('wss://a', 'lab', 'other', 'alice'))
  })
})
