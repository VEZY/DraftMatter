import { useEffect, useState } from 'react'
import {
  desktopHost,
  normaliseHostFailure,
  type ExternalExportAdapter,
  type ExternalExportFormat,
  type ExternalExportTools,
} from './desktopHost'
import { Icon } from './Icon'

function extension(format: ExternalExportFormat) {
  return format
}

export function ExternalExportDialog({
  root,
  source,
  baseName,
  onClose,
  onNotice,
}: {
  root: string
  source: string
  baseName: string
  onClose: () => void
  onNotice: (message: string) => void
}) {
  const [tools, setTools] = useState<ExternalExportTools>()
  const [adapter, setAdapter] = useState<ExternalExportAdapter>('pandoc')
  const [format, setFormat] = useState<ExternalExportFormat>('html')
  const [outputName, setOutputName] = useState(`${baseName}.html`)
  const [busy, setBusy] = useState(true)
  const [problem, setProblem] = useState('')

  useEffect(() => {
    let disposed = false
    void desktopHost.probeExternalExportTools().then((result) => {
      if (disposed) return
      setTools(result)
      if (!result.pandoc.available && result.quarto.available) setAdapter('quarto')
    }).catch((error) => {
      if (!disposed) setProblem(normaliseHostFailure(error).message)
    }).finally(() => {
      if (!disposed) setBusy(false)
    })
    return () => { disposed = true }
  }, [])

  const changeFormat = (next: ExternalExportFormat) => {
    setFormat(next)
    setOutputName(`${baseName}.${extension(next)}`)
  }

  const selectedTool = tools?.[adapter]

  async function render() {
    if (!selectedTool?.available || !outputName.trim()) return
    setBusy(true)
    setProblem('')
    try {
      const result = await desktopHost.renderExternalExport({ root, adapter, format, source, outputName: outputName.trim() })
      onNotice(`${result.message} Saved to ${result.path}.`)
      onClose()
    } catch (error) {
      setProblem(normaliseHostFailure(error).message)
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop execution-dialog-backdrop" onMouseDown={() => { if (!busy) onClose() }}>
      <div className="external-export-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="external-export-title">
        <div className="execution-dialog-head">
          <span className="execution-shield"><Icon name="download" size={19} /></span>
          <div><span className="eyebrow">Optional system tools</span><h2 id="external-export-title">Pandoc or Quarto export</h2><p>DraftMatter passes a clean projection to the tool installed on this computer. Manuscript cells are never executed.</p></div>
          <button className="icon-button" onClick={onClose} disabled={busy} aria-label="Close external export"><Icon name="close" /></button>
        </div>

        <div className="external-tool-list" aria-label="Detected external renderers">
          {(['pandoc', 'quarto'] as const).map((name) => {
            const tool = tools?.[name]
            return <label className={`${adapter === name ? 'selected' : ''} ${tool && !tool.available ? 'unavailable' : ''}`} key={name}><input type="radio" name="external-adapter" value={name} checked={adapter === name} onChange={() => setAdapter(name)} disabled={!tool?.available} /><span><strong>{name === 'pandoc' ? 'Pandoc' : 'Quarto Pandoc'}</strong><small>{busy && !tools ? 'Detecting…' : tool?.available ? tool.version ?? tool.message : tool?.message ?? 'Not checked'}</small></span><i>{tool?.available ? 'Available' : 'Unavailable'}</i></label>
          })}
        </div>

        <div className="external-export-options">
          <label><span>Format</span><select value={format} onChange={(event) => changeFormat(event.target.value as ExternalExportFormat)}><option value="html">HTML</option><option value="docx">DOCX</option><option value="pdf">PDF</option></select></label>
          <label><span>Output file</span><input value={outputName} onChange={(event) => setOutputName(event.target.value)} /></label>
          <p><Icon name="folder" size={14} /> .draftmatter/exports/{outputName || '…'}</p>
        </div>

        <div className="external-safety-note"><Icon name="check" size={15} /><span><strong>Inert rendering boundary</strong><small>Review records are rejected. Quarto uses its Pandoc pass-through, not <code>quarto render</code>. Existing exports are never overwritten silently.</small></span></div>
        {problem && <div className="external-export-problem" role="alert">{problem}</div>}

        <div className="execution-dialog-actions">
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary-button" onClick={() => void render()} disabled={busy || !selectedTool?.available || !outputName.trim()}>{busy ? 'Checking…' : `Export with ${adapter === 'pandoc' ? 'Pandoc' : 'Quarto'}`}</button>
        </div>
      </div>
    </div>
  )
}
