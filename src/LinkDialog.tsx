import { useMemo, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Icon } from './Icon'
import { isSafePortableLinkDestination } from './portableLink'

export function LinkDialog({
  onClose,
  onInsert,
}: {
  onClose: () => void
  onInsert: (href: string, title?: string) => boolean
}) {
  const [destination, setDestination] = useState('')
  const [title, setTitle] = useState('')
  const [problem, setProblem] = useState('')
  const valid = useMemo(() => isSafePortableLinkDestination(destination), [destination])

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!valid) return
    if (onInsert(destination.trim(), title.trim() || undefined)) onClose()
    else setProblem('Select the manuscript text that should become a link, then try again.')
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    onClose()
  }

  return (
    <div className="modal-backdrop execution-dialog-backdrop" onMouseDown={onClose}>
      <form className="insert-block-dialog link-dialog" onMouseDown={(event) => event.stopPropagation()} onKeyDown={handleKeyDown} onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="add-link-title">
        <div className="execution-dialog-head">
          <span className="execution-shield"><Icon name="link" size={19} /></span>
          <div><span className="eyebrow">Text formatting</span><h2 id="add-link-title">Add link</h2><p>Link the selected manuscript text to a web address, document fragment, or project file.</p></div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close link dialog"><Icon name="close" /></button>
        </div>

        <div className="insert-block-fields">
          <label><span>Link destination</span><input autoFocus value={destination} onChange={(event) => { setDestination(event.target.value); setProblem('') }} placeholder="https://example.org or notes/methods.md" spellCheck={false} /><small>Use a web address, fragment, or project-relative path without spaces.</small></label>
          <label><span>Link title</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Optional hover text" /><small>Optional; shown as supplementary hover text.</small></label>
          {destination && !valid && <div className="insert-block-problem" role="alert">Enter a portable destination without spaces or an unsafe script/data scheme.</div>}
          {problem && <div className="insert-block-problem" role="alert">{problem}</div>}
        </div>

        <div className="execution-dialog-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary-button" type="submit" disabled={!valid}>Add link</button></div>
      </form>
    </div>
  )
}
