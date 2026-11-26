// @vitest-environment jsdom
import { act, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parseReviewMarkup } from './reviewMarkup'
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

it('keeps proposed wording out of both accepted manuscripts and lets its author revise the same suggestion', async () => {
  const binding = (doc: CollaborativeDocument): CollaborativeEditorBinding => ({
    document: doc.doc, awareness: doc.awareness,
    publishPortableSource: (source) => { doc.reconcilePortableSource(source); return projectCollaborationPortableSource(doc) },
  })
  const bindings = [binding(left), binding(right)]
  function Peers() {
    const [local, setLocal] = useState(seed), [remote, setRemote] = useState(seed)
    useEffect(() => right.onPortableUpdate(() => setRemote(projectCollaborationPortableSource(right))), [])
    return <>
      <StructuredManuscriptEditor source={local} collaboration={bindings[0]} onChange={setLocal} suggestionMode markupView="all" ariaLabel="Local manuscript" />
      <StructuredManuscriptEditor source={remote} collaboration={bindings[1]} onChange={setRemote} markupView="all" ariaLabel="Remote manuscript" />
    </>
  }
  await act(async () => root.render(<Peers />))
  const local = container.querySelector<HTMLElement>('[aria-label="Local manuscript"]')!
  const other = container.querySelector<HTMLElement>('[aria-label="Remote manuscript"]')!
  const paragraph = [...local.querySelectorAll('p')].find((node) => node.textContent?.startsWith('Write locally'))!
  const acceptedUpdates: string[] = []
  disconnect.push(right.onUpdate(() => acceptedUpdates.push(right.source)))
  await act(async () => {
    paragraph.firstChild!.nodeValue = paragraph.textContent!.replace('locally', 'offline')
    local.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'offline' }))
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  const field = local.querySelector<HTMLElement>('[aria-label="Edit suggested wording"]')!
  expect(field?.textContent).toBe('offline')
  expect(other.querySelector('.dm-review-proposal')?.textContent).toBe('offline')
  const id = field.dataset.proposalId
  const wording = field.querySelector('span')!.firstChild as Text
  await act(async () => {
    wording.data = 'together'
    field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'together' }))
    await new Promise((resolve) => setTimeout(resolve, 220))
  })
  expect(local.querySelector('[aria-label="Edit suggested wording"]')).toBe(field)
  expect(other.querySelector('.dm-review-proposal')?.textContent).toBe('together')
  expect(parseReviewMarkup(projectCollaborationPortableSource(right)).changes).toMatchObject([{ id, proposal: 'together' }])
  await act(async () => {
    field.focus()
    window.getSelection()!.collapse(wording, 0)
    document.dispatchEvent(new Event('selectionchange'))
    await new Promise((resolve) => setTimeout(resolve, 30))
    field.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowLeft' }))
  })
  expect(document.activeElement).toBe(local)
  await act(async () => {
    const marked = local.querySelector<HTMLElement>('.dm-review-change')!
    marked.firstChild!.nodeValue = 'away'
    local.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'away' }))
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  expect(parseReviewMarkup(projectCollaborationPortableSource(right)).changes).toMatchObject([{ id, proposal: 'away' }])
  expect(acceptedUpdates.every((text) => text.includes('Write locally and online'))).toBe(true)
  expect(other.querySelector('p')?.textContent).toContain('locally')
})

it('captures only the inserted letters immediately after collapsing a word selection', async () => {
  const binding: CollaborativeEditorBinding = {
    document: left.doc, awareness: left.awareness,
    publishPortableSource: (source) => { left.reconcilePortableSource(source); return projectCollaborationPortableSource(left) },
  }
  await act(async () => root.render(<StructuredManuscriptEditor source={seed} collaboration={binding}
    onChange={vi.fn()} suggestionMode markupView="all" ariaLabel="Local manuscript" />))
  const editor = container.querySelector<HTMLElement>('[aria-label="Local manuscript"]')!
  const paragraph = [...editor.querySelectorAll('p')].find((node) => node.textContent?.startsWith('Write locally'))!
  const text = paragraph.firstChild as Text
  const start = text.data.indexOf('locally')
  const selection = window.getSelection()!
  await act(async () => {
    editor.focus()
    selection.setBaseAndExtent(text, start, text, start + 'locally'.length)
    document.dispatchEvent(new Event('selectionchange'))
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  await act(async () => {
    // ArrowLeft can collapse the native selection before its selectionchange is delivered.
    selection.collapse(text, start)
    editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: 't' }))
    text.insertData(start, 't')
    selection.collapse(text, start + 1)
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 't' }))
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  expect(parseReviewMarkup(projectCollaborationPortableSource(right)).changes).toMatchObject([
    { changeKind: 'insert', proposal: 't' },
  ])
})
