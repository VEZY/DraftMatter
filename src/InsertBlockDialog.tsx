import { useMemo, useState, type FormEvent } from 'react'
import { Icon } from './Icon'
import { isComputedValueKey, type RetainedComputedValue } from './computedValues'

export type InsertBlockRequest =
  | { kind: 'section'; title: string; level: number; label?: string }
  | { kind: 'figure'; source: string; alt: string; caption?: string; label?: string }
  | { kind: 'table'; rows: number; columns: number; caption?: string; label?: string }
  | { kind: 'equation-inline'; tex: string }
  | { kind: 'equation-display'; tex: string; label?: string }
  | { kind: 'cross-reference'; target: string }
  | { kind: 'footnote'; label: string; content: string }
  | { kind: 'code-cell'; language: 'python' | 'r' | 'julia' }
  | { kind: 'computed-value'; key: string }

export type InsertBlockKind = InsertBlockRequest['kind']

const details: Record<InsertBlockKind, { eyebrow: string; title: string; description: string }> = {
  section: { eyebrow: 'Document structure', title: 'Add section', description: 'Create a portable heading at the current block position.' },
  figure: { eyebrow: 'Visual evidence', title: 'Insert figure', description: 'Reference an image inside the project and keep its description portable.' },
  table: { eyebrow: 'Structured data', title: 'Insert table', description: 'Create an editable table with ordinary Markdown cells.' },
  'equation-inline': { eyebrow: 'Mathematics', title: 'Insert inline equation', description: 'Enter TeX without dollar-sign delimiters.' },
  'equation-display': { eyebrow: 'Mathematics', title: 'Insert display equation', description: 'Create a centered equation with an optional cross-reference label.' },
  'cross-reference': { eyebrow: 'Document link', title: 'Insert cross-reference', description: 'Link to a portable figure, table, equation, or section label.' },
  footnote: { eyebrow: 'Supporting note', title: 'Insert footnote', description: 'Create a reference here and its portable definition below.' },
  'code-cell': { eyebrow: 'Reproducible analysis', title: 'Insert code cell', description: 'Choose a language now; execution remains explicit and trusted.' },
  'computed-value': { eyebrow: 'Reproducible result', title: 'Insert computed value', description: 'Place a named result from a computation directly in the sentence.' },
}

