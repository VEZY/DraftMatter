// @vitest-environment jsdom

import { createHash } from 'node:crypto'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { EditorView as CodeMirror } from '@codemirror/view'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { desktopHost } from './desktopHost'
import { COLLABORATIVE_PROSEMIRROR_ROOT, type CollaborativeEditorBinding } from './sharedEditor'

const original = 'publish("height", 24)'
const revised = 'publish("height", 43)'
const source = [
  '# Measurements', '', 'Height {{height}}. Another measurement {{height}}.', '',
  '~~~python {#cell-height .execute output="values"}', original, '~~~', '',
  '<!-- dm-output:start cell="cell-height" run="sha256:result" -->',
  `<!-- dm-published-value data="${encodeURIComponent(JSON.stringify({
    version: 1, name: 'height', value: 24, formatting: {}, rendered: '24',
    provenance: { cellId: 'cell-height', language: 'python', runHash: 'sha256:result',
      codeHash: 'sha256:' + createHash('sha256').update(original).digest('hex'), environmentFingerprint: 'env', sessionGeneration: 1,
      executionSequence: 1, retainedOutputHashes: ['sha256:result'] },
  }))}" -->`, '<!-- dm-output:end -->', '',
].join('\n')
type Role = 'editor' | 'viewer'
let role: Role
let incomingSource: string
let binding: CollaborativeEditorBinding

vi.mock('./CollaborationDialog', () => ({
  CollaborationDialog: (props: {
    open: boolean
    onSessionStateChange: (active: boolean) => void
    onRoleChange: (role: Role) => void
    onStatus: (status: 'connected') => void
    onRemoteSource: (source: string) => void
    onEditorBindingChange: (binding: CollaborativeEditorBinding) => void
  }) => props.open ? createElement('button', { onClick: () => {
    props.onSessionStateChange(true)
    props.onRoleChange(role)
    props.onStatus('connected')
    props.onRemoteSource(incomingSource)
    props.onEditorBindingChange(binding)
  } }, 'Join test project') : null,
}))

import App from './App'

describe('computed values in a shared web manuscript', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  let previousDesktop: boolean
  let peer: Y.Doc

  function button(parent: Element, label: string) {
    return [...parent.querySelectorAll('button')].find((button) => button.textContent === label)!
  }
  const occurrences = () => [...container.querySelectorAll<HTMLElement>('.ProseMirror [data-dm-node="published-value"]')]
  const detail = () => container.querySelector<HTMLElement>('.computed-value-detail')!
  const code = (parent: Element) => CodeMirror.findFromDOM(parent.querySelector<HTMLElement>('.cm-editor')!)!
  async function edit(view: CodeMirror, text: string) {
    await act(async () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }))
  }

  beforeEach(async () => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    incomingSource = source
    previousDesktop = desktopHost.available
    desktopHost.available = false
    vi.spyOn(desktopHost, 'executeKernel')
    vi.spyOn(desktopHost, 'formatCode')
    const document = new Y.Doc()
    binding = { document, awareness: new Awareness(document), user: { id: 'tester', name: 'Tester', color: '#678063' } }
    peer = new Y.Doc()
    document.on('update', (update) => Y.applyUpdate(peer, update))
    localStorage.clear()
    container = window.document.createElement('div')
    window.document.body.append(container)
    root = createRoot(container)
    await act(async () => root.render(<App />))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    binding.awareness.destroy()
    binding.document.destroy()
    peer.destroy()
    desktopHost.available = previousDesktop
    vi.restoreAllMocks()
    container.remove()
  })

  async function join(as: Role, rendered = '24') {
    role = as
    await act(async () => container.querySelector<HTMLButtonElement>('.collaboration-toggle')!.click())
    await act(async () => button(container, 'Join test project').click())
    expect(occurrences().map((value) => value.textContent)).toEqual([rendered, rendered])
    await act(async () => occurrences()[0].click())
  }

  it('shares the saved calculation with a second Yjs replica, preserves the two displayed results and offers desktop handoff', async () => {
    await join('editor')
    expect(detail().textContent).toContain('2 occurrences')
    await vi.waitFor(() => expect(occurrences()[0].dataset.status).toBe('current'))
    expect(detail().textContent).not.toMatch(/Saved result|Unsaved source changes/i)
    expect(detail().textContent).toContain('Open in the desktop app to update the result.')
    expect(detail().querySelector('button[aria-label="Run"]')).toBeNull()
    for (const label of ['Run', 'Save & run', 'Save source', 'Revert']) expect(button(detail(), label)).toBeUndefined()
    const view = code(detail())
    expect(view.state.doc.toString()).toBe(original)
    await edit(view, revised)
    expect(peer.getXmlFragment(COLLABORATIVE_PROSEMIRROR_ROOT).toString()).toContain(revised)
    expect(container.textContent).not.toContain('Project code saved')
    expect(occurrences().map((value) => value.textContent)).toEqual(['24', '24'])
    expect(occurrences().map((item) => item.dataset.status)).toEqual(['stale', 'stale'])
    const goToSource = detail().querySelector<HTMLButtonElement>('button[aria-label="Go to source"]') ?? button(detail(), 'Go to source')
    await act(async () => goToSource.click())
    const drawer = container.querySelector<HTMLElement>('.code-workspace-drawer')!
    await vi.waitFor(() => expect(document.activeElement).toBe(code(drawer).contentDOM))
    expect(drawer.querySelector('details')?.open).toBe(true)
    expect(code(drawer).state.doc.toString()).toBe(revised)
    expect(desktopHost.executeKernel).not.toHaveBeenCalled()
    expect(desktopHost.formatCode).not.toHaveBeenCalled()
  })

  it('keeps the source editor attached while typing temporarily removes the only publish call', async () => {
    incomingSource = source.split('<!-- dm-output:start')[0]
    await join('editor', 'Value unavailable')
    const view = code(detail())
    await edit(view, '')
    expect(code(detail())).toBe(view)
    await edit(view, revised)
    expect(peer.getXmlFragment(COLLABORATIVE_PROSEMIRROR_ROOT).toString()).toContain(revised)
    expect(desktopHost.executeKernel).not.toHaveBeenCalled()
  })

  it('lets a viewer open the calculation and keeps source writes and execution unavailable', async () => {
    await join('viewer')
    expect(code(detail()).state.doc.toString()).toBe(original)
    expect(code(detail()).contentDOM.getAttribute('contenteditable')).toBe('false')
    expect(button(detail(), 'Save source')).toBeUndefined()
    expect(button(detail(), 'Save & run')).toBeUndefined()
    expect(button(detail(), 'Revert')).toBeUndefined()
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(detail()).toBeNull()
    expect(document.activeElement).toBe(occurrences()[0])
    await act(async () => occurrences()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })))
    const drawer = container.querySelector<HTMLElement>('.code-workspace-drawer')!
    await vi.waitFor(() => expect(document.activeElement).toBe(code(drawer).contentDOM))
    expect(code(drawer).contentDOM.getAttribute('contenteditable')).toBe('false')
    expect(button(drawer, 'Save source')).toBeUndefined()
    expect(desktopHost.executeKernel).not.toHaveBeenCalled()
    expect(desktopHost.formatCode).not.toHaveBeenCalled()
  })
})
