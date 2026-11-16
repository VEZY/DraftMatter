import { describe, expect, it, vi } from 'vitest'
import { reviewedProjection } from './projections'
import { parsePortableDocument, sourceHash } from './document'
import { initialDraft } from './sampleDraft'
import { LEGACY_LOCAL_DRAFT_KEY, LOCAL_DRAFT_KEY, assertRecoverySnapshotDocument, normalizeRecoveryDocumentIdentity, readLocalDraft, readRecoveryPinnedSnapshotIds, readRecoverySnapshots, recoveryDocumentStorageKey, recoverySnapshotMatchesDocument, saveRecoverySnapshot, type KeyValueStorage, type RecoveryDocumentIdentity } from './storage'

function memoryStorage(): KeyValueStorage {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  }
}

function faultingStorage(existing: KeyValueStorage): KeyValueStorage {
  return {
    getItem: existing.getItem,
    setItem: () => { throw new DOMException('Storage quota exceeded', 'QuotaExceededError') },
  }
}

function quotaStorage(limit: number) {
  const values = new Map<string, string>()
  const storage: KeyValueStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      const next = new Map(values).set(key, value)
      if ([...next].reduce((total, [name, text]) => total + 2 * (name.length + text.length), 0) > limit) throw new DOMException('Storage quota exceeded', 'QuotaExceededError')
      values.set(key, value)
    },
  }
  return storage
}