function cleanLabel(value: string) {
  return value.trim().replace(/^[#@]/, '') || undefined
}

export function InsertBlockDialog({
  kind,
  onClose,
  onInsert,
  computedValues = [],
}: {
  kind: InsertBlockKind
  onClose: () => void
  onInsert: (request: InsertBlockRequest) => boolean
  computedValues?: RetainedComputedValue[]
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
  const [target, setTarget] = useState('')
  const [content, setContent] = useState('')
  const [language, setLanguage] = useState<'python' | 'r' | 'julia'>('python')
  const [computedKey, setComputedKey] = useState(computedValues[0]?.key ?? '')
  const [problem, setProblem] = useState('')

  const valid = useMemo(() => {
    if (kind === 'section') return Boolean(title.trim())
    if (kind === 'figure') return Boolean(source.trim() && alt.trim())
    if (kind === 'table') return rows >= 1 && rows <= 50 && columns >= 1 && columns <= 20
    if (kind === 'equation-inline' || kind === 'equation-display') return Boolean(tex.trim())
    if (kind === 'cross-reference') return /^(?:fig|tbl|eq|sec)-[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(target.trim().replace(/^@/, ''))
    if (kind === 'footnote') return /^[A-Za-z0-9_.:-]+$/.test(label.trim().replace(/^\[\^|\]$/g, '')) && Boolean(content.trim())
    if (kind === 'computed-value') return isComputedValueKey(computedKey.trim())
    return true
  }, [alt, columns, computedKey, content, kind, label, rows, source, target, tex, title])

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!valid) return
    let request: InsertBlockRequest
    if (kind === 'section') request = { kind, title: title.trim(), level, label: cleanLabel(label) }
    else if (kind === 'figure') request = { kind, source: source.trim(), alt: alt.trim(), caption: caption.trim() || undefined, label: cleanLabel(label) }
    else if (kind === 'table') request = { kind, rows, columns, caption: caption.trim() || undefined, label: cleanLabel(label) }
    else if (kind === 'equation-inline') request = { kind, tex: tex.trim() }
    else if (kind === 'equation-display') request = { kind, tex: tex.trim(), label: cleanLabel(label) }
    else if (kind === 'cross-reference') request = { kind, target: target.trim().replace(/^@/, '') }
    else if (kind === 'footnote') request = { kind, label: label.trim().replace(/^\[\^|\]$/g, ''), content: content.trim() }
    else if (kind === 'computed-value') request = { kind, key: computedKey.trim() }
    else request = { kind, language }
    if (onInsert(request)) onClose()
    else setProblem('The item could not be inserted at the current editor position. Place the cursor in the manuscript and try again.')
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
            {labelField('Cross-reference label', 'sec-discussion', 'Optional; portable section labels begin with sec-.')}
          </>}
          {kind === 'figure' && <>
            <label><span>Project-relative image path</span><input autoFocus value={source} onChange={(event) => setSource(event.target.value)} placeholder="figures/result.svg" spellCheck={false} /></label>
            <label><span>Accessible description</span><textarea value={alt} onChange={(event) => setAlt(event.target.value)} rows={2} placeholder="Describe the evidence shown in the figure" /></label>
            <label><span>Caption</span><textarea value={caption} onChange={(event) => setCaption(event.target.value)} rows={2} placeholder="Optional figure caption" /></label>
            {labelField('Cross-reference label', 'fig-result', 'Optional; portable figure labels begin with fig-.')}
          </>}
          {kind === 'table' && <>
            <div className="insert-block-grid"><label><span>Rows</span><input autoFocus type="number" min={1} max={50} value={rows} onChange={(event) => setRows(Number(event.target.value))} /></label><label><span>Columns</span><input type="number" min={1} max={20} value={columns} onChange={(event) => setColumns(Number(event.target.value))} /></label></div>
            <label><span>Caption</span><textarea value={caption} onChange={(event) => setCaption(event.target.value)} rows={2} placeholder="Optional table caption" /></label>
            {labelField('Cross-reference label', 'tbl-results', 'A table label requires a caption and begins with tbl-.')}
          </>}
          {(kind === 'equation-inline' || kind === 'equation-display') && <>
            <label><span>TeX equation</span><textarea autoFocus value={tex} onChange={(event) => setTex(event.target.value)} rows={kind === 'equation-display' ? 4 : 2} placeholder="R^2 = \\frac{a}{b}" spellCheck={false} /></label>
            {kind === 'equation-display' && labelField('Cross-reference label', 'eq-model', 'Optional; portable equation labels begin with eq-.')}
          </>}
          {kind === 'cross-reference' && <label><span>Target label</span><input autoFocus value={target} onChange={(event) => setTarget(event.target.value)} placeholder="fig-growth" spellCheck={false} /><small>Use an existing fig-, tbl-, eq-, or sec- label.</small></label>}
          {kind === 'footnote' && <>
            {labelField('Footnote label', 'method-note', 'Letters, numbers, dots, colons, underscores, and hyphens are supported.')}
            <label><span>Footnote text</span><textarea autoFocus value={content} onChange={(event) => setContent(event.target.value)} rows={4} placeholder="Supporting detail…" /></label>
          </>}
          {kind === 'code-cell' && <label><span>Language</span><select autoFocus value={language} onChange={(event) => setLanguage(event.target.value as typeof language)}><option value="python">Python</option><option value="r">R</option><option value="julia">Julia</option></select><small>DraftMatter keeps each language in an independent execution environment.</small></label>}
          {kind === 'computed-value' && <label><span>Result name</span><input autoFocus value={computedKey} onChange={(event) => setComputedKey(event.target.value)} list="computed-value-options" placeholder="mean_height" spellCheck={false} /><datalist id="computed-value-options">{computedValues.map((value) => <option key={value.key} value={value.key}>{value.value}</option>)}</datalist><small>{computedValues.length ? 'Choose a retained result or enter the name that its computation will produce.' : 'Enter the name emitted by a computation. It will show “Value unavailable” until that computation has run.'}</small></label>}
          {problem && <div className="insert-block-problem" role="alert">{problem}</div>}
        </div>

        <div className="execution-dialog-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary-button" type="submit" disabled={!valid}>Insert</button></div>
      </form>
    </div>
  )
}
