// @vitest-environment jsdom

import { act } from 'react'
import { undo } from '@codemirror/commands'
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
    if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList
    if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => new DOMRect()
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

    expect(onSave).toHaveBeenCalledWith('analysis-setup', 'threshold = 2', cell.source)
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
  const getView = () => CodeMirrorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)!
  const replaceCode = async (source: string) => {
    const view = getView()
    await act(async () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: source } }))
  }
  const button = (label: string) => Array.from(container.querySelectorAll('button')).find((item) => item.textContent === label)!
  const click = (label: string) => act(async () => button(label).click())

  it('opens the inline editor with the real source and saves formatted code before requesting execution', async () => {
    let saved = ''
    const onSave = vi.fn((_id: string, source: string) => { saved = source; return true })
    const onRun = vi.fn((_id: string, source: string) => { expect(source).toBe(saved) })
    const onFormat = vi.fn(async (id: string, source: string) => {
      expect([id, source]).toEqual([cell.id, 'threshold=2'])
      return 'threshold = 2'
    })
    await act(async () => root.render(<ManagedCodeCellEditor cell={cell} readOnly={false} inline focusOnOpen
      onSave={onSave} onFormat={onFormat} formatOnSave onRun={onRun} />))
    expect(getView().state.doc.toString()).toBe(cell.source)
    expect(document.activeElement).toBe(getView().contentDOM)
    await replaceCode('threshold=2')
    expect(onSave).toHaveBeenCalledWith(cell.id, 'threshold=2', cell.source)
    expect(onRun).not.toHaveBeenCalled()
    expect(onFormat).not.toHaveBeenCalled()
    expect(button('Revert')).toBeUndefined()
    expect(button('Save source')).toBeUndefined()
    expect(container.querySelector('[role="status"]')).toBeNull()
    await click('Run')
    expect(onRun).toHaveBeenCalledWith(cell.id, 'threshold = 2')
    expect(onSave).toHaveBeenLastCalledWith(cell.id, 'threshold = 2', 'threshold=2')
    expect(getView().state.doc.toString()).toBe('threshold = 2')
    await click('Run')
    expect(onFormat).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledTimes(2)
    expect(onRun).toHaveBeenCalledTimes(2)
  })

  it('does not run a cell after a refused save', async () => {
    const onRun = vi.fn()
    await act(async () => root.render(<ManagedCodeCellEditor cell={cell} readOnly={false}
      onSave={() => false} onRun={onRun} />))
    await replaceCode('threshold=4')
    await click('Save & run')
    expect(onRun).not.toHaveBeenCalled()
    expect(button('Revert').disabled).toBe(false)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not save')
  })

  it('autosaves successive web edits and undo while preserving editor focus and selection', async () => {
    const onSave = vi.fn(() => true)
    const note = 'Open in the desktop app to update the result.'
    const render = (source: string) => act(async () => root.render(<ManagedCodeCellEditor cell={{ ...cell, source }}
      readOnly={false} inline focusOnOpen sourceNote={note} onSave={onSave} />))
    await render(cell.source)
    expect(container.textContent).toContain(note)
    expect(container.querySelector('button')).toBeNull()
    const view = getView()
    await act(async () => {
      for (const char of ['2', '3']) {
        const end = view.state.doc.length
        view.dispatch({ changes: { from: end, insert: char }, selection: { anchor: end + 1 }, userEvent: 'input.type' })
      }
    })
    expect(onSave.mock.calls).toEqual([
      [cell.id, cell.source + '2', cell.source],
      [cell.id, cell.source + '23', cell.source + '2'],
    ])
    await render(cell.source + '23')
    expect(getView()).toBe(view)
    expect(document.activeElement).toBe(view.contentDOM)
    expect(view.state.selection.main.head).toBe(view.state.doc.length)
    // A remote insertion before this editor's edits should survive undo.
    await render('# test\n' + cell.source + '23')
    expect(view.state.selection.main.head).toBe(view.state.doc.length)
    expect(onSave).toHaveBeenCalledTimes(2)
    await act(async () => { expect(undo(view)).toBe(true) })
    expect(view.state.doc.toString()).toBe('# test\n' + cell.source)
    expect(onSave).toHaveBeenLastCalledWith(cell.id, '# test\n' + cell.source, '# test\n' + cell.source + '23')
  })

  it('lets readers inspect and receive source updates without writing or running', async () => {
    const onSave = vi.fn(() => true)
    const onRun = vi.fn()
    const render = (source: string) => act(async () => root.render(<ManagedCodeCellEditor cell={{ ...cell, source }}
      readOnly inline onSave={onSave} onRun={onRun} />))
    await render(cell.source)
    expect(getView().contentDOM.getAttribute('contenteditable')).toBe('false')
    expect(container.querySelector('button')).toBeNull()
    await render('shared source')
    expect(getView().state.doc.toString()).toBe('shared source')
    await act(async () => getView().contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true })))
    expect(onSave).not.toHaveBeenCalled()
    expect(onRun).not.toHaveBeenCalled()
  })

  it('keeps refused edits for a retry and withholds execution until they are stored', async () => {
    const onSave = vi.fn().mockReturnValueOnce(false).mockReturnValue(true)
    const onRun = vi.fn()
    await act(async () => root.render(<ManagedCodeCellEditor cell={cell} readOnly={false} inline onSave={onSave} onRun={onRun} />))
    await replaceCode('edited')
    expect(getView().state.doc.toString()).toBe('edited')
    expect(button('Run').disabled).toBe(true)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not save')
    await click('Retry')
    expect(onSave).toHaveBeenLastCalledWith(cell.id, 'edited', cell.source)
    expect(button('Run').disabled).toBe(false)
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(onRun).not.toHaveBeenCalled()
  })

  it('preserves a refused draft when the shared source changes and offers the latest stored source', async () => {
    const onSave = vi.fn(() => false)
    const onRun = vi.fn()
    const render = (source: string) => act(async () => root.render(<ManagedCodeCellEditor cell={{ ...cell, source }}
      readOnly={false} inline onSave={onSave} onRun={onRun} />))
    await render(cell.source)
    await replaceCode('my local edit')
    await render('updated by collaborator')
    expect(getView().state.doc.toString()).toBe('my local edit')
    expect(button('Run').disabled).toBe(true)
    expect(button('Retry')).toBeUndefined()
    await replaceCode('my adjusted local edit')
    expect(onSave).toHaveBeenCalledTimes(1)
    await click('Use saved source')
    expect(getView().state.doc.toString()).toBe('updated by collaborator')
    expect(button('Run').disabled).toBe(false)
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onRun).not.toHaveBeenCalled()
  })

  it('honours loss of edit access while waiting for a formatter on an already saved cell', async () => {
    let finishFormat!: (source: string) => void
    const onFormat = vi.fn(() => new Promise<string>((resolve) => { finishFormat = resolve }))
    const onSave = vi.fn(() => true)
    const onRun = vi.fn()
    const render = (readOnly: boolean) => act(async () => root.render(<ManagedCodeCellEditor cell={cell} readOnly={readOnly} inline
      onSave={onSave} onRun={onRun} onFormat={onFormat} formatOnSave />))
    await render(false)
    const editor = getView()
    await click('Run')
    expect(onFormat).toHaveBeenCalledWith(cell.id, cell.source, true)
    await render(true)
    await act(async () => finishFormat('formatted source'))
    expect(getView()).toBe(editor)
    expect(editor.state.readOnly).toBe(true)
    expect(editor.state.doc.toString()).toBe(cell.source)
    expect(onSave).not.toHaveBeenCalled()
    expect(onRun).not.toHaveBeenCalled()
  })

  it('preserves typing during asynchronous formatting', async () => {
    let finishFormat!: (source: string) => void
    const onFormat = vi.fn(() => new Promise<string>((resolve) => { finishFormat = resolve }))
    const onSave = vi.fn(() => true)
    const onRun = vi.fn()
    await act(async () => root.render(<ManagedCodeCellEditor cell={cell} readOnly={false} inline
      onSave={onSave} onRun={onRun} onFormat={onFormat} formatOnSave />))
    await replaceCode('threshold=2')
    await click('Run')
    await replaceCode('threshold=20')
    await act(async () => finishFormat('threshold = 2'))
    expect(getView().state.doc.toString()).toBe('threshold=20')
    expect(onSave).toHaveBeenCalledTimes(2)
    expect(onSave).toHaveBeenLastCalledWith(cell.id, 'threshold=20', 'threshold=2')
    expect(onRun).not.toHaveBeenCalled()
    expect(button('Run').disabled).toBe(false)
  })

})