describe('local storage and recovery journal', () => {
  it('reopens legacy local drafts until the release key is written', () => {
    const storage = memoryStorage()
    storage.setItem(LEGACY_LOCAL_DRAFT_KEY, '{"title":"Legacy draft"}')
    expect(readLocalDraft(storage)).toBe('{"title":"Legacy draft"}')

    storage.setItem(LOCAL_DRAFT_KEY, '{"title":"Current draft"}')
    expect(readLocalDraft(storage)).toBe('{"title":"Current draft"}')
  })

  it('deduplicates unchanged snapshots', () => {
    const storage = memoryStorage()
    const source = reviewedProjection(initialDraft)
    saveRecoverySnapshot(storage, initialDraft, 'paper.qmd', source, '2026-07-14T10:00:00.000Z')
    saveRecoverySnapshot(storage, initialDraft, 'paper.qmd', source, '2026-07-14T10:01:00.000Z')

    expect(readRecoverySnapshots(storage)).toHaveLength(1)
  })

  it('preserves distinct source text even when its short content hashes collide', () => {
    const storage = memoryStorage()
    expect(sourceHash('costarring')).toBe(sourceHash('liquid'))
    saveRecoverySnapshot(storage, initialDraft, 'paper.md', 'costarring', '2026-07-14T10:00:00.000Z')
    saveRecoverySnapshot(storage, initialDraft, 'paper.md', 'liquid', '2026-07-14T10:01:00.000Z')
    expect(readRecoverySnapshots(storage).map((snapshot) => snapshot.source)).toEqual(['liquid', 'costarring'])
  })

  it('keeps distinct recent versions below the automatic history budget', () => {
    const storage = memoryStorage()
    for (let index = 0; index < 10; index += 1) {
      const draft = { ...initialDraft, title: `Version ${index}` }
      saveRecoverySnapshot(storage, draft, 'paper.qmd', reviewedProjection(draft), `2026-07-14T10:${String(index).padStart(2, '0')}:00.000Z`)
    }

    const snapshots = readRecoverySnapshots(storage)
    expect(snapshots).toHaveLength(10)
    expect(snapshots[0].title).toBe('Version 9')
    expect(snapshots[9].title).toBe('Version 0')
  })

  it('retains the browser image catalogue identity with a recovered manuscript', () => {
    const storage = memoryStorage()
    const source = reviewedProjection(initialDraft)
    saveRecoverySnapshot(storage, initialDraft, 'paper.qmd', source, '2026-07-14T10:00:00.000Z', 'first-project-images')
    saveRecoverySnapshot(storage, initialDraft, 'paper.qmd', source, '2026-07-14T10:01:00.000Z', 'second-project-images')
    expect(readRecoverySnapshots(storage).map((snapshot) => snapshot.browserAssetScope)).toEqual(['second-project-images', 'first-project-images'])
  })

  it('ignores malformed or tampered recovery entries', () => {
    const storage = memoryStorage()
    const valid = saveRecoverySnapshot(storage, initialDraft, 'paper.qmd', reviewedProjection(initialDraft), '2026-07-14T10:00:00.000Z')[0]
    storage.setItem('draftmatter.recovery.v1', JSON.stringify([
      valid,
      { ...valid, id: 'tampered', source: `${valid.source}\nchanged` },
      { id: 'incomplete' },
      null,
    ]))

    expect(readRecoverySnapshots(storage)).toEqual([valid])
    storage.setItem('draftmatter.recovery.v1', '{broken json')
    expect(readRecoverySnapshots(storage)).toEqual([])
  })

  it('leaves the last valid journal intact when storage rejects a new snapshot', () => {
    const storage = memoryStorage()
    const source = reviewedProjection(initialDraft)
    const before = saveRecoverySnapshot(storage, initialDraft, 'paper.qmd', source, '2026-07-14T10:00:00.000Z')
    const revised = { ...initialDraft, title: 'A revision that exceeds quota' }

    expect(() => saveRecoverySnapshot(
      faultingStorage(storage),
      revised,
      'paper.qmd',
      reviewedProjection(revised),
      '2026-07-14T10:01:00.000Z',
    )).toThrow('Storage quota exceeded')
    expect(readRecoverySnapshots(storage)).toEqual(before)
  })

  it('migrates legacy arrays and bounds long-manuscript history by encoded bytes', () => {
    const values = new Map<string, string>()
    const storage: KeyValueStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    }
    const legacySource = reviewedProjection(initialDraft)
    const legacy = saveRecoverySnapshot(memoryStorage(), initialDraft, 'paper.qmd', legacySource, '2026-07-14T10:00:00.000Z')[0]
    values.set('draftmatter.recovery.v1', JSON.stringify([legacy]))

    for (let index = 1; index <= 8; index += 1) {
      const draft = { ...initialDraft, title: `Large ${index}`, abstract: `${index} ${'canopy response '.repeat(35_000)}` }
      saveRecoverySnapshot(storage, draft, 'paper.qmd', reviewedProjection(draft), `2026-07-14T10:${String(index).padStart(2, '0')}:00.000Z`)
    }

    const serialized = values.get('draftmatter.recovery.v1')!
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(4 * 1024 * 1024)
    expect(serialized.length * 2).toBeLessThanOrEqual(4 * 1024 * 1024)
    expect(JSON.parse(serialized)).toMatchObject({ schemaVersion: 2, texts: expect.any(Array), snapshots: expect.any(Array) })
    expect(readRecoverySnapshots(storage)[0].title).toBe('Large 8')
    expect(readRecoverySnapshots(storage).length).toBeGreaterThanOrEqual(1)
  })

  it('round trips a portable manuscript and all draft fields without storing its envelope source twice', () => {
    const storage = memoryStorage()
    const source = `---\ntitle: Recovery\n---\n\n# Recovery\n\n${'Éléments 🌿 and measurements. '.repeat(2_000)}\n`
    const draft = parsePortableDocument(source, initialDraft).draft
    const [saved] = saveRecoverySnapshot(storage, draft, 'paper.md', source)
    const [loaded] = readRecoverySnapshots(storage)
    expect(loaded).toEqual(saved)
    expect(loaded.draft).toEqual(draft)
    expect(loaded.source).toBe(source)
    const serialized = storage.getItem('draftmatter.recovery.v1')!
    expect(serialized.length).toBeLessThan(JSON.stringify({ snapshots: [saved] }).length * .7)
  })

  it('migrates a version-one journal and frees only older history when shared UTF-16 storage fills', () => {
    const storage = quotaStorage(300_000)
    storage.setItem('unrelated-preference', 'x'.repeat(30_000))
    const source = `${reviewedProjection(initialDraft)}\n${'canopy measurements '.repeat(1_400)}`
    const older = saveRecoverySnapshot(memoryStorage(), initialDraft, 'paper.qmd', source, '2026-07-14T10:00:00.000Z')[0]
    storage.setItem('draftmatter.recovery.v1', JSON.stringify({ schemaVersion: 1, snapshots: [older] }))
    for (let index = 1; index <= 8; index += 1) {
      const updatedSource = `${source}\nVersion ${index}`
      saveRecoverySnapshot(storage, initialDraft, 'paper.qmd', updatedSource, `2026-07-14T10:0${index}:00.000Z`)
    }
    const recovered = readRecoverySnapshots(storage)
    expect(recovered[0].source).toBe(`${source}\nVersion 8`)
    expect(recovered.length).toBeLessThan(8)
    expect(recovered.length).toBeGreaterThan(1)
    expect(storage.getItem('unrelated-preference')).toBe('x'.repeat(30_000))
  })

  it('preserves the selected restore target together with the current editor copy under quota pressure', () => {
    const storage = quotaStorage(180_000)
    const source = `${reviewedProjection(initialDraft)}\n${'data '.repeat(5_000)}`
    const [target] = saveRecoverySnapshot(storage, initialDraft, 'paper.qmd', source, '2026-07-14T10:00:00.000Z')
    for (let index = 1; index <= 3; index += 1) {
      saveRecoverySnapshot(storage, initialDraft, 'paper.qmd', `${source}\nVersion ${index}`, `2026-07-14T10:0${index}:00.000Z`, undefined, { preserveSnapshotId: target.id })
    }
    const current = `${source}\nThis is my unsaved editor copy`
    const recovered = saveRecoverySnapshot(storage, initialDraft, 'paper.qmd', current, '2026-07-14T10:04:00.000Z', undefined, { preserveSnapshotId: target.id })
    expect(recovered[0].source).toBe(current)
    expect(recovered.some((entry) => entry.id === target.id && entry.source === source)).toBe(true)
    expect(readRecoverySnapshots(storage)).toEqual(recovered)
  })

  it('does not discard the selected restore target when even the minimum pair cannot fit', () => {
    const storage = quotaStorage(100_000)
    const source = reviewedProjection(initialDraft)
    const [target] = saveRecoverySnapshot(storage, initialDraft, 'paper.qmd', source)
    const before = storage.getItem('draftmatter.recovery.v1')
    expect(() => saveRecoverySnapshot(storage, initialDraft, 'paper.qmd', 'large '.repeat(20_000), undefined, undefined, { preserveSnapshotId: target.id })).toThrow('Storage quota exceeded')
    expect(storage.getItem('draftmatter.recovery.v1')).toBe(before)
    expect(readRecoverySnapshots(storage)).toEqual([target])
  })

  it('does not evict history for errors unrelated to the quota and rejects broken compact references', () => {
    const storage = memoryStorage()
    const source = reviewedProjection(initialDraft)
    saveRecoverySnapshot(storage, initialDraft, 'paper.qmd', source)
    const setItem = vi.fn(() => { throw new DOMException('Storage access denied', 'SecurityError') })
    expect(() => saveRecoverySnapshot({ getItem: storage.getItem, setItem }, initialDraft, 'paper.qmd', `${source}\nedit`)).toThrow('Storage access denied')
    expect(setItem).toHaveBeenCalledOnce()
    storage.setItem('draftmatter.recovery.v1', JSON.stringify({ schemaVersion: 2, texts: ['source'], snapshots: [{ $text: 5 }] }))
    expect(readRecoverySnapshots(storage)).toEqual([])
  })

  it('escapes real draft objects resembling reserved compact text references', () => {
    const storage = memoryStorage()
    const source = reviewedProjection(initialDraft)
    const draft = { ...initialDraft, extension: { $text: 3 }, anotherExtension: { $literal: [['nested', { $text: 5 }]] } }
    const [saved] = saveRecoverySnapshot(storage, draft, 'paper.qmd', source)
    expect(readRecoverySnapshots(storage)).toEqual([saved])
  })

  it('rejects an individually oversized draft without modifying any previous recovery versions', () => {
    const storage = memoryStorage()
    const source = reviewedProjection(initialDraft)
    const [saved] = saveRecoverySnapshot(storage, initialDraft, 'paper.qmd', source)
    const before = storage.getItem('draftmatter.recovery.v1')
    expect(() => saveRecoverySnapshot(storage, initialDraft, 'paper.qmd', 'x'.repeat(2_100_000))).toThrow('exceed the local recovery journal capacity')
    expect(storage.getItem('draftmatter.recovery.v1')).toBe(before)
    expect(readRecoverySnapshots(storage)).toEqual([saved])
  })
})

