import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { DEFAULT_MANUSCRIPT_SEARCH_SETTINGS, type ManuscriptSearchSettings, type ManuscriptSearchState } from './manuscriptSearch'
import './manuscriptFind.css'

export interface ManuscriptFindProps {
  query: string
  focusRequest?: number
  result: ManuscriptSearchState
  settings?: ManuscriptSearchSettings
  onSettingsChange?: (settings: ManuscriptSearchSettings) => void
  replacement?: string
  onReplacementChange?: (replacement: string) => void
  onReplace?: () => void
  onReplaceAll?: () => void
  canReplace?: boolean
  disabledReason?: string
  replacementMessage?: string
  onQueryChange: (query: string) => void
  onNext: () => void
  onPrevious: () => void
  onClose: () => void
}

export function ManuscriptFind({ query, focusRequest = 0, result, settings = DEFAULT_MANUSCRIPT_SEARCH_SETTINGS,
  onSettingsChange, replacement = '', onReplacementChange, onReplace, onReplaceAll, canReplace = true, disabledReason,
  replacementMessage, onQueryChange, onNext, onPrevious, onClose }: ManuscriptFindProps) {
  const input = useRef<HTMLInputElement>(null), replacementInput = useRef<HTMLInputElement>(null)
  const [replaceOpen, setReplaceOpen] = useState(false)
  useEffect(() => { input.current?.focus(); input.current?.select() }, [focusRequest])
  const replaceEnabled = canReplace && !result.error && Boolean(result.currentReplaceable)
  const replaceAllEnabled = canReplace && !result.error && Boolean(result.replaceable) && result.total < 10_000
  const toggle = (key: keyof ManuscriptSearchSettings) => onSettingsChange?.({ ...settings, [key]: !settings[key] })
  return <section className="manuscript-find" role="search" aria-label="Find in document" onKeyDown={(event) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
    else if (event.key === 'Enter' && event.target === input.current) { event.preventDefault(); event.stopPropagation(); if (event.shiftKey) onPrevious(); else onNext() }
    else if (event.key === 'Enter' && event.target === replacementInput.current) { event.preventDefault(); event.stopPropagation(); if (replaceEnabled) onReplace?.() }
  }}>
    <div className="manuscript-find-row">
      <button type="button" className="manuscript-find-expand" aria-label={replaceOpen ? 'Hide replace' : 'Show replace'} title={replaceOpen ? 'Hide replace' : 'Show replace'} aria-expanded={replaceOpen} onClick={() => setReplaceOpen(!replaceOpen)}><Icon name="chevronDown" className={replaceOpen ? undefined : 'manuscript-find-collapsed'} size={15} /></button>
      <input ref={input} type="search" aria-label="Find in document" placeholder="Find in document…" value={query} aria-invalid={Boolean(result.error)} aria-describedby={result.error ? 'manuscript-find-error' : undefined} onChange={(event) => onQueryChange(event.currentTarget.value)} />
      <output aria-live="polite" aria-atomic="true">{query ? `${result.current} of ${result.total}` : 'Find'}</output>
      <button type="button" aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={!result.total || Boolean(result.error)} onClick={onPrevious}><Icon name="chevronDown" className="manuscript-find-previous" size={15} /></button>
      <button type="button" aria-label="Next match" title="Next match (Enter)" disabled={!result.total || Boolean(result.error)} onClick={onNext}><Icon name="chevronDown" size={15} /></button>
      <button type="button" aria-label="Close document search" title="Close (Escape)" onClick={onClose}><Icon name="close" size={15} /></button>
    </div>
    <div className="manuscript-find-options" role="group" aria-label="Search options">
      <button type="button" aria-label="Match case" title="Match case" aria-pressed={settings.matchCase} onClick={() => toggle('matchCase')}>Aa</button>
      <button type="button" aria-label="Whole words" title="Whole words" aria-pressed={settings.wholeWord} onClick={() => toggle('wholeWord')}><span className="manuscript-find-whole-word">ab</span></button>
      <button type="button" aria-label="Use regular expression" title="Use regular expression" aria-pressed={settings.regex} onClick={() => toggle('regex')}>.*</button>
      <small>{settings.regex ? 'Regular expression' : 'Literal text'}</small>
    </div>
    {replaceOpen && <>
      <div className="manuscript-find-row manuscript-replace-row">
        <input ref={replacementInput} type="text" aria-label="Replace with" placeholder="Replace with…" value={replacement} disabled={!canReplace} onChange={(event) => onReplacementChange?.(event.currentTarget.value)} />
        <button type="button" className="manuscript-replace-action" disabled={!replaceEnabled} onClick={onReplace} title="Replace current match (Enter in replacement field)">Replace</button>
        <button type="button" className="manuscript-replace-action" disabled={!replaceAllEnabled} onClick={onReplaceAll}>Replace all</button>
      </div>
      <p className="manuscript-find-hint">Replaces editable manuscript text. Edit the title directly; references, generated results, table/equation captions, footnotes and protected items stay unchanged.</p>
      {!canReplace && <p className="manuscript-find-hint">{disabledReason || 'Replacement is unavailable in this read-only view.'}</p>}
      {settings.regex && <p className="manuscript-find-hint">Use $1 or $&lt;name&gt; for capture groups, $&amp; for the match and $$ for a dollar sign. Empty matches are ignored.</p>}
      {replacementMessage && <p className="manuscript-find-message" role="status">{replacementMessage}</p>}
    </>}
    {result.total >= 10_000 && <p className="manuscript-find-hint">Showing the first 10,000 matches. Narrow the search before replacing all.</p>}
    {result.error && <p id="manuscript-find-error" className="manuscript-find-error" role="alert">{result.error}</p>}
  </section>
}
