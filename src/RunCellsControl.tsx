import { useEffect, useId, useRef, useState } from 'react'
import type { ExecutionLanguage } from './executionCells'
import { Icon } from './Icon'

type RunScope = 'all' | ExecutionLanguage

const scopes = [
  { id: 'all', label: 'All cells' },
  { id: 'python', label: 'Python' },
  { id: 'r', label: 'R' },
  { id: 'julia', label: 'Julia' },
] as const

export const RUN_ALL_CELLS_DESCRIPTION = 'Start fresh sessions and run every code cell to update computed values, figures, and tables.'

export function RunCellsControl({ languages, disabled, onRun }: {
  languages: ReadonlySet<ExecutionLanguage>
  disabled: boolean
  onRun: (scope: RunScope) => void
}) {
  const [selectedScope, setSelectedScope] = useState<RunScope>('all')
  const [open, setOpen] = useState(false)
  const control = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const popupId = useId()
  const scope = selectedScope === 'all' || languages.has(selectedScope) ? selectedScope : 'all'
  const label = scopes.find(({ id }) => id === scope)!.label
  const runLabel = scope === 'all' ? 'Run all cells' : `Run all ${label} cells`

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !control.current?.contains(event.target)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      if (control.current?.contains(document.activeElement)) trigger.current?.focus()
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  return <div className="topbar-run-cells" ref={control} role="group" aria-label="Run manuscript cells">
    <button type="button" className="compact-tool run-cells-play" aria-label={runLabel}
      data-tooltip={scope === 'all' ? `${runLabel} · starts fresh sessions` : runLabel}
      title={scope === 'all' ? RUN_ALL_CELLS_DESCRIPTION : `${runLabel} in document order in the shared kernel.`}
      disabled={disabled} onClick={() => { setOpen(false); onRun(scope) }}>
      <Icon name="play" size={14} />
    </button>
    <button type="button" className="compact-tool run-cells-scope" ref={trigger} aria-label={`Run scope: ${label}`}
      aria-expanded={open} aria-controls={open ? popupId : undefined} data-tooltip="Change which cells Play runs"
      onClick={() => setOpen((value) => !value)}>
      <Icon name="chevronDown" size={12} />
    </button>
    {open && <div className="popover run-cells-options" id={popupId} role="group" aria-label="Cells to run">
      <span>Run scope</span>
      {scopes.map(({ id, label: option }) => <button key={id} type="button" aria-pressed={scope === id}
        disabled={id !== 'all' && !languages.has(id)} onClick={() => {
          setSelectedScope(id)
          setOpen(false)
          trigger.current?.focus()
        }}>
        <span>{option}</span>{scope === id && <Icon name="check" size={14} />}
      </button>)}
    </div>}
  </div>
}
