import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, highlightSpecialChars, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from '@codemirror/commands'
import { defaultHighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { python } from '@codemirror/legacy-modes/mode/python'
import { r } from '@codemirror/legacy-modes/mode/r'
import { julia } from '@codemirror/legacy-modes/mode/julia'
import { javascript, typescript } from '@codemirror/legacy-modes/mode/javascript'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { yaml } from '@codemirror/legacy-modes/mode/yaml'
import { rust } from '@codemirror/legacy-modes/mode/rust'
import { c, cpp } from '@codemirror/legacy-modes/mode/clike'
import { css, sCSS } from '@codemirror/legacy-modes/mode/css'
import { xml, html } from '@codemirror/legacy-modes/mode/xml'
import { standardSQL } from '@codemirror/legacy-modes/mode/sql'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import { projectFileByteSize } from './projectFileInventory'
import { parseTablePreview, previewImageMediaType, previewText, projectPreviewKind, sanitizePreviewSvg } from './projectFilePreview'
import './projectFileViewer.css'

const MAX_TEXT_PREVIEW_BYTES = 1_048_576

export interface ProjectFileViewerProps {
  path: string
  bytes: Uint8Array
  totalBytes: number
  truncated: boolean
  provenance: string
  editable: boolean
  onSave?: (content: string) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
  onInsertFigure?: () => void
}

function language(path: string) {
  const extension = path.split('.').at(-1)?.toLowerCase()
  const mode = extension === 'py' ? python : extension === 'r' ? r : extension === 'jl' ? julia
    : /^(?:js|jsx|json|ipynb)$/.test(extension ?? '') ? javascript : /^(?:ts|tsx)$/.test(extension ?? '') ? typescript
      : /^(?:sh|bash|zsh)$/.test(extension ?? '') ? shell : extension === 'toml' ? toml : /^(?:yaml|yml)$/.test(extension ?? '') ? yaml
        : extension === 'rs' ? rust : /^(?:c|h)$/.test(extension ?? '') ? c : /^(?:cpp|cc|hpp)$/.test(extension ?? '') ? cpp
          : extension === 'css' ? css : extension === 'scss' ? sCSS : extension === 'xml' ? xml : /^(?:html|htm)$/.test(extension ?? '') ? html : extension === 'sql' ? standardSQL : null
  return mode ? StreamLanguage.define(mode) : []
}

interface MarkdownNode { type: string; value?: string; depth?: number; ordered?: boolean; start?: number; url?: string; alt?: string; children?: MarkdownNode[] }

function markdownNodes(nodes: MarkdownNode[]): ReactNode {
  return nodes.map((node, index) => {
    const children = node.children ? markdownNodes(node.children) : node.value ?? ''
    switch (node.type) {
      case 'heading': { const Tag = `h${Math.min(6, Math.max(1, node.depth ?? 1))}` as 'h1'; return <Tag key={index}>{children}</Tag> }
      case 'paragraph': return <p key={index}>{children}</p>
      case 'strong': return <strong key={index}>{children}</strong>
      case 'emphasis': return <em key={index}>{children}</em>
      case 'inlineCode': return <code key={index}>{node.value}</code>
      case 'code': return <pre key={index}><code>{node.value}</code></pre>
      case 'blockquote': return <blockquote key={index}>{children}</blockquote>
      case 'list': return node.ordered ? <ol key={index} start={node.start}>{children}</ol> : <ul key={index}>{children}</ul>
      case 'listItem': return <li key={index}>{children}</li>
      case 'thematicBreak': return <hr key={index} />
      case 'break': return <br key={index} />
      // Preview never loads remote images or embeds active HTML. Link destinations are visible but inert.
      case 'image': return <span key={index} className="file-preview-image-placeholder">[Image: {node.alt || node.url}]</span>
      case 'link': return <span key={index} title={node.url} className="file-preview-link">{children}</span>
      default: return <Fragment key={index}>{children}</Fragment>
    }
  })
}

function MarkdownPreview({ source }: { source: string }) {
  const nodes = useMemo(() => (unified().use(remarkParse).parse(source) as unknown as MarkdownNode).children ?? [], [source])
  return <article className="file-markdown-preview" aria-label="Rendered document">{markdownNodes(nodes)}</article>
}

function SourcePreview({ path, source, editable, visible, onSave, onDirtyChange }: {
  path: string; source: string; editable: boolean; visible: boolean
  onSave?: (content: string) => Promise<void>; onDirtyChange?: (dirty: boolean) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const permission = useRef(new Compartment())
  const saved = useRef(source)
  const [editing, setEditing] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState('')
  const [notice, setNotice] = useState('')
  const callbacks = useRef({ onSave, onDirtyChange, editable, editing, saving })
  callbacks.current = { onSave, onDirtyChange, editable, editing, saving }
  const save = useRef(async () => {})
  save.current = async () => {
    const current = callbacks.current
    if (!view.current || !current.onSave || !current.editable || !current.editing || current.saving) return
    const content = view.current.state.sliceDoc()
    if (content === saved.current) return
    setSaving(true); setProblem(''); setNotice('')
    try {
      await current.onSave(content)
      saved.current = content
      setDirty(view.current?.state.sliceDoc() !== content)
      setNotice('Saved.')
    } catch (error) { setProblem(error instanceof Error ? error.message : String(error)) }
    finally { setSaving(false) }
  }
  useEffect(() => {
    if (!host.current) return
    const editor = new EditorView({ parent: host.current, state: EditorState.create({ doc: source, extensions: [
      lineNumbers(), highlightSpecialChars(), history(), syntaxHighlighting(defaultHighlightStyle, { fallback: true }), language(path),
      EditorState.lineSeparator.of(source.match(/\r\n|\n|\r/)?.[0] ?? '\n'),
      permission.current.of([EditorState.readOnly.of(true), EditorView.editable.of(false)]),
      EditorView.contentAttributes.of({ 'aria-label': `Source of ${path}` }),
      keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { void save.current(); return true } }, indentWithTab, ...defaultKeymap, ...historyKeymap]),
      EditorView.updateListener.of((update) => { if (update.docChanged) { setDirty(update.state.sliceDoc() !== saved.current); setNotice('') } }),
    ] }) })
    view.current = editor
    return () => { view.current = null; editor.destroy() }
  // A viewer identity owns its draft and undo history. Reloading uses a new viewer identity.
  }, [path])
  useEffect(() => { callbacks.current.onDirtyChange?.(dirty) }, [dirty])
  useEffect(() => {
    const writable = editing && editable && !saving
    view.current?.dispatch({ effects: permission.current.reconfigure([EditorState.readOnly.of(!writable), EditorView.editable.of(writable)]) })
  }, [editing, editable, saving])
  useEffect(() => { if (visible) view.current?.requestMeasure() }, [visible])
  return <section className="file-source-preview" hidden={!visible} aria-label="File source">
    <div className="file-preview-toolbar">
      <span role="status">{dirty ? 'Unsaved changes' : notice || (editing && editable ? 'Editing source' : 'Read-only source')}</span>
      {!editing && editable && onSave && <button type="button" onClick={() => { setEditing(true); requestAnimationFrame(() => view.current?.focus()) }}>Edit source</button>}
      {editing && <>
        <button type="button" disabled={!editable || saving} onClick={() => { if (view.current) undo(view.current) }}>Undo</button>
        <button type="button" disabled={!editable || saving} onClick={() => { if (view.current) redo(view.current) }}>Redo</button>
        <button type="button" disabled={!dirty || saving} onClick={() => {
          const editor = view.current
          if (editor) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: saved.current } })
          setProblem(''); setNotice('Changes discarded.')
        }}>Discard changes</button>
        <button type="button" className="primary" disabled={!dirty || !editable || saving} onClick={() => void save.current()}>{saving ? 'Saving…' : 'Save file'}</button>
      </>}
    </div>
    {problem && <p className="file-preview-problem" role="alert">{problem} Your edits are still available. Keep a copy before reloading the file.</p>}
    <div ref={host} className="file-preview-code" />
  </section>
}

