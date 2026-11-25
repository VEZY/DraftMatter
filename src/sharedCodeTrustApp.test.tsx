// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { desktopHost, type ProjectSnapshot } from './desktopHost'
import { reconcileCollaborativeProseMirrorDocument, type CollaborativeEditorBinding } from './sharedEditor'
import { parseStructuredManuscript } from './structuredManuscript'

const rootPath = '/research/trusted-shared-values'
const path = 'paper.qmd'
const source = [
  '# Trial', '', 'Measurements are preliminary.', '', '~~~python {#height .execute output="text"}',
  'print(24)', '~~~', '',
].join('\n')
const project: ProjectSnapshot = {
  root: rootPath,
  config: {
    schemaVersion: 1, name: 'Shared trial', mainDocument: path, citationStyle: 'draftmatter-author-date', citationLocale: 'en-US',
    execution: { python: { kernel: 'trial-env' }, r: {}, julia: {} },
    collaboration: { schemaVersion: 1, workspaceId: 'forest', projectId: 'trial', serviceUrl: 'https://collab.example.test' },
  },
  documents: [{ path, kind: 'manuscript', bytes: source.length, modifiedMs: 1, hash: 'initial' }],
  bibliographies: [],
}
const nativeTrust = { trusted: true, scope: 'session', warning: 'Trusted on this device' } as const
let room: {
  onRemoteSource: (source: string) => void
  onStatus: (status: 'connected') => void
  onRoleChange: (role: 'owner') => void
  onSessionStateChange: (active: boolean) => void
  onEditorBindingChange: (binding: CollaborativeEditorBinding) => void
}
vi.mock('./CollaborationDialog', () => ({
  CollaborationDialog: (props: typeof room) => { room = props; return null },
}))

import App from './App'

let container: HTMLDivElement
let app: ReturnType<typeof createRoot>
let previousDesktop: boolean
let binding: CollaborativeEditorBinding
const trustKey = 'draftmatter.trusted-project-roots.v1'

beforeEach(async () => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  previousDesktop = desktopHost.available
  desktopHost.available = true
  localStorage.clear()
  localStorage.setItem(trustKey, JSON.stringify([rootPath]))
  const document = new Y.Doc()
  binding = { document, awareness: new Awareness(document) }
  vi.spyOn(desktopHost, 'openProject').mockResolvedValue(project)
  vi.spyOn(desktopHost, 'readDocument').mockResolvedValue({ path, content: source, hash: 'initial', modifiedMs: 1 })
  vi.spyOn(desktopHost, 'readCitationLock').mockResolvedValue(null)
  vi.spyOn(desktopHost, 'readCitationCache').mockResolvedValue(null)
  vi.spyOn(desktopHost, 'readExecutionManifests').mockResolvedValue([])
  vi.spyOn(desktopHost, 'setCitationPreferences').mockResolvedValue(project)
  vi.spyOn(desktopHost, 'documentStatus').mockResolvedValue({ kind: 'current', hash: 'initial', modifiedMs: 1 })
  vi.spyOn(desktopHost, 'executionTrustStatus').mockResolvedValue(nativeTrust)
  vi.spyOn(desktopHost, 'trustProjectForSession').mockResolvedValue(nativeTrust)
  vi.spyOn(desktopHost, 'probeRuntime').mockImplementation(async (language) => ({ language, health: 'available', executable: language }))
  vi.spyOn(desktopHost, 'discoverJupyterKernels').mockResolvedValue({ health: 'available', searchedLocations: [], kernels: [
    { name: 'trial-env', displayName: 'Python', language: 'python', resourceDir: '/kernels/python', health: 'available' },
  ] })
  vi.spyOn(desktopHost, 'fingerprintExecutionInputs').mockResolvedValue([])
  vi.spyOn(desktopHost, 'saveExecutionManifest').mockImplementation(async ({ content }) => ({ path: 'height.json', content, hash: 'manifest', modifiedMs: 1 }))
  vi.spyOn(desktopHost, 'executeKernel').mockImplementation(async (request) => ({
    status: 'ok', messages: [], artifacts: [], environment: { identity: request.kernelName },
    kernelRunId: 'fixture', executionCount: 1, sessionGeneration: 1, executionSequence: 1,
  }))
  container = window.document.createElement('div')
  window.document.body.append(container)
  app = createRoot(container)
  await act(async () => app.render(<App desktopProjectLaunch={project} />))
  await vi.waitFor(() => expect(container.querySelector('.structured-code-cell[data-dm-id="height"]')).not.toBeNull())
  await act(async () => {
    room.onRemoteSource(source)
    room.onSessionStateChange(true)
    room.onStatus('connected')
    room.onRoleChange('owner')
    room.onEditorBindingChange(binding)
  })
})

afterEach(async () => {
  await act(async () => app.unmount())
  binding.awareness.destroy()
  binding.document.destroy()
  desktopHost.available = previousDesktop
  vi.restoreAllMocks()
  container.remove()
  localStorage.clear()
})

it('keeps trust for shared prose and requires review before running changed code, even during native revocation', async () => {
  let finishRevocation!: () => void
  const revoke = vi.spyOn(desktopHost, 'revokeProjectTrust').mockImplementation(() => new Promise((resolve) => {
    finishRevocation = () => resolve({ ...nativeTrust, trusted: false })
  }))
  // Deliver the editor document as well as the portable update, as a connected peer does.
  const deliver = (next: string) => act(async () => {
    reconcileCollaborativeProseMirrorDocument(binding, parseStructuredManuscript(next).document)
    room.onRemoteSource(next)
  })
  const prose = source.replace('preliminary', 'final')
  await deliver(prose)
  expect(container.querySelector('.ProseMirror')?.textContent).toContain('Measurements are final.')
  expect(revoke).not.toHaveBeenCalled()
  expect(JSON.parse(localStorage.getItem(trustKey)!)).toContain(rootPath)

  await deliver(prose.replace('print(24)', 'print(43)'))
  expect(revoke).toHaveBeenCalledExactlyOnceWith(rootPath)
  expect(JSON.parse(localStorage.getItem(trustKey)!)).not.toContain(rootPath)
  expect(desktopHost.executeKernel).not.toHaveBeenCalled()
  await act(async () => container.querySelector<HTMLButtonElement>('.structured-code-cell .structured-code-run')!.click())
  const dialog = container.querySelector<HTMLElement>('[aria-labelledby="execution-trust-title"]')!
  expect(dialog.textContent).toContain('A collaborator changed executable code')
  expect(desktopHost.executeKernel).not.toHaveBeenCalled()
  expect(desktopHost.trustProjectForSession).not.toHaveBeenCalled()
  await act(async () => dialog.querySelector<HTMLButtonElement>('.primary-button')!.click())
  expect(desktopHost.trustProjectForSession).not.toHaveBeenCalled()
  expect(desktopHost.executeKernel).not.toHaveBeenCalled()
  await act(async () => { finishRevocation() })
  await vi.waitFor(() => expect(desktopHost.executeKernel).toHaveBeenCalledTimes(1))
  expect(desktopHost.trustProjectForSession).toHaveBeenCalledExactlyOnceWith(rootPath, 'run-project-code-with-user-permissions')
  expect(vi.mocked(desktopHost.executeKernel).mock.calls[0][0]).toMatchObject({ cellId: 'height', code: 'print(43)' })
})
