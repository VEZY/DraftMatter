// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { EditorView as CodeMirrorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutableCell } from './executionCells'
import { ManagedCodeCellEditor } from './ManagedCodeCellEditor'

const cell: ExecutableCell = {
  id: 'analysis-setup',
  language: 'python',
  source: 'threshold = 1',
  sourceHash: 'source-1',
  role: 'setup',
  attributes: {},
  classes: ['execute'],
  position: { startOffset: 0, endOffset: 13, startLine: 1, endLine: 1 },
}

describe('ManagedCodeCellEditor', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(async () => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('reports a successful source save immediately', async () => {
    const onSave = vi.fn(() => true)
    const onFormat = vi.fn(async () => 'threshold = 2')
    await act(async () => root.render(
      <ManagedCodeCellEditor cell={cell} readOnly={false} initiallyOpen onSave={onSave} onFormat={onFormat} />,
    ))

    const view = CodeMirrorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)!
    await act(async () => view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: 'threshold = 2' },
    }))
    expect(container.textContent).toContain('Unsaved source changes')

    await act(async () => container.querySelector<HTMLButtonElement>('.managed-code-actions .primary')!.click())

    expect(onSave).toHaveBeenCalledWith('analysis-setup', 'threshold = 2')
    expect(onFormat).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Saved in the project document')
    expect(container.querySelector<HTMLButtonElement>('.managed-code-actions .primary')?.disabled).toBe(true)
  })

  it('keeps failed saves visibly unsaved', async () => {
    const onSave = vi.fn(() => false)
    await act(async () => root.render(
      <ManagedCodeCellEditor cell={cell} readOnly={false} initiallyOpen onSave={onSave} />,
    ))

    const view = CodeMirrorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)!
    await act(async () => view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: 'threshold = 3' },
    }))
    await act(async () => container.querySelector<HTMLButtonElement>('.managed-code-actions .primary')!.click())

    expect(container.textContent).toContain('Unsaved source changes')
    expect(container.querySelector<HTMLButtonElement>('.managed-code-actions .primary')?.disabled).toBe(false)
  })
})