function ImagePreview({ path, bytes, truncated, onInsertFigure }: Pick<ProjectFileViewerProps, 'path' | 'bytes' | 'truncated' | 'onInsertFigure'>) {
  const [zoom, setZoom] = useState(0)
  const [dimensions, setDimensions] = useState('')
  const [naturalWidth, setNaturalWidth] = useState(0)
  const [problem, setProblem] = useState('')
  const [image, setImage] = useState<{ url?: string; problem?: string }>({})
  useEffect(() => {
    setProblem(''); setDimensions(''); setNaturalWidth(0)
    if (truncated) { setImage({ problem: 'This image exceeds the preview limit. Download it to view the full image.' }); return }
    try {
      const extension = path.split('.').at(-1)?.toLowerCase()
      const mediaType = previewImageMediaType(path, bytes)
      const blob = new Blob([extension === 'svg' ? sanitizePreviewSvg(new TextDecoder().decode(bytes)) : Uint8Array.from(bytes).buffer], { type: mediaType })
      const url = URL.createObjectURL(blob)
      setImage({ url })
      return () => URL.revokeObjectURL(url)
    } catch (error) { setImage({ problem: error instanceof Error ? error.message : String(error) }) }
  }, [path, bytes, truncated])
  if (image.problem || problem) return <p className="file-preview-problem" role="alert">{image.problem || problem}</p>
  return <section className="file-image-preview" aria-label="Image preview">
    <div className="file-preview-toolbar"><span>{dimensions || 'Reading image dimensions…'}</span><label>Zoom <select aria-label="Image zoom" value={zoom} onChange={(event) => setZoom(Number(event.target.value))}><option value={0}>Fit</option><option value={50}>50%</option><option value={100}>100%</option><option value={200}>200%</option></select></label>{onInsertFigure && <button type="button" onClick={onInsertFigure}>Insert as figure</button>}</div>
    <div className={`file-image-canvas ${zoom ? 'zoomed' : 'fit'}`}><img src={image.url} alt={path} onLoad={(event) => { setNaturalWidth(event.currentTarget.naturalWidth); setDimensions(`${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight} px`) }} onError={() => setProblem('This image could not be displayed.')} style={zoom && naturalWidth ? { width: `${naturalWidth * zoom / 100}px`, maxWidth: 'none' } : undefined} /></div>
  </section>
}

