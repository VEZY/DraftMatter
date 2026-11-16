// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectFileViewer, type ProjectFileViewerProps } from './ProjectFileViewer'

describe('ProjectFileViewer', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  const bytes = new TextEncoder().encode('threshold = 1')
  const base: ProjectFileViewerProps = { path: 'analysis.py', bytes, totalBytes: bytes.length, truncated: false, provenance: 'Local file', editable: true }
  const button = (label: string) => Array.from(container.querySelectorAll('button')).find((element) => element.textContent === label)!
  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList
    if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => new DOMRect()
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  })
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('keeps the current image URL usable after StrictMode effect replay', async () => {
    const create = vi.fn().mockReturnValueOnce('blob:discarded').mockReturnValueOnce('blob:current')
    const revoke = vi.fn()
    vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL = revoke })
    const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])
    await act(async () => root.render(<StrictMode><ProjectFileViewer {...base} path="figure.png" bytes={bytes} totalBytes={bytes.length} /></StrictMode>))
    expect(create).toHaveBeenCalledTimes(2)
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:current')
    expect(revoke).toHaveBeenCalledWith('blob:discarded')
    expect(revoke).not.toHaveBeenCalledWith('blob:current')
  })

  it('requires explicit editing, preserves a failed-save draft and undo history, then reports success', async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new Error('The file changed on disk.')).mockResolvedValueOnce(undefined)
    const onDirtyChange = vi.fn()
    await act(async () => root.render(<ProjectFileViewer {...base} onSave={onSave} onDirtyChange={onDirtyChange} />))
    const editor = EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)!
    expect(editor.state.readOnly).toBe(true)
    await act(async () => button('Edit source').click())
    expect(editor.state.readOnly).toBe(false)
    await act(async () => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'threshold = 2' } }))
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
    await act(async () => button('Save file').click())
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('changed on disk')
    expect(editor.state.doc.toString()).toBe('threshold = 2')
    expect(button('Save file').disabled).toBe(false)
    await act(async () => button('Undo').click())
    expect(editor.state.doc.toString()).toBe('threshold = 1')
    await act(async () => button('Redo').click())
    await act(async () => button('Save file').click())
    expect(onSave).toHaveBeenLastCalledWith('threshold = 2')
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
    expect(container.textContent).toContain('Saved.')
  })

  it('renders untrusted Markdown as inert content and never fetches image or HTML resources', async () => {
    const source = '# My note\n\nHello **world**.\n\n![remote](https://evil.test/image.png)\n\n<script>alert(1)</script>\n<iframe src="https://evil.test" />'
    const note = new TextEncoder().encode(source)
    await act(async () => root.render(<ProjectFileViewer {...base} path="notes.md" bytes={note} totalBytes={note.length} />))
    expect(container.querySelector('h1')?.textContent).toBe('My note')
    expect(container.querySelector('strong')?.textContent).toBe('notes.md')
    expect(container.querySelector('article strong')?.textContent).toBe('world')
    expect(container.querySelector('img, script, iframe, a')).toBeNull()
    expect(container.textContent).toContain('remote')
    await act(async () => button('View source').click())
    expect(container.querySelector<HTMLElement>('.file-source-preview')?.hidden).toBe(false)
  })

  it('preserves UTF-8 BOM and CRLF when explicitly saving a script', async () => {
    const onSave = vi.fn(async () => {})
    const source = '\ufefffirst = 1\r\nsecond = 2\r\n'
    const bytes = new TextEncoder().encode(source)
    await act(async () => root.render(<ProjectFileViewer {...base} bytes={bytes} totalBytes={bytes.length} onSave={onSave} />))
    await act(async () => button('Edit source').click())
    const editor = EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)!
    await act(async () => editor.dispatch({ changes: { from: 9, to: 10, insert: '3' } }))
    await act(async () => button('Save file').click())
    expect(onSave).toHaveBeenCalledWith('\ufefffirst = 3\r\nsecond = 2\r\n')
  })

  it('filters CSV rows with stable row numbers and prevents truncated-file edits', async () => {
    const input = new TextEncoder().encode('name,value\nAlpha,1\nBeta,2\n')
    await act(async () => root.render(<ProjectFileViewer {...base} path="data/input.csv" bytes={input} totalBytes={100_000_000_000} truncated onSave={vi.fn()} />))
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2)
    const search = container.querySelector<HTMLInputElement>('input[type="search"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'Beta')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.querySelectorAll('tbody tr')).toHaveLength(1)
    expect(container.querySelector('tbody th')?.textContent).toBe('2')
    expect(container.textContent).toContain('Limited preview')
    await act(async () => button('View source').click())
    expect(button('Edit source')).toBeUndefined()
    expect(EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)!.state.readOnly).toBe(true)
  })
})
