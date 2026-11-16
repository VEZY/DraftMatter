import { useMemo, useState, type FormEvent } from 'react'
import { Icon } from './Icon'
import { isPublishedValueName, type RetainedPublishedValue } from './publishedValues'
import { CrossReferencePicker } from './SemanticObjectPicker'
import type { CrossReferenceChoice } from './crossReferencePicker'
import type { SemanticManuscriptObject } from './semanticObjects'
import { FIGURE_FILE_ACCEPT } from './figureImport'
import { renderEquation } from './equationRenderer'

export type InsertBlockRequest =
  | { kind: 'section'; title: string; level: number; label?: string }
  | { kind: 'figure'; source: string; alt: string; caption?: string; label?: string }
  | { kind: 'table'; rows: number; columns: number; caption?: string; label?: string }
  | { kind: 'equation-inline'; tex: string }
  | { kind: 'equation-display'; tex: string; caption?: string; label?: string }
  | { kind: 'cross-reference'; target: string; targetNodeId: string }
  | { kind: 'footnote'; label: string; content: string }
  | { kind: 'figure-cell'; language: 'python' | 'r' | 'julia' }
  | { kind: 'table-cell'; language: 'python' | 'r' | 'julia' }
  | { kind: 'values-cell'; language: 'python' | 'r' | 'julia' }
  | { kind: 'setup-cell'; language: 'python' | 'r' | 'julia' }
  | { kind: 'published-value'; name: string }

export type InsertBlockKind = InsertBlockRequest['kind']

const details: Record<InsertBlockKind, { eyebrow: string; title: string; description: string }> = {
  section: { eyebrow: 'Document structure', title: 'Add section', description: 'Create a new heading at the current position.' },
  figure: { eyebrow: 'Visual evidence', title: 'Insert figure', description: 'Add an image, an accessible description, and an optional caption.' },
  table: { eyebrow: 'Structured data', title: 'Insert table', description: 'Create a table whose cells can be edited directly.' },
  'equation-inline': { eyebrow: 'Mathematics', title: 'Insert inline equation', description: 'Enter the equation without surrounding delimiters.' },
  'equation-display': { eyebrow: 'Mathematics', title: 'Insert display equation', description: 'Create a centered equation that can be referenced elsewhere.' },
  'cross-reference': { eyebrow: 'Document link', title: 'Insert cross-reference', description: 'Link to a figure, table, equation, or section.' },
  footnote: { eyebrow: 'Supporting note', title: 'Insert footnote', description: 'Add supporting text at the current position.' },
  'figure-cell': { eyebrow: 'Reproducible result', title: 'Add reproducible figure', description: 'Create a manuscript code block whose retained figure appears with the paper.' },
  'table-cell': { eyebrow: 'Reproducible result', title: 'Add reproducible table', description: 'Create a manuscript code block whose retained table appears with the paper.' },
  'values-cell': { eyebrow: 'Computed values', title: 'Create a value calculation', description: 'Write a calculation that produces named results for your manuscript. Its code stays in Code & computation.' },
  'setup-cell': { eyebrow: 'Optional project code', title: 'Add shared setup', description: 'Keep imports, functions, and shared data in one setup cell. Standalone calculations do not require it.' },
  'published-value': { eyebrow: 'Reproducibility', title: 'Insert computed value', description: 'Place a named result from a calculation directly in the sentence.' },
}