export function ProjectFileViewer(props: ProjectFileViewerProps) {
  const { path, bytes, totalBytes, truncated, provenance, editable, onSave, onDirtyChange, onInsertFigure } = props
  const kind = projectPreviewKind(path)
  const boundedBytes = useMemo(() => kind === 'image' ? bytes : bytes.subarray(0, MAX_TEXT_PREVIEW_BYTES), [bytes, kind])
  const partial = truncated || (kind !== 'image' && bytes.byteLength > MAX_TEXT_PREVIEW_BYTES)
  const text = useMemo(() => kind === 'image' || kind === 'unsupported' ? null : previewText(boundedBytes, partial), [boundedBytes, kind, partial])
  const [mode, setMode] = useState<'preview' | 'source'>(kind === 'text' ? 'source' : 'preview')
  const [query, setQuery] = useState('')
  const table = useMemo(() => kind === 'table' && text !== null ? parseTablePreview(text, /\.tsv$/i.test(path) ? '\t' : ',', partial) : null, [kind, text, path, partial])
  const filteredRows = table?.rows.filter((row) => !query || row.some((cell) => cell.toLocaleLowerCase().includes(query.toLocaleLowerCase()))) ?? []
  return <section className="project-file-viewer" aria-label={`Preview of ${path}`}>
    <header className="file-preview-heading"><strong>{path}</strong><span>{provenance} · {projectFileByteSize(totalBytes)}</span></header>
    {(partial || table?.truncated) && <p className="file-preview-limited" role="status">Limited preview: {partial ? `first ${projectFileByteSize(boundedBytes.byteLength)} of ${projectFileByteSize(totalBytes)}` : 'up to 500 rows, 100 columns and 10,000 characters per cell'}. The complete file is unchanged. Truncated files cannot be edited here.</p>}
    {kind === 'image' ? <ImagePreview {...{ path, bytes, truncated, onInsertFigure }} /> : text === null ? <p className="file-preview-unavailable">No preview is available for this file type or encoding. Use Download or your computer’s file manager to open it.</p> : <>
      {(kind === 'markdown' || kind === 'table') && <div className="file-preview-toolbar" role="group" aria-label="Preview format"><button type="button" aria-pressed={mode === 'preview'} onClick={() => setMode('preview')}>{kind === 'table' ? 'Table' : 'Rendered'}</button><button type="button" aria-pressed={mode === 'source'} onClick={() => setMode('source')}>View source</button></div>}
      {kind === 'markdown' && mode === 'preview' && <MarkdownPreview source={text} />}
      {table && mode === 'preview' && <section className="file-table-preview" aria-label="Table preview"><label className="file-table-filter">Filter preview rows <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} /></label><p role="status">{filteredRows.length} of {table.rows.length} preview rows</p><div className="file-table-scroll"><table><thead><tr><th scope="col">Row</th>{table.headers.map((header, index) => <th scope="col" key={index}>{header || `Column ${index + 1}`}</th>)}</tr></thead><tbody>{table.rows.map((row, rowIndex) => filteredRows.includes(row) ? <tr key={rowIndex}><th scope="row">{rowIndex + 1}</th>{Array.from({ length: table.headers.length }, (_, index) => <td key={index}>{row[index] ?? ''}</td>)}</tr> : null)}</tbody></table></div></section>}
      <SourcePreview path={path} source={text} visible={mode === 'source'} editable={editable && !partial} onSave={onSave} onDirtyChange={onDirtyChange} />
    </>}
  </section>
}
