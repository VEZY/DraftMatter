import { useEffect, useRef } from 'react'
import { Icon } from './Icon'
import type { ManuscriptSearchState } from './manuscriptSearch'
import './manuscriptFind.css'

export interface ManuscriptFindProps {
  query: string
  focusRequest?: number
  result: ManuscriptSearchState
  onQueryChange: (query: string) => void
  onNext: () => void
  onPrevious: () => void
  onClose: () => void
}

export function ManuscriptFind({ query, focusRequest = 0, result, onQueryChange, onNext, onPrevious, onClose }: ManuscriptFindProps) {
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus(); input.current?.select() }, [focusRequest])
  return <section className="manuscript-find" role="search" aria-label="Find in document" onKeyDown={(event) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
    else if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); if (event.shiftKey) onPrevious(); else onNext() }
  }}>
    <Icon name="search" size={16} />
    <input ref={input} type="search" aria-label="Find in document" placeholder="Find in document…" value={query} onChange={(event) => onQueryChange(event.currentTarget.value)} />
    <output aria-live="polite" aria-atomic="true">{query ? `${result.current} of ${result.total}` : 'Find'}</output>
    <button type="button" aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={!result.total} onClick={onPrevious}><Icon name="chevronDown" className="manuscript-find-previous" size={15} /></button>
    <button type="button" aria-label="Next match" title="Next match (Enter)" disabled={!result.total} onClick={onNext}><Icon name="chevronDown" size={15} /></button>
    <button type="button" aria-label="Close document search" title="Close (Escape)" onClick={onClose}><Icon name="close" size={15} /></button>
  </section>
}