describe('manuscript-scoped recovery journals', () => {
  const desktop = (projectRoot: string, documentPath: string): RecoveryDocumentIdentity => ({ kind: 'desktop', projectRoot, documentPath })
  const save = (storage: KeyValueStorage, identity: RecoveryDocumentIdentity, source: string, minute = 0, preserveSnapshotId?: string) => saveRecoverySnapshot(storage, { ...initialDraft, title: source.slice(0, 40) }, identity.documentPath.split('/').at(-1)!, source, `2026-11-16T10:${String(minute).padStart(2, '0')}:00.000Z`, undefined, { documentIdentity: identity, preserveSnapshotId })

  it('isolates README, concept and article files, including equally named articles in different projects', () => {
    const storage = memoryStorage()
    const identities = [desktop('/projects/a', 'README.md'), desktop('/projects/a', 'concept.md'), desktop('/projects/a', 'paper.md'), desktop('/projects/b', 'paper.md')]
    const snapshots = identities.map((identity, index) => save(storage, identity, `Document ${index}`)[0])
    identities.forEach((identity, index) => {
      expect(readRecoverySnapshots(storage, identity)).toEqual([snapshots[index]])
      identities.forEach((other, otherIndex) => {
        expect(recoverySnapshotMatchesDocument(snapshots[index], other)).toBe(index === otherIndex)
        if (index !== otherIndex) expect(() => assertRecoverySnapshotDocument(snapshots[index], other)).toThrow('different manuscript or project')
      })
    })
    expect(readRecoverySnapshots(storage)).toEqual([])
    expect(storage.getItem('draftmatter.recovery.v1')).toBeNull()
  })

  it('deduplicates only within an exact manuscript and retains each paper’s recent history', () => {
    const storage = memoryStorage()
    const a = desktop('/projects/a', 'paper.md'), b = desktop('/projects/b', 'paper.md')
    save(storage, a, 'Same content', 0)
    save(storage, b, 'Same content', 0)
    save(storage, a, 'Same content', 1)
    expect(readRecoverySnapshots(storage, a)).toHaveLength(1)
    expect(readRecoverySnapshots(storage, b)).toHaveLength(1)
    for (let index = 2; index < 12; index += 1) {
      save(storage, a, `A ${index}`, index)
      save(storage, b, `B ${index}`, index)
    }
    expect(readRecoverySnapshots(storage, a)).toHaveLength(11)
    expect(readRecoverySnapshots(storage, a).map((entry) => entry.source)).toEqual([...Array.from({ length: 10 }, (_, index) => `A ${11 - index}`), 'Same content'])
    expect(readRecoverySnapshots(storage, b)).toHaveLength(11)
    expect(readRecoverySnapshots(storage, b)[0].source).toBe('B 11')
  })

  it('normalizes canonical root spelling and relative path separators without conflating case-sensitive project paths', () => {
    expect(recoveryDocumentStorageKey(desktop('/projects/a/', './drafts//paper.md'))).toBe(recoveryDocumentStorageKey(desktop('/projects//a', 'drafts\\paper.md')))
    expect(recoveryDocumentStorageKey(desktop('c:\\projects\\A\\', 'drafts\\paper.md'))).toBe(recoveryDocumentStorageKey(desktop('C:/projects/A', 'drafts/paper.md')))
    expect(recoveryDocumentStorageKey(desktop('/projects/A', 'paper.md'))).not.toBe(recoveryDocumentStorageKey(desktop('/projects/a', 'paper.md')))
    expect(recoveryDocumentStorageKey(desktop('/projects/a', 'drafts/paper.md'))).not.toBe(recoveryDocumentStorageKey(desktop('/projects/a', 'paper.md')))
    for (const identity of [desktop('/', 'paper.md'), desktop('C:/', 'paper.md'), desktop('\\\\server\\share\\', 'paper.md')]) {
      const normalized = normalizeRecoveryDocumentIdentity(identity)
      expect(normalizeRecoveryDocumentIdentity(normalized)).toEqual(normalized)
    }
    expect(() => recoveryDocumentStorageKey(desktop('relative-root', 'paper.md'))).toThrow('absolute')
    expect(() => recoveryDocumentStorageKey(desktop('/projects/a', '../paper.md'))).toThrow('inside its project')
    expect(() => recoveryDocumentStorageKey(desktop('/projects/a/../b', 'paper.md'))).toThrow('canonical')
  })

  it('scopes browser histories by stable asset catalogue plus filename, without assigning legacy entries', () => {
    const storage = memoryStorage()
    const legacy = saveRecoverySnapshot(storage, initialDraft, 'paper.md', 'Legacy unknown project', undefined, 'catalogue-a')[0]
    const before = storage.getItem('draftmatter.recovery.v1')
    const a: RecoveryDocumentIdentity = { kind: 'browser', browserAssetScope: 'catalogue-a', documentPath: 'paper.md' }
    const otherFile: RecoveryDocumentIdentity = { ...a, documentPath: 'README.md' }
    const otherProject: RecoveryDocumentIdentity = { ...a, browserAssetScope: 'catalogue-b' }
    expect(readRecoverySnapshots(storage, a)).toEqual([])
    expect(recoverySnapshotMatchesDocument(legacy, a)).toBe(false)
    expect(() => assertRecoverySnapshotDocument(legacy, a)).toThrow('different manuscript or project')
    const [current] = save(storage, a, 'New scoped browser paper')
    expect(current.browserAssetScope).toBe('catalogue-a')
    expect(readRecoverySnapshots(storage, a)).toEqual([current])
    expect(readRecoverySnapshots(storage, otherFile)).toEqual([])
    expect(readRecoverySnapshots(storage, otherProject)).toEqual([])
    expect(storage.getItem('draftmatter.recovery.v1')).toBe(before)
    expect(readRecoverySnapshots(storage)).toEqual([legacy])
    expect(() => saveRecoverySnapshot(storage, initialDraft, 'paper.md', 'Wrong asset catalogue', undefined, 'catalogue-b', { documentIdentity: a })).toThrow('does not match')
  })

  it('isolates online histories by service, workspace, project and document path', () => {
    const storage = memoryStorage()
    const a: RecoveryDocumentIdentity = { kind: 'collaboration', serviceUrl: 'https://COLLAB.example.test/team/', workspaceId: 'workspace-a', projectId: 'project-a', documentPath: 'paper.md' }
    const [snapshot] = save(storage, a, 'Online paper')
    expect(readRecoverySnapshots(storage, { ...a, serviceUrl: 'wss://collab.example.test/team' })).toEqual([snapshot])
    for (const identity of [{ ...a, serviceUrl: 'https://another.example.test/team' }, { ...a, workspaceId: 'workspace-b' }, { ...a, projectId: 'project-b' }, { ...a, documentPath: 'concept.md' }]) {
      expect(readRecoverySnapshots(storage, identity)).toEqual([])
      expect(() => assertRecoverySnapshotDocument(snapshot, identity)).toThrow('different manuscript or project')
    }
  })

  it('preserves both legacy journal versions exactly while new projects write their own histories', () => {
    for (const version of [1, 2]) {
      const storage = memoryStorage()
      const [legacy] = saveRecoverySnapshot(storage, initialDraft, 'paper.md', 'Unassigned old paper')
      if (version === 1) storage.setItem('draftmatter.recovery.v1', JSON.stringify({ schemaVersion: 1, snapshots: [legacy] }))
      const before = storage.getItem('draftmatter.recovery.v1')
      const identity = desktop('/projects/a', 'paper.md')
      for (let index = 0; index < 12; index += 1) save(storage, identity, `Scoped ${index}`, index)
      expect(storage.getItem('draftmatter.recovery.v1')).toBe(before)
      expect(readRecoverySnapshots(storage, identity)).toHaveLength(12)
      expect(readRecoverySnapshots(storage)).toEqual([legacy])
      expect(JSON.parse(storage.getItem(recoveryDocumentStorageKey(identity))!).schemaVersion).toBe(3)
    }
  })

  it('never evicts another manuscript or legacy journal to make room for the active paper', () => {
    const storage = quotaStorage(180_000)
    saveRecoverySnapshot(storage, initialDraft, 'old.md', 'Legacy history')
    const legacyBefore = storage.getItem('draftmatter.recovery.v1')
    const a = desktop('/projects/a', 'paper.md'), b = desktop('/projects/b', 'paper.md')
    const [bSnapshot] = save(storage, b, 'B'.repeat(20_000))
    const bBefore = storage.getItem(recoveryDocumentStorageKey(b))
    const [target] = save(storage, a, `${'A'.repeat(20_000)} target`)
    for (let index = 1; index < 8; index += 1) save(storage, a, `${'A'.repeat(20_000)} Version ${index}`, index, target.id)
    const versions = readRecoverySnapshots(storage, a)
    expect(versions.length).toBeLessThan(8)
    expect(versions[0].source).toContain('Version 7')
    expect(versions.some((entry) => entry.id === target.id)).toBe(true)
    expect(storage.getItem(recoveryDocumentStorageKey(b))).toBe(bBefore)
    expect(readRecoverySnapshots(storage, b)).toEqual([bSnapshot])
    expect(storage.getItem('draftmatter.recovery.v1')).toBe(legacyBefore)
    const aBefore = storage.getItem(recoveryDocumentStorageKey(a))
    expect(() => save(storage, a, 'Impossible current draft '.repeat(30_000), 8, target.id)).toThrow('Storage quota exceeded')
    expect(storage.getItem(recoveryDocumentStorageKey(a))).toBe(aBefore)
    expect(storage.getItem(recoveryDocumentStorageKey(b))).toBe(bBefore)
    expect(storage.getItem('draftmatter.recovery.v1')).toBe(legacyBefore)
  })

  it('rejects foreign snapshots accidentally placed in a scoped key without overwriting them', () => {
    const storage = memoryStorage()
    const a = desktop('/projects/a', 'paper.md'), b = desktop('/projects/b', 'paper.md')
    const [foreign] = save(storage, b, 'B manuscript')
    const wrongJournal = JSON.stringify({ schemaVersion: 1, snapshots: [foreign] })
    storage.setItem(recoveryDocumentStorageKey(a), wrongJournal)
    expect(readRecoverySnapshots(storage, a)).toEqual([])
    expect(() => save(storage, a, 'A manuscript')).toThrow('different manuscript')
    expect(storage.getItem(recoveryDocumentStorageKey(a))).toBe(wrongJournal)
  })
})

