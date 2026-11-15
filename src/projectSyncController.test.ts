import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { ProjectSyncState, ProjectSyncStateSnapshot } from './desktopHost'
import { ProjectSyncController, type ProjectSyncControllerHost, type ProjectSyncRemote, type ProjectSyncRemoteFile } from './projectSyncController'

const root = '/research/sync'
const scope = { serviceUrl: 'https://sync.example.test', workspaceId: 'workspace', projectId: 'paper' }
const encode = (text: string) => new TextEncoder().encode(text)
const decode = (bytes?: Uint8Array) => bytes && new TextDecoder().decode(bytes)
const hash = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const path = 'paper.qmd'

function fixture({ defaults = [path], local: initialLocal = {}, remote: initialRemote = {}, baseline = false, paused = false, writable = true }:
  { defaults?: string[]; local?: Record<string, string>; remote?: Record<string, string>; baseline?: boolean; paused?: boolean; writable?: boolean } = {}) {
  const local = new Map(Object.entries(initialLocal).map(([path, text]) => [path, encode(text)]))
  const heads = new Map<string, ProjectSyncRemoteFile>()
  const versions = new Map<string, Uint8Array>()
  const recovery = new Map<string, Uint8Array>()
  const events: string[] = []
  let number = 0
  let revision = 0
  let state: ProjectSyncState = { schemaVersion: 1, scope, trackedPaths: [...defaults].sort(), excludedPaths: [], paused, baselines: {} }
  let saveFailure = false
  const unreadable = new Set<string>()
  const putRemote = (path: string, text: string, versionId = `version-${++number}`) => {
    const bytes = encode(text)
    heads.set(path, { path, versionId, size: bytes.length })
    versions.set(versionId, bytes)
    return versionId
  }
  for (const [path, text] of Object.entries(initialRemote)) putRemote(path, text)
  if (baseline) for (const [path, bytes] of local) state.baselines[path] = { localHash: hash(bytes), remoteVersionId: heads.get(path)?.versionId ?? null }
  const stateSnapshot = (): ProjectSyncStateSnapshot => ({ state: structuredClone(state), revision: revision ? `state-${revision}` : null })
  const inspect = (path: string) => {
    if (unreadable.has(path)) throw new Error(`Cannot read ${path}`)
    const bytes = local.get(path)
    return { path, exists: Boolean(bytes), bytes: bytes?.length ?? 0, hash: bytes ? hash(bytes) : null, modifiedMs: bytes ? 1 : null, tooLarge: false }
  }
  const host: ProjectSyncControllerHost = {
    readProjectSyncState: vi.fn(async () => stateSnapshot()),
    saveProjectSyncState: vi.fn(async (request) => {
      if (saveFailure || request.expectedRevision !== stateSnapshot().revision) throw new Error('State conflict')
      state = structuredClone(request.state); revision += 1
      return stateSnapshot()
    }),
    listProjectFiles: vi.fn(async () => ({ files: [...local].map(([path, bytes]) => ({ path, bytes: bytes.length, modifiedMs: 1 })), truncated: false })),
    inspectProjectSyncFiles: vi.fn(async (_root, paths) => paths.map(inspect)),
    readProjectSyncFile: vi.fn(async (_root, path, expectedHash) => {
      const bytes = local.get(path)
      if (!bytes || hash(bytes) !== expectedHash) throw new Error('Local file changed')
      return { path, bytes: [...bytes], hash: hash(bytes) }
    }),
    applyProjectSyncFile: vi.fn(async (request) => {
      const previous = local.get(request.path)
      if ((previous ? hash(previous) : null) !== request.expectedHash) throw new Error('Local file changed')
      const bytes = Uint8Array.from(request.bytes)
      events.push(`apply:${request.path}`)
      if (previous) recovery.set(request.path, previous)
      local.set(request.path, bytes)
      return { path: request.path, bytes: bytes.length, hash: hash(bytes), recoveryPath: previous ? `.draftmatter/recovery/${request.path}` : null }
    }),
  }
  let onWrite: ((path: string) => void) | undefined
  const remote: ProjectSyncRemote = {
    canWrite: () => writable,
    list: vi.fn(async () => [...heads.values()].map((head) => ({ ...head }))),
    read: vi.fn(async (_path, versionId) => { const bytes = versions.get(versionId); if (!bytes) throw new Error('Missing remote version'); return Uint8Array.from(bytes) }),
    write: vi.fn(async (path, bytes, expectedVersionId) => {
      if (!writable) throw new Error('Read-only')
      if ((heads.get(path)?.versionId ?? null) !== expectedVersionId) throw new Error('Online version changed')
      events.push(`write:${path}`)
      const versionId = `version-${++number}`
      heads.set(path, { path, versionId, size: bytes.length })
      versions.set(versionId, Uint8Array.from(bytes))
      onWrite?.(path)
      return { versionId }
    }),
  }
  const applied = vi.fn()
  const controller = new ProjectSyncController({ root, scope, manuscriptPath: path, host, remote, getDefaultPaths: () => defaults, canUpload: () => writable, onLocalApplied: applied })
  return { controller, host, remote, local, heads, versions, recovery, events, unreadable, applied, putRemote, get state() { return state }, set saveFailure(value: boolean) { saveFailure = value }, set onWrite(value: ((path: string) => void) | undefined) { onWrite = value } }
}

