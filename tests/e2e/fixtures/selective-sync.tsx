import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ProjectSyncController, type ProjectSyncExpectedVersions } from '../../../src/projectSyncController'
import { SelectiveSyncPanel } from '../../../src/SelectiveSyncPanel'
import { defaultTrackedSyncPaths } from '../../../src/selectiveSync'
import { projectAssetHash, type ProjectSyncState } from '../../../src/desktopHost'
import '../../../src/styles.css'

// Browser-only test fixture. The production controller/UI run against bounded in-memory transports;
// the separate native suite exercises filesystem guards and the server suite exercises SQL CAS.
const encode = (text: string) => new TextEncoder().encode(text)
const local = new Map<string, Uint8Array>([
  ['paper.qmd', encode('# Field study\n\nA local revision.\n')],
  ['figures/response.svg', encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')],
  ['references.json', encode('[]\n')],
  ['data/observations.csv', encode('week,area\n1,12\n')],
])
const remote = new Map([...local].slice(0, 3).map(([path, bytes]) => [path, { bytes: bytes.slice(), versionId: `version-${path}` }]))
remote.set('paper.qmd', { bytes: encode('# Field study\n\nAn online revision.\n'), versionId: 'paper-online-2' })
let state: ProjectSyncState = { schemaVersion: 1, scope: { serviceUrl: 'https://sync.example.test', workspaceId: 'research', projectId: 'paper' }, trackedPaths: ['paper.qmd', 'figures/response.svg', 'references.json'], excludedPaths: [], paused: false, baselines: { 'paper.qmd': { localHash: await projectAssetHash(encode('# Field study\n\nOriginal text.\n')), remoteVersionId: 'paper-online-1' } } }
let revision: string | null = null
let counter = 0
const host = {
  async readProjectSyncState() { return { state: structuredClone(state), revision } },
  async saveProjectSyncState(request: { state: ProjectSyncState; expectedRevision: string | null }) {
    if (request.expectedRevision !== revision) throw new Error('State conflict')
    state = structuredClone(request.state); revision = `state-${++counter}`
    return { state: structuredClone(state), revision }
  },
  async listProjectFiles() { return { files: [...local].map(([path, bytes]) => ({ path, bytes: bytes.length, modifiedMs: 1 })), truncated: false } },
  async inspectProjectSyncFiles(_root: string, paths: string[]) {
    return Promise.all(paths.map(async (path) => ({ path, exists: local.has(path), bytes: local.get(path)?.length ?? 0, hash: local.has(path) ? await projectAssetHash(local.get(path)!) : null, modifiedMs: 1, tooLarge: false })))
  },
  async readProjectSyncFile(_root: string, path: string, expectedHash: string) {
    const bytes = local.get(path)!
    if (await projectAssetHash(bytes) !== expectedHash) throw new Error('Local edit detected')
    return { path, bytes: [...bytes], hash: expectedHash }
  },
  async applyProjectSyncFile(request: { path: string; bytes: number[]; expectedHash: string | null }) {
    const old = local.get(request.path)
    if ((old ? await projectAssetHash(old) : null) !== request.expectedHash) throw new Error('Local edit detected; original preserved')
    if (old) local.set(`recovery/${++counter}/${request.path}`, old.slice())
    const bytes = Uint8Array.from(request.bytes); local.set(request.path, bytes)
    return { path: request.path, bytes: bytes.length, hash: await projectAssetHash(bytes), recoveryPath: old ? 'recovery/original' : null }
  },
}
const controller = new ProjectSyncController({
  root: '/fixture/field-study', scope: state.scope, manuscriptPath: 'paper.qmd', host,
  getDefaultPaths: (files) => defaultTrackedSyncPaths({ manuscriptPath: 'paper.qmd', files }), canUpload: () => true,
  remote: {
    async list() { return Promise.all([...remote].map(async ([path, file]) => ({ path, versionId: file.versionId, size: file.bytes.length, hash: await projectAssetHash(file.bytes) }))) },
    async read(path, versionId) { const file = remote.get(path); if (file?.versionId !== versionId) throw new Error('Online version changed'); return file.bytes.slice() },
    async write(path, bytes, expectedVersionId) {
      if ((remote.get(path)?.versionId ?? null) !== expectedVersionId) throw new Error('Online version changed; original preserved')
      const versionId = `file-${++counter}`; remote.set(path, { bytes: bytes.slice(), versionId }); return { versionId }
    },
  },
})
;(window as unknown as { syncFixture: unknown }).syncFixture = {
  copies: () => ({ local: Object.fromEntries([...local].map(([path, bytes]) => [path, new TextDecoder().decode(bytes)])), remote: Object.fromEntries([...remote].map(([path, file]) => [path, new TextDecoder().decode(file.bytes)])) }),
  editOnline: (path: string, text: string) => remote.set(path, { bytes: encode(text), versionId: `external-${++counter}` }),
}
function Fixture() {
  const [snapshot, setSnapshot] = useState(controller.getSnapshot())
  useEffect(() => { const unsubscribe = controller.subscribe(setSnapshot); void controller.sync(); return unsubscribe }, [])
  const model = {
    active: true, snapshot,
    async syncNow() { await controller.sync() },
    async setTracked(path: string, tracked: boolean) { await controller.setTracked(path, tracked); if (tracked) await controller.sync() },
    async setPaused(paused: boolean) { await controller.setPaused(paused) },
    async compare(path: string, expected?: ProjectSyncExpectedVersions) { return controller.compare(path, expected) },
    async resolve(path: string, choice: 'local' | 'remote' | 'both', expected?: ProjectSyncExpectedVersions) { await controller.resolve(path, choice, expected) },
  }
  return <main style={{ margin: '40px auto', maxWidth: 900, padding: 24, fontFamily: 'Inter, system-ui, sans-serif' }}><h1 style={{ fontSize: 24, marginBottom: 24 }}>Field study · Project files</h1><SelectiveSyncPanel model={model} /></main>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
