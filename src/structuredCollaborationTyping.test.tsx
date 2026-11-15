// @vitest-environment jsdom
import { act, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { StructuredManuscriptEditor } from './StructuredManuscriptEditor'
import { CollaborativeDocument } from './sharedEditor/collaboration'
import { projectCollaborationPortableSource } from './sharedEditor/collaborationCheckpoint'
import type { CollaborativeEditorBinding } from './sharedEditor/prosemirrorCollaboration'

const seed = '---\nbibliography: references.json\n---\n\n# Selective synchronization verification\n\nWrite locally and online without losing either version.\n\n![A triangle for the synchronization test.](figures/check.svg){#fig-sync-check}\n\nA shared reference [@sync2026].\n'
let container: HTMLDivElement
let root: Root
let left: CollaborativeDocument
let right: CollaborativeDocument
let disconnect: Array<() => void>

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  if (!HTMLElement.prototype.scrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} })
  if (!Range.prototype.getClientRects) Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] })
  if (!Range.prototype.getBoundingClientRect) Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }) })
  left = CollaborativeDocument.fromPortableSource(seed)
  right = new CollaborativeDocument()
  right.applyUpdate(left.encodeUpdate(), 'seed')
  disconnect = [
    left.onUpdate((update, origin) => { if (origin !== 'right-peer') right.applyUpdate(update, 'left-peer') }),
    right.onUpdate((update, origin) => { if (origin !== 'left-peer') left.applyUpdate(update, 'right-peer') }),
  ]
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); disconnect.forEach((stop) => stop()); left.destroy(); right.destroy(); container.remove(); vi.restoreAllMocks() })

it('publishes actual rendered text input to the portable Y.Text and the remote source observer', async () => {
  const sources = { left: seed, right: seed }
  const binding = (document: CollaborativeDocument): CollaborativeEditorBinding => ({
    document: document.doc, awareness: document.awareness,
    publishPortableSource: (source) => { document.reconcilePortableSource(source, 'local-portable-source'); return projectCollaborationPortableSource(document) },
  })
  const bindings = { left: binding(left), right: binding(right) }
  function Peers() {
    const [local, setLocal] = useState(seed), [remote, setRemote] = useState(seed)
    useEffect(() => right.onPortableUpdate(() => { const source = projectCollaborationPortableSource(right); sources.right = source; setRemote(source) }), [])
    return <>
      <StructuredManuscriptEditor source={local} collaboration={bindings.left} onChange={(source) => { sources.left = source; setLocal(source) }} ariaLabel="Local rendered manuscript" />
      <StructuredManuscriptEditor source={remote} collaboration={bindings.right} onChange={setRemote} ariaLabel="Remote rendered manuscript" />
    </>
  }
  await act(async () => root.render(<Peers />))
  const editor = container.querySelector<HTMLElement>('[aria-label="Local rendered manuscript"]')!
  const paragraph = [...editor.querySelectorAll('p')].find((node) => node.textContent === 'Write locally and online without losing either version.')!
  await act(async () => {
    paragraph.firstChild!.nodeValue += ' Browser round trip verified.'
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ' Browser round trip verified.' }))
    await new Promise((resolve) => window.setTimeout(resolve, 20))
  })
  expect(left.source).toContain('Browser round trip verified.')
  expect(right.source).toContain('Browser round trip verified.')
  expect(sources.left).toContain('Browser round trip verified.')
  expect(sources.right).toContain('Browser round trip verified.')
  expect(container.querySelector('[aria-label="Remote rendered manuscript"]')?.textContent).toContain('Browser round trip verified.')
})