describe('selective project synchronization controller', () => {
  it('publishes only followed files and preserves explicit exclusions across refreshes', async () => {
    const f = fixture({ local: { [path]: 'Paper', 'data/private.csv': 'Private' } })
    await f.controller.sync()
    expect(f.heads.has(path)).toBe(true)
    expect(f.heads.has('data/private.csv')).toBe(false)
    expect(f.controller.snapshot.rows.find((row) => row.path === 'data/private.csv')?.state).toBe('untracked')
    await f.controller.setTracked(path, false)
    await f.controller.sync()
    expect(f.state.trackedPaths).not.toContain(path)
    expect(f.state.excludedPaths).toContain(path)
    await f.controller.setTracked('data/private.csv', true)
    await f.controller.sync()
    expect(decode(f.versions.get(f.heads.get('data/private.csv')!.versionId))).toBe('Private')
  })

  it('adopts matching initial contents once without rewriting either copy', async () => {
    const f = fixture({ local: { [path]: 'Same' }, remote: { [path]: 'Same' } })
    await f.controller.sync()
    expect(f.controller.snapshot.rows[0].state).toBe('current')
    expect(f.remote.read).toHaveBeenCalledTimes(1)
    expect(f.remote.write).not.toHaveBeenCalled()
    expect(f.host.applyProjectSyncFile).not.toHaveBeenCalled()
    await f.controller.sync()
    expect(f.remote.read).toHaveBeenCalledTimes(1)
  })

  it('transfers one-sided changes with native and remote guards', async () => {
    const f = fixture({ local: { [path]: 'Original' }, remote: { [path]: 'Original' }, baseline: true })
    const originalVersion = f.heads.get(path)!.versionId
    f.local.set(path, encode('Local revision'))
    await f.controller.sync()
    expect(f.remote.write).toHaveBeenCalledWith(path, encode('Local revision'), originalVersion)
    expect(decode(f.versions.get(originalVersion))).toBe('Original')
    f.putRemote(path, 'Online revision')
    await f.controller.sync()
    expect(decode(f.local.get(path))).toBe('Online revision')
    expect(decode(f.recovery.get(path))).toBe('Local revision')
    expect(f.host.applyProjectSyncFile).toHaveBeenCalledWith(expect.objectContaining({ expectedHash: hash(encode('Local revision')) }))
  })

  it('leaves initially divergent and concurrently changed files untouched', async () => {
    const first = fixture({ local: { [path]: 'Local' }, remote: { [path]: 'Online' } })
    await first.controller.sync()
    expect(first.controller.snapshot.rows[0].state).toBe('conflict')
    expect(first.remote.write).not.toHaveBeenCalled()
    expect(first.host.applyProjectSyncFile).not.toHaveBeenCalled()
    const next = fixture({ local: { [path]: 'Original' }, remote: { [path]: 'Original' }, baseline: true })
    next.local.set(path, encode('Local edit')); next.putRemote(path, 'Online edit')
    await next.controller.sync()
    expect(next.controller.snapshot.rows[0].state).toBe('conflict')
    expect(decode(next.local.get(path))).toBe('Local edit')
    expect(next.remote.write).not.toHaveBeenCalled()
  })

  it('continues independent files when one local path is unreadable', async () => {
    const f = fixture({ defaults: [path, 'data/selected.csv'], local: { [path]: 'Paper', 'data/selected.csv': 'Data' } })
    f.unreadable.add(path)
    await f.controller.sync()
    expect(f.controller.snapshot.rows.find((row) => row.path === path)?.state).toBe('error')
    expect(f.heads.has('data/selected.csv')).toBe(true)
  })

  it('stops after a state compare-and-swap failure without overwriting the competing selection', async () => {
    const f = fixture({ defaults: [path, 'z.txt'], local: { [path]: 'Paper', 'z.txt': 'Later' } })
    f.onWrite = () => { f.saveFailure = true }
    await expect(f.controller.sync()).rejects.toThrow('Synchronization state changed')
    expect(f.heads.has(path)).toBe(true)
    expect(f.heads.has('z.txt')).toBe(false)
    expect(f.state.baselines).toEqual({})
    expect(f.controller.snapshot.stale).toBe(true)
  })

  it('keeps pause durable and performs no content transfer while paused', async () => {
    const f = fixture({ local: { [path]: 'Local' }, remote: { [path]: 'Online' }, paused: true })
    await f.controller.sync()
    expect(f.remote.read).not.toHaveBeenCalled()
    expect(f.remote.write).not.toHaveBeenCalled()
    expect(f.controller.snapshot.paused).toBe(true)
    await f.controller.setPaused(false)
    expect(f.state.paused).toBe(false)
  })

  it('rejects a resolution if either displayed version changed', async () => {
    const f = fixture({ local: { [path]: 'Local' }, remote: { [path]: 'Online' } })
    await f.controller.refresh()
    f.local.set(path, encode('A newer local edit'))
    await expect(f.controller.resolve(path, 'remote')).rejects.toThrow('changed since the conflict was displayed')
    expect(f.remote.write).not.toHaveBeenCalled()
    expect(f.host.applyProjectSyncFile).not.toHaveBeenCalled()
  })

  it.each(['local', 'remote', 'both'] as const)('preserves the losing bytes locally and online before choosing %s', async (choice) => {
    const f = fixture({ local: { [path]: 'Local' }, remote: { [path]: 'Online' } })
    await f.controller.refresh()
    await f.controller.resolve(path, choice)
    const copy = [...f.local.keys()].find((name) => name.includes('.conflict-'))!
    const losing = choice === 'local' ? 'Online' : 'Local'
    expect(copy).toBeTruthy()
    expect(decode(f.local.get(copy))).toBe(losing)
    expect(decode(f.versions.get(f.heads.get(copy)!.versionId))).toBe(losing)
    expect(f.state.trackedPaths).toContain(copy)
    expect(f.state.baselines[copy]).toMatchObject({ localHash: hash(encode(losing)), remoteVersionId: f.heads.get(copy)!.versionId })
    const winner = choice === 'local' ? 'Local' : 'Online'
    expect(decode(f.local.get(path))).toBe(winner)
    expect(decode(f.versions.get(f.heads.get(path)!.versionId))).toBe(winner)
    const replacement = `${choice === 'local' ? 'write' : 'apply'}:${path}`
    expect(f.events.indexOf(`write:${copy}`)).toBeLessThan(f.events.indexOf(replacement))
  })

  it('rechecks the original versions after archiving and refuses a new competing online change', async () => {
    const f = fixture({ local: { [path]: 'Local' }, remote: { [path]: 'Online' } })
    await f.controller.refresh()
    f.onWrite = (written) => { if (written.includes('.conflict-')) f.putRemote(path, 'Newer online edit') }
    await expect(f.controller.resolve(path, 'remote')).rejects.toThrow('changed while preserving the conflict')
    expect(decode(f.local.get(path))).toBe('Local')
    expect(decode(f.versions.get(f.heads.get(path)!.versionId))).toBe('Newer online edit')
    expect([...f.local.keys()].some((name) => name.includes('.conflict-'))).toBe(true)
  })

  it('does not overwrite a local edit made while an online download is in flight', async () => {
    const f = fixture({ local: { [path]: 'Original' }, remote: { [path]: 'Original' }, baseline: true })
    f.putRemote(path, 'Online edit')
    const read = vi.mocked(f.remote.read).getMockImplementation()!
    vi.mocked(f.remote.read).mockImplementation(async (path, version) => { const bytes = await read(path, version); f.local.set(path, encode('Concurrent local edit')); return bytes })
    await f.controller.sync()
    expect(decode(f.local.get(path))).toBe('Concurrent local edit')
    expect(f.controller.snapshot.rows[0].state).toBe('error')
  })

  it('requires editor access to publish local conflicts but still downloads unchanged local copies read-only', async () => {
    const f = fixture({ local: { [path]: 'Original' }, remote: { [path]: 'Original' }, baseline: true, writable: false })
    f.putRemote(path, 'Online edit')
    await f.controller.sync()
    expect(decode(f.local.get(path))).toBe('Online edit')
    f.local.set(path, encode('Local edit'))
    await f.controller.sync()
    expect(f.remote.write).not.toHaveBeenCalled()
    expect(f.controller.snapshot.rows[0].reason).toContain('read-only')
  })

  it('normalizes an editable live-preview selection before applying it to the local original', async () => {
    const f = fixture({ local: { [path]: 'Local' } })
    f.putRemote(path, 'Online preview', 'live-preview:head:hash')
    await f.controller.refresh()
    await f.controller.resolve(path, 'remote')
    expect(f.remote.write).toHaveBeenCalledWith(path, encode('Online preview'), 'live-preview:head:hash')
    expect(f.events.indexOf(`write:${path}`)).toBeLessThan(f.events.indexOf(`apply:${path}`))
    expect(f.state.baselines[path].remoteVersionId).not.toMatch(/^live-preview:/)
  })

  it('restores missing copies only by explicit choice and never propagates a deletion', async () => {
    const f = fixture({ local: { [path]: 'Original' }, remote: { [path]: 'Original' }, baseline: true })
    f.local.delete(path)
    await f.controller.sync()
    expect(f.controller.snapshot.rows[0].state).toBe('local-missing')
    expect(f.heads.get(path)?.deleted).not.toBe(true)
    await f.controller.resolve(path, 'remote')
    expect(decode(f.local.get(path))).toBe('Original')
    f.heads.set(path, { path, versionId: 'deleted-version', deleted: true })
    await f.controller.sync()
    expect(f.controller.snapshot.rows[0].state).toBe('remote-missing')
    await expect(f.controller.resolve(path, 'both')).rejects.toThrow('two available files')
    await f.controller.resolve(path, 'local')
    expect(f.remote.write).toHaveBeenLastCalledWith(path, encode('Original'), 'deleted-version')
  })

  it('serializes repeated sync requests and does not upload the same revision twice', async () => {
    const f = fixture({ local: { [path]: 'Paper' } })
    await Promise.all([f.controller.sync(), f.controller.sync()])
    expect(f.remote.write).toHaveBeenCalledTimes(1)
    f.controller.dispose()
    await expect(f.controller.sync()).rejects.toThrow('closed')
  })

  it('does not notify an editor after its project closes during a baseline save', async () => {
    const f = fixture({ local: { [path]: 'Original' }, remote: { [path]: 'Original' }, baseline: true })
    f.putRemote(path, 'Online revision')
    let finishSave!: () => void
    const waiting = new Promise<void>((resolve) => { finishSave = resolve })
    const save = vi.mocked(f.host.saveProjectSyncState).getMockImplementation()!
    vi.mocked(f.host.saveProjectSyncState).mockImplementation(async (request) => { await waiting; return save(request) })
    const operation = f.controller.sync()
    const rejected = expect(operation).rejects.toThrow('closed')
    await vi.waitFor(() => expect(f.host.saveProjectSyncState).toHaveBeenCalledOnce())
    expect(decode(f.local.get(path))).toBe('Online revision')
    f.controller.dispose()
    finishSave()
    await rejected
    expect(f.applied).not.toHaveBeenCalled()
    expect(f.remote.write).not.toHaveBeenCalled()
  })

  it('continues another followed file while a divergent manuscript awaits a choice', async () => {
    const f = fixture({ defaults: [path, 'data/selected.csv'], local: { [path]: 'Local', 'data/selected.csv': 'Selected data' }, remote: { [path]: 'Online' } })
    await f.controller.sync()
    expect(f.controller.snapshot.rows.find((row) => row.path === path)?.state).toBe('conflict')
    expect(decode(f.local.get(path))).toBe('Local')
    expect(decode(f.versions.get(f.heads.get('data/selected.csv')!.versionId))).toBe('Selected data')
  })

  it('preserves a competing server revision that appears during an upload', async () => {
    const f = fixture({ local: { [path]: 'Local' } })
    const write = vi.mocked(f.remote.write).getMockImplementation()!
    vi.mocked(f.remote.write).mockImplementation(async (path, bytes, expected) => { f.putRemote(path, 'Competing online edit'); return write(path, bytes, expected) })
    await f.controller.sync()
    expect(decode(f.local.get(path))).toBe('Local')
    expect(decode(f.versions.get(f.heads.get(path)!.versionId))).toBe('Competing online edit')
    expect(f.state.baselines[path]).toBeUndefined()
  })

  it('promotes matching editable previews to immutable heads but keeps readonly previews virtual', async () => {
    const editable = fixture({ local: { [path]: 'Same' } })
    editable.putRemote(path, 'Same', 'live-preview:none:same')
    await editable.controller.sync()
    expect(editable.remote.write).toHaveBeenCalledWith(path, encode('Same'), 'live-preview:none:same')
    expect(editable.state.baselines[path].remoteVersionId).not.toMatch(/^live-preview:/)
    const reader = fixture({ local: {}, writable: false })
    reader.putRemote(path, 'Online', 'live-preview:none:online')
    await reader.controller.sync()
    expect(decode(reader.local.get(path))).toBe('Online')
    expect(reader.remote.write).not.toHaveBeenCalled()
    expect(reader.state.baselines[path].remoteVersionId).toBe('live-preview:none:online')
  })

  it('does not offer credentials or dependency files as optional selections', async () => {
    const f = fixture({ local: { [path]: 'Paper', '.env': 'Secret', 'node_modules/config.json': 'Dependency', '.aws/credentials': 'Secret' } })
    await f.controller.refresh()
    expect(f.controller.snapshot.rows.map((row) => row.path)).toEqual([path])
    expect(() => f.controller.setTracked('.env', true)).toThrow('private metadata')
  })

  it('does not leave invisible exclusion or pause flags after a rejected preference save', async () => {
    const f = fixture({ local: { [path]: 'Paper' } })
    f.saveFailure = true
    await expect(f.controller.setTracked(path, false)).rejects.toThrow('Synchronization state changed')
    await expect(f.controller.setPaused(true)).rejects.toThrow('Synchronization state changed')
    f.saveFailure = false
    await f.controller.sync()
    expect(f.heads.has(path)).toBe(true)
    expect(f.controller.snapshot.paused).toBe(false)
    expect(f.controller.snapshot.rows[0].tracked).toBe(true)
  })

  it('compares both copies read-only without publishing a preview or replacing either file', async () => {
    const f = fixture({ local: { [path]: 'Local' }, remote: { [path]: 'Online' }, writable: false })
    f.remote.readCopy = vi.fn(async (_path, versionId) => Uint8Array.from(f.versions.get(versionId)!))
    vi.mocked(f.remote.read).mockRejectedValue(new Error('Normal reads can mirror previews and must not be used for comparison'))
    await f.controller.refresh()
    const comparison = await f.controller.compare(path)
    expect(decode(comparison.local?.bytes)).toBe('Local')
    expect(decode(comparison.remote?.bytes)).toBe('Online')
    expect(comparison.expected).toEqual({ localHash: hash(encode('Local')), remoteVersionId: f.heads.get(path)!.versionId })
    expect(f.remote.readCopy).toHaveBeenCalledOnce()
    expect(f.remote.read).not.toHaveBeenCalled()
    expect(f.remote.write).not.toHaveBeenCalled()
    expect(f.host.applyProjectSyncFile).not.toHaveBeenCalled()
  })

  it('rejects comparison when a displayed copy changed before the read', async () => {
    const f = fixture({ local: { [path]: 'Local' }, remote: { [path]: 'Online' } })
    await f.controller.refresh()
    f.putRemote(path, 'A newer online version')
    await expect(f.controller.compare(path)).rejects.toThrow('changed since it was displayed')
    expect(f.remote.read).not.toHaveBeenCalled()
    expect(f.host.readProjectSyncFile).not.toHaveBeenCalled()
  })

  it('does not return comparison contents after their project closes during a read', async () => {
    const f = fixture({ local: { [path]: 'Local' }, remote: { [path]: 'Online' } })
    let finishRead!: () => void
    const waiting = new Promise<void>((resolve) => { finishRead = resolve })
    f.remote.readCopy = vi.fn(async (_path, versionId) => { await waiting; return Uint8Array.from(f.versions.get(versionId)!) })
    await f.controller.refresh()
    const comparison = f.controller.compare(path)
    const rejected = expect(comparison).rejects.toThrow('closed')
    await vi.waitFor(() => expect(f.remote.readCopy).toHaveBeenCalledOnce())
    f.controller.dispose()
    finishRead()
    await rejected
    expect(f.host.applyProjectSyncFile).not.toHaveBeenCalled()
    expect(f.remote.write).not.toHaveBeenCalled()
  })

  it('rejects a choice pinned to the older UI row even after automatic refresh updated the controller', async () => {
    const f = fixture({ local: { [path]: 'Local' }, remote: { [path]: 'Online' } })
    await f.controller.refresh()
    const row = f.controller.snapshot.rows[0]
    const expected = { localHash: row.expectedLocalHash, remoteVersionId: row.expectedRemoteVersionId }
    f.putRemote(path, 'Newer online')
    await f.controller.refresh()
    await expect(f.controller.resolve(path, 'local', expected)).rejects.toThrow('changed since the conflict was displayed')
    expect(f.remote.write).not.toHaveBeenCalled()
    expect(f.host.applyProjectSyncFile).not.toHaveBeenCalled()
    expect(decode(f.versions.get(f.heads.get(path)!.versionId))).toBe('Newer online')
  })
})