function cleanLabel(value: string) {
  return value.trim().replace(/^[#@]/, '') || undefined
}

export function InsertBlockDialog({
  kind,
  onClose,
  onInsert,
  publishedValues = [],
  semanticObjects = [],
  onImportFigure,
  availableFigures = [],
  onCreateComputation,
}: {
  kind: InsertBlockKind
  onClose: () => void
  onInsert: (request: InsertBlockRequest) => boolean | Promise<boolean>
  publishedValues?: RetainedPublishedValue[]
  semanticObjects?: SemanticManuscriptObject[]
  onImportFigure?: (file: File) => Promise<{ source: string; alt: string }>
  availableFigures?: Array<{ path: string; label?: string }>
  onCreateComputation?: () => void
}) {
  const detail = details[kind]
  const [title, setTitle] = useState('')
  const [level, setLevel] = useState(2)
  const [label, setLabel] = useState('')
  const [source, setSource] = useState('')
  const [alt, setAlt] = useState('')
  const [caption, setCaption] = useState('')
  const [rows, setRows] = useState(2)
  const [columns, setColumns] = useState(2)
  const [tex, setTex] = useState('')
  const [targetChoice, setTargetChoice] = useState<CrossReferenceChoice>()
  const [content, setContent] = useState('')
  const [language, setLanguage] = useState<'python' | 'r' | 'julia'>('python')
  const [publishedName, setPublishedName] = useState(publishedValues[0]?.name ?? '')
  const [problem, setProblem] = useState('')
  const [importing, setImporting] = useState(false)
  const equationPreview = useMemo(() => (kind === 'equation-inline' || kind === 'equation-display') && tex.trim() ? renderEquation(tex, kind === 'equation-display') : undefined, [kind, tex])

  const importFigure = async (file: File) => {
    if (!onImportFigure || importing) return
    setImporting(true)
    setProblem('')
    try {
      const figure = await onImportFigure(file)
      setSource(figure.source)
      setAlt(figure.alt)
    } catch (error) { setProblem(error instanceof Error ? error.message : String(error)) }
    finally { setImporting(false) }
  }

  const valid = useMemo(() => {
    if (kind === 'section') return Boolean(title.trim())
    if (kind === 'figure') return Boolean(source.trim() && alt.trim())
    if (kind === 'table') return rows >= 1 && rows <= 50 && columns >= 1 && columns <= 20
    if (kind === 'equation-inline' || kind === 'equation-display') return Boolean(tex.trim())
    if (kind === 'cross-reference') return Boolean(targetChoice)
    if (kind === 'footnote') return /^[A-Za-z0-9_.:-]+$/.test(label.trim().replace(/^\[\^|\]$/g, '')) && Boolean(content.trim())
    if (kind === 'published-value') return isPublishedValueName(publishedName.trim())
    return true
  }, [alt, columns, content, kind, label, publishedName, rows, source, targetChoice, tex, title])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!valid) return
    let request: InsertBlockRequest
    if (kind === 'section') request = { kind, title: title.trim(), level, label: cleanLabel(label) }
    else if (kind === 'figure') request = { kind, source: source.trim(), alt: alt.trim(), caption: caption.trim() || undefined, label: cleanLabel(label) }
    else if (kind === 'table') request = { kind, rows, columns, caption: caption.trim() || undefined, label: cleanLabel(label) }
    else if (kind === 'equation-inline') request = { kind, tex: tex.trim() }
    else if (kind === 'equation-display') request = { kind, tex: tex.trim(), caption: caption.trim() || undefined, label: cleanLabel(label) }
    else if (kind === 'cross-reference') request = { kind, target: targetChoice!.target, targetNodeId: targetChoice!.nodeId }
    else if (kind === 'footnote') request = { kind, label: label.trim().replace(/^\[\^|\]$/g, ''), content: content.trim() }
    else if (kind === 'published-value') request = { kind, name: publishedName.trim() }
    else if (kind === 'setup-cell' || kind === 'figure-cell' || kind === 'table-cell' || kind === 'values-cell') request = { kind, language }
    else throw new Error(`Unsupported insertion kind: ${kind satisfies never}`)
    if (await onInsert(request)) onClose()
    else setProblem(kind === 'setup-cell' || kind === 'values-cell'
      ? 'The project code could not be added. Close this dialog and reopen the Code & computation panel before trying again.'
      : 'The item could not be inserted at the current editor position. Place the cursor in the manuscript and try again.')
  }

  const labelField = (captionText: string, placeholder: string, hint: string) => (
    <label><span>{captionText}</span><input value={label} onChange={(event) => setLabel(event.target.value)} placeholder={placeholder} spellCheck={false} /><small>{hint}</small></label>
  )

  return (
    <div className="modal-backdrop execution-dialog-backdrop" onMouseDown={onClose}>
      <form className="insert-block-dialog" onMouseDown={(event) => event.stopPropagation()} onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="insert-block-title">
        <div className="execution-dialog-head">
          <span className="execution-shield"><Icon name="plus" size={19} /></span>
          <div><span className="eyebrow">{detail.eyebrow}</span><h2 id="insert-block-title">{detail.title}</h2><p>{detail.description}</p></div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close insertion dialog"><Icon name="close" /></button>
        </div>

        <div className="insert-block-fields">
          {kind === 'section' && <>
            <label><span>Section title</span><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Discussion" maxLength={240} /></label>
            <label><span>Heading level</span><select value={level} onChange={(event) => setLevel(Number(event.target.value))}>{[1, 2, 3, 4, 5, 6].map((value) => <option value={value} key={value}>Heading {value}</option>)}</select></label>
            {labelField('Cross-reference label', 'sec-discussion', 'Leave blank to generate a readable portable sec- label.')}
          </>}
          {kind === 'figure' && <>
            {onImportFigure && <label className="figure-file-picker"><Icon name="image" size={24} /><strong>{importing ? 'Adding image…' : source ? source.split('/').at(-1) : 'Choose an image'}</strong><span>PNG, JPEG, SVG, GIF or WebP · up to 2 MB</span><input autoFocus type="file" accept={FIGURE_FILE_ACCEPT} aria-label="Choose figure image" disabled={importing} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importFigure(file) }} /><small>You can also drop an image directly into the manuscript.</small></label>}
            {availableFigures.length > 0 && <label><span>Or use a project image</span><select aria-label="Use existing project image" value={availableFigures.some((figure) => figure.path === source) ? source : ''} onChange={(event) => { setSource(event.target.value); if (!alt) setAlt(event.target.value.split('/').at(-1)?.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ') ?? '') }}><option value="">Choose from project files…</option>{availableFigures.map((figure) => <option key={figure.path} value={figure.path}>{figure.label ? `${figure.label} · ` : ''}{figure.path}</option>)}</select></label>}
            <label><span>Accessible description</span><textarea value={alt} onChange={(event) => setAlt(event.target.value)} rows={2} placeholder="Describe the evidence shown in the figure" /></label>
            <label><span>Caption</span><textarea value={caption} onChange={(event) => setCaption(event.target.value)} rows={2} placeholder="Optional figure caption" /></label>
            <details className="figure-advanced-options" open={!onImportFigure}><summary>Image path and reference label</summary><label><span>Project-relative image path</span><input value={source} onChange={(event) => setSource(event.target.value)} placeholder="figures/result.svg" spellCheck={false} /></label>{labelField('Cross-reference label', 'fig-result', 'Leave blank to generate a readable portable fig- label.')}</details>
          </>}
          {kind === 'table' && <>
            <div className="insert-block-grid"><label><span>Rows</span><input autoFocus type="number" min={1} max={50} value={rows} onChange={(event) => setRows(Number(event.target.value))} /></label><label><span>Columns</span><input type="number" min={1} max={20} value={columns} onChange={(event) => setColumns(Number(event.target.value))} /></label></div>
            <label><span>Caption</span><textarea value={caption} onChange={(event) => setCaption(event.target.value)} rows={2} placeholder="Optional table caption" /></label>
            {labelField('Cross-reference label', 'tbl-results', 'Leave blank to generate a readable portable tbl- label.')}
          </>}
          {(kind === 'equation-inline' || kind === 'equation-display') && <>
            <label><span>TeX equation</span><textarea autoFocus value={tex} onChange={(event) => setTex(event.target.value)} rows={kind === 'equation-display' ? 4 : 2} placeholder="R^2 = \\frac{a}{b}" spellCheck={false} /></label>
            <div className="equation-insertion-preview" aria-label="Equation preview"><small>Preview</small>{equationPreview?.error ? <span role="status">{equationPreview.error}</span> : equationPreview ? <div dangerouslySetInnerHTML={{ __html: equationPreview.html }} /> : <span>Your equation appears here as you type.</span>}</div>
            {kind === 'equation-display' && <label><span>Caption</span><textarea value={caption} onChange={(event) => setCaption(event.target.value)} rows={2} placeholder="Optional equation caption" /></label>}
            {kind === 'equation-display' && labelField('Cross-reference label', 'eq-model', 'Leave blank to generate a readable portable eq- label.')}
          </>}
          {kind === 'cross-reference' && <CrossReferencePicker
            autoFocus
            objects={semanticObjects}
            value={targetChoice?.key}
            onChoose={setTargetChoice}
          />}
          {kind === 'footnote' && <>
            {labelField('Footnote label', 'method-note', 'Letters, numbers, dots, colons, underscores, and hyphens are supported.')}
            <label><span>Footnote text</span><textarea autoFocus value={content} onChange={(event) => setContent(event.target.value)} rows={4} placeholder="Supporting detail…" /></label>
          </>}
          {(kind === 'figure-cell' || kind === 'table-cell') && <label><span>Language</span><select autoFocus value={language} onChange={(event) => setLanguage(event.target.value as typeof language)}><option value="python">Python</option><option value="r">R</option><option value="julia">Julia</option></select><small>The code block remains in the manuscript editor; publication exports use its retained result.</small></label>}
          {kind === 'values-cell' && <label><span>Language</span><select autoFocus value={language} onChange={(event) => setLanguage(event.target.value as typeof language)}><option value="python">Python</option><option value="r">R</option><option value="julia">Julia</option></select><small>Edit and run the calculation in Code &amp; computation, then choose Insert → Computed value to place one of its named results in the text. A shared setup cell is optional.</small></label>}
          {kind === 'setup-cell' && <label><span>Language</span><select autoFocus value={language} onChange={(event) => setLanguage(event.target.value as typeof language)}><option value="python">Python</option><option value="r">R</option><option value="julia">Julia</option></select><small>The shared setup runs first for this language in a fresh session. Its code stays in Code &amp; computation and does not appear in the manuscript.</small></label>}
          {kind === 'published-value' && <>
            <label><span>Value name</span><input autoFocus value={publishedName} onChange={(event) => setPublishedName(event.target.value)} list="published-value-options" placeholder="mean_height" spellCheck={false} /><datalist id="published-value-options">{publishedValues.map((value) => <option key={value.name} value={value.name}>{value.rendered}</option>)}</datalist><small>{publishedValues.length ? 'Choose a result from an existing calculation, or enter its name.' : 'A named result appears after its calculation has run. You can insert its name now; it shows “Value unavailable” until the result exists.'}</small></label>
            {onCreateComputation && <div className="computed-value-create-calculation"><p>Need to calculate a new result? Create its calculation, run it, then insert the result here.</p><button type="button" onClick={onCreateComputation}>Create a calculation…</button></div>}
          </>}
          {problem && <div className="insert-block-problem" role="alert">{problem}</div>}
        </div>

        <div className="execution-dialog-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary-button" type="submit" disabled={!valid || importing}>{kind === 'values-cell' ? 'Create calculation' : kind === 'setup-cell' ? 'Add shared setup' : 'Insert'}</button></div>
      </form>
    </div>
  )
}