describe('immutable saved versions and rolling autosaves', () => {
  const identity = { kind: 'browser' as const, browserAssetScope: 'saved-version-fixture', documentPath: 'paper.md' }
  const save = (storage: KeyValueStorage, source: string, options: Parameters<typeof saveRecoverySnapshot>[6] = {}) => saveRecoverySnapshot(storage, { ...initialDraft, title: 'Saved article' }, 'paper.md', source, '2026-11-16T12:00:00.000Z', undefined, { ...options, documentIdentity: identity })

  it('appends distinct named manual events even when every source and timestamp are identical', () => {
    const storage = memoryStorage()
    const originals = []
    for (let index = 0; index < 12; index++) originals.push(save(storage, '# Same article\n', { kind: 'manual', label: `Save ${index}` })[0])
    const versions = readRecoverySnapshots(storage, identity)
    expect(versions).toHaveLength(12)
    expect(new Set(versions.map((entry) => entry.id)).size).toBe(12)
    expect(versions.map((entry) => entry.label)).toEqual(Array.from({ length: 12 }, (_, index) => `Save ${11 - index}`))
    for (const original of originals) expect(versions.find((entry) => entry.id === original.id)).toEqual(original)
    save(storage, '# Same article\n')
    expect(readRecoverySnapshots(storage, identity)).toEqual(versions)
  })

  it('keeps every named savepoint separately from the automatic history budget', () => {
    const storage = memoryStorage()
    const originals = [save(storage, '# Origin\n', { kind: 'origin' })[0], save(storage, '# Named\n', { kind: 'manual', label: 'Before submission' })[0]]
    for (let index = 0; index < 20; index++) save(storage, `# Autosave ${index}\n`)
    const versions = readRecoverySnapshots(storage, identity)
    expect(versions).toHaveLength(22)
    expect(versions.filter((entry) => entry.kind === 'autosave').map((entry) => entry.source)).toEqual(Array.from({ length: 20 }, (_, index) => `# Autosave ${19 - index}\n`))
    for (const original of originals) expect(versions.find((entry) => entry.id === original.id)).toEqual(original)
  })

  it('preserves an original autosave unchanged and appends both pre-restore and restored version events', () => {
    const storage = memoryStorage()
    const [original] = save(storage, '# Original selected version\n')
    save(storage, '# Current version\n')
    const [safety] = save(storage, '# Current version\n', { kind: 'before-restore', preserveSnapshotId: original.id })
    const [restored] = save(storage, original.source, { kind: 'restored', restoredFromId: original.id, preserveSnapshotId: original.id })
    expect(restored.id).not.toBe(original.id)
    expect(restored.source).toBe(original.source)
    expect(restored.restoredFromId).toBe(original.id)
    for (let index = 0; index < 20; index++) save(storage, `# Later edit ${index}\n`)
    const versions = readRecoverySnapshots(storage, identity)
    expect(versions.find((entry) => entry.id === original.id)).toEqual(original)
    expect(versions.find((entry) => entry.id === safety.id)).toEqual(safety)
    expect(versions.find((entry) => entry.id === restored.id)).toEqual(restored)
    expect(versions.filter((entry) => entry.kind === 'autosave' && entry.id !== original.id)).toHaveLength(21)
  })

  it('persists origin protection even when the current source was already the latest autosave', () => {
    const storage = memoryStorage()
    const [original] = save(storage, '# Original\n')
    save(storage, '# Current\n')
    save(storage, '# Current\n', { preserveSnapshotId: original.id })
    for (let index = 0; index < 12; index++) save(storage, `# Later ${index}\n`)
    expect(readRecoverySnapshots(storage, identity).find((entry) => entry.id === original.id)).toEqual(original)
  })

  it('exposes restored-origin retention after reload without leaking another document’s pin identities', () => {
    const storage = memoryStorage()
    const [original] = save(storage, '# Chosen older autosave\n')
    save(storage, '# Current source\n', { kind: 'before-restore', preserveSnapshotId: original.id })
    for (let index = 0; index < 20; index++) save(storage, `# Later autosave ${index}\n`)
    // Reload through the serialized journal, with no mutable snapshot fields added.
    expect(readRecoveryPinnedSnapshotIds(storage, identity)).toEqual([original.id])
    expect(readRecoverySnapshots(storage, identity).find((entry) => entry.id === original.id)).toEqual(original)
    expect(readRecoverySnapshots(storage, identity).filter((entry) => entry.kind === 'autosave' && entry.id !== original.id)).toHaveLength(20)

    const foreignIdentity = { ...identity, browserAssetScope: 'another-document-catalogue' }
    const [foreign] = saveRecoverySnapshot(storage, initialDraft, 'paper.md', '# Other project\n', undefined, undefined, { documentIdentity: foreignIdentity })
    expect(readRecoveryPinnedSnapshotIds(storage, foreignIdentity)).toEqual([])
    const key = recoveryDocumentStorageKey(identity)
    const serialized = JSON.parse(storage.getItem(key)!)
    serialized.pinnedSnapshotIds.push(foreign.id)
    storage.setItem(key, JSON.stringify(serialized))
    expect(readRecoveryPinnedSnapshotIds(storage, identity)).toEqual([original.id])
    expect(readRecoveryPinnedSnapshotIds(storage, foreignIdentity)).toEqual([])
  })

  it('retains kindless versions from earlier scoped releases without rewriting their records', () => {
    const storage = memoryStorage()
    const old = Array.from({ length: 8 }, (_, index) => {
      const { kind: _kind, ...snapshot } = save(storage, `# Earlier save ${index}\n`)[0]
      return snapshot
    })
    storage.setItem(recoveryDocumentStorageKey(identity), JSON.stringify({ schemaVersion: 3, texts: [], snapshots: old }))
    for (let index = 0; index < 20; index++) save(storage, `# New autosave ${index}\n`)
    const versions = readRecoverySnapshots(storage, identity)
    expect(versions).toHaveLength(28)
    for (const snapshot of old) expect(versions.find((entry) => entry.id === snapshot.id)).toEqual(snapshot)
    expect(versions.filter((entry) => entry.kind === 'autosave')).toHaveLength(20)
  })

  it('names an older version without mutating it or manufacturing a duplicate working autosave', () => {
    const storage = memoryStorage()
    const [original] = save(storage, '# Older source\n')
    const [current] = save(storage, '# Current source\n')
    const [tagged] = saveRecoverySnapshot(storage, original.draft, 'paper.md', original.source, original.savedAt,
      identity.browserAssetScope, { documentIdentity: identity, kind: 'manual', label: 'Initial reasoning',
        restoredFromId: original.id, preserveSnapshotId: original.id })
    expect(tagged.id).not.toBe(original.id)
    expect(tagged.savedAt).toBe(original.savedAt)
    expect(tagged.source).toBe(original.source)
    const before = storage.getItem(recoveryDocumentStorageKey(identity))
    save(storage, current.source)
    expect(storage.getItem(recoveryDocumentStorageKey(identity))).toBe(before)
    expect(readRecoverySnapshots(storage, identity).find((entry) => entry.id === original.id)).toEqual(original)
    expect(readRecoveryPinnedSnapshotIds(storage, identity)).toEqual([original.id])
  })

  it('limits only unprotected automatic versions to 100 across writes and reloads', () => {
    const storage = memoryStorage()
    const [named] = save(storage, '# Named milestone\n', { kind: 'manual', label: 'Ready for review' })
    const [original] = save(storage, '# Important source\n')
    save(storage, '# Preserve original\n', { kind: 'before-restore', preserveSnapshotId: original.id })
    for (let index = 0; index < 130; index++) saveRecoverySnapshot(storage, initialDraft, 'paper.md', `# Changed ${index}\n`,
      new Date(Date.UTC(2026, 0, index + 1)).toISOString(), identity.browserAssetScope, { documentIdentity: identity })
    const versions = readRecoverySnapshots(storage, identity)
    expect(versions.filter((entry) => entry.kind === 'autosave' && entry.id !== original.id)).toHaveLength(100)
    expect(versions.find((entry) => entry.id === original.id)).toEqual(original)
    expect(versions.find((entry) => entry.id === named.id)).toEqual(named)
    expect(versions.filter((entry) => entry.kind === 'autosave').slice(0, 8).map((entry) => entry.source)).toEqual(
      Array.from({ length: 8 }, (_, index) => `# Changed ${129 - index}\n`))
    expect(versions.some((entry) => entry.source === '# Changed 0\n')).toBe(false)
  })

  it('keeps the latest eight captures in order when timestamps repeat or the clock moves backwards', () => {
    const storage = memoryStorage()
    const entries = []
    for (let index = 0; index < 110; index++) entries.push(saveRecoverySnapshot(storage, initialDraft, 'paper.md', `# Clock edit ${index}\n`,
      index < 90 ? '2026-11-16T12:00:00.000Z' : '2026-11-15T12:00:00.000Z', identity.browserAssetScope,
      { documentIdentity: identity })[0])
    const versions = readRecoverySnapshots(storage, identity)
    expect(versions.slice(0, 8).map((entry) => entry.id)).toEqual(entries.slice(-8).reverse().map((entry) => entry.id))
    expect(Date.parse(entries.at(-1)!.savedAt)).toBeGreaterThan(Date.parse(entries[0].savedAt))
    expect(new Set(versions.map((entry) => entry.savedAt)).size).toBe(100)
  })

  it('does not delete protected history if naming a version fails to write', () => {
    const storage = memoryStorage()
    const [original] = save(storage, '# Older source\n')
    const [current] = save(storage, '# Current source\n')
    const before = storage.getItem(recoveryDocumentStorageKey(identity))
    expect(() => saveRecoverySnapshot(faultingStorage(storage), original.draft, 'paper.md', original.source, original.savedAt,
      identity.browserAssetScope, { documentIdentity: identity, kind: 'manual', label: 'Cannot save',
        restoredFromId: original.id, preserveSnapshotId: original.id })).toThrow('Saved versions were kept')
    expect(storage.getItem(recoveryDocumentStorageKey(identity))).toBe(before)
    expect(readRecoverySnapshots(storage, identity)).toEqual([current, original])
    expect(readRecoveryPinnedSnapshotIds(storage, identity)).toEqual([])
  })

  it('fails atomically at capacity instead of discarding any explicit saved version', () => {
    const storage = quotaStorage(120_000)
    const [first] = save(storage, 'A'.repeat(20_000), { kind: 'manual', label: 'First' })
    const [second] = save(storage, 'B'.repeat(20_000), { kind: 'manual', label: 'Second' })
    const before = storage.getItem(recoveryDocumentStorageKey(identity))
    expect(() => save(storage, 'C'.repeat(40_000), { kind: 'manual', label: 'Cannot fit' })).toThrow('Saved versions were kept')
    expect(storage.getItem(recoveryDocumentStorageKey(identity))).toBe(before)
    expect(readRecoverySnapshots(storage, identity)).toEqual([second, first])
  })

  it('reads many identical-content events without mistaking pooled string references for expanded memory', () => {
    const storage = memoryStorage()
    const source = `# Many saves\n\n${'Repeated prose. '.repeat(7_000)}\n`
    const draft = parsePortableDocument(source, initialDraft).draft
    for (let index = 0; index < 180; index++) saveRecoverySnapshot(storage, draft, 'paper.md', source, '2026-11-16T12:00:00.000Z', undefined, { documentIdentity: identity, kind: 'manual', label: `Save ${index}` })
    const versions = readRecoverySnapshots(storage, identity)
    expect(versions).toHaveLength(180)
    expect(versions.every((entry) => entry.source === source && entry.draft.portableEnvelope?.source === source)).toBe(true)
  })
})
