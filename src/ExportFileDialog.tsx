import { useMemo, useState, type FormEvent } from 'react'
import { exportFilenameProblem, type GeneratedFileExport } from './fileExport'
import { Icon } from './Icon'

export function ExportFileDialog({
  file,
  desktop,
  busy = false,
  problem = '',
  onClose,
  onSave,
}: {
  file: GeneratedFileExport
  desktop: boolean
  busy?: boolean
  problem?: string
  onClose: () => void
  onSave: (filename: string) => void
}) {
  const [filename, setFilename] = useState(file.suggestedName)
  const validation = useMemo(() => exportFilenameProblem(filename, file.suggestedName), [file.suggestedName, filename])
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!validation && !busy) onSave(filename.trim())
  }

  return (
    <div className="modal-backdrop export-file-backdrop" onMouseDown={() => { if (!busy) onClose() }}>
      <form className="export-file-dialog" onMouseDown={(event) => event.stopPropagation()} onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="export-file-title">
        <div className="execution-dialog-head">
          <span className="execution-shield"><Icon name="download" size={19} /></span>
          <div><span className="eyebrow">File export</span><h2 id="export-file-title">Save {file.formatLabel}</h2><p>Choose the file name here, then select its folder in the system save dialog.</p></div>
          <button className="icon-button" type="button" onClick={onClose} disabled={busy} aria-label="Close file export"><Icon name="close" /></button>
        </div>
        <label className="export-file-name"><span>File name</span><input autoFocus value={filename} onChange={(event) => setFilename(event.target.value)} aria-describedby="export-file-location-note" /></label>
        <p className="export-file-location" id="export-file-location-note"><Icon name="folder" size={14} />{desktop ? 'The next dialog lets you choose any local folder and confirms overwrites.' : 'Your browser will ask for a save location when supported; otherwise it uses your configured Downloads folder.'}</p>
        {validation && <p className="export-file-problem" role="alert">{validation}</p>}
        {problem && <p className="export-file-problem" role="alert">{problem}</p>}
        <div className="execution-dialog-actions"><button type="button" onClick={onClose} disabled={busy}>Cancel</button><button className="primary-button" type="submit" disabled={busy || Boolean(validation)}>{busy ? 'Saving…' : 'Choose location…'}</button></div>
      </form>
    </div>
  )
}
