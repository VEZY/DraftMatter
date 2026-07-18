import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { groupedCrossReferenceChoices, type CrossReferenceChoice } from './crossReferencePicker'
import type { SemanticManuscriptObject } from './semanticObjects'

export function CrossReferencePicker({
  objects,
  value,
  onChoose,
  autoFocus = false,
}: {
  objects: SemanticManuscriptObject[]
  value?: string
  onChoose: (choice: CrossReferenceChoice) => void
  autoFocus?: boolean
}) {
  const [query, setQuery] = useState('')
  const selectRef = useRef<HTMLSelectElement>(null)
  const resultsId = useId()
  const groups = useMemo(() => groupedCrossReferenceChoices(objects, query), [objects, query])
  const choices = groups.flatMap((group) => group.items)

  const chooseFirst = () => {
    if (!choices[0]) return
    onChoose(choices[0])
  }
  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      chooseFirst()
      selectRef.current?.focus()
    } else if (event.key === 'Enter' && choices.length) {
      event.preventDefault()
      chooseFirst()
    }
  }

  return <div className="cross-reference-picker">
    <label className="cross-reference-picker-search">
      <span>Find a manuscript object</span>
      <input
        autoFocus={autoFocus}
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={handleSearchKeyDown}
        placeholder="Search figures, tables, equations, or sections"
        aria-controls={resultsId}
      />
    </label>
    {choices.length ? <select
      ref={selectRef}
      id={resultsId}
      className="cross-reference-picker-results"
      aria-label="Cross-reference target"
      size={Math.min(8, Math.max(3, choices.length))}
      value={choices.some((choice) => choice.key === value) ? value : ''}
      onChange={(event) => {
        const choice = choices.find((candidate) => candidate.key === event.target.value)
        if (choice) onChoose(choice)
      }}
    >
      <option value="" disabled>Select an object</option>
      {groups.map((group) => <optgroup key={group.kind} label={group.label}>
        {group.items.map((choice) => <option key={choice.key} value={choice.key}>{choice.text}</option>)}
      </optgroup>)}
    </select> : <p className="cross-reference-picker-empty">No manuscript objects match “{query}”.</p>}
    <small>Numbers follow the object’s current position in the manuscript.</small>
  </div>
}
