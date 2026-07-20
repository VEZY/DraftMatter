import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Icon } from './Icon'
import type { DocumentDiagnostic } from './types'

const DIAGNOSTIC_PRIORITY: Record<DocumentDiagnostic['level'], number> = {
  error: 0,
  warning: 1,
  info: 2,
}

export function prioritizeProjectDiagnostics(diagnostics: DocumentDiagnostic[]) {
  return diagnostics
    .map((diagnostic, index) => ({ diagnostic, index }))
    .sort((left, right) => DIAGNOSTIC_PRIORITY[left.diagnostic.level] - DIAGNOSTIC_PRIORITY[right.diagnostic.level]
      || left.index - right.index)
    .map(({ diagnostic }) => diagnostic)
}

export type ProjectDiagnosticCategory = 'Source' | 'Citations' | 'Computation' | 'Outputs' | 'Export'
export type ProjectCheckAction = 'source' | 'citations' | 'computation' | 'export'

const PROJECT_DIAGNOSTIC_CATEGORIES: ProjectDiagnosticCategory[] = ['Source', 'Citations', 'Computation', 'Outputs', 'Export']

const CATEGORY_PATTERNS: Array<[ProjectDiagnosticCategory, RegExp]> = [
  ['Citations', /(?:^|-)(?:citation|citations|cite|citekey|bibliography|bibtex|csl|zotero|crossref|doi|ris|endnote)(?:-|$)/],
  ['Export', /(?:^|-)(?:export|docx|pdf|pandoc|quarto|submission)(?:-|$)/],
  ['Outputs', /(?:^|-)(?:output|outputs|artifact|figure|fig|table|tbl|retained)(?:-|$)|^reference-(?:output|target-orphaned)/],
  ['Computation', /(?:^|-)(?:execution|executable|kernel|runtime|environment|computation|published-value|setup-cell)(?:-|$)/],
]

const CATEGORY_ACTIONS: Record<ProjectDiagnosticCategory, { action: ProjectCheckAction; label: string } | undefined> = {
  Source: { action: 'source', label: 'View source' },
  Citations: { action: 'citations', label: 'Open citations' },
  Computation: { action: 'computation', label: 'Open code & computation' },
  Outputs: { action: 'computation', label: 'Open code & computation' },
  Export: { action: 'export', label: 'Open export options' },
}

const LEVEL_LABELS: Record<DocumentDiagnostic['level'], { singular: string; plural: string }> = {
  error: { singular: 'Error', plural: 'Errors' },
  warning: { singular: 'Warning', plural: 'Warnings' },
  info: { singular: 'Information', plural: 'Information' },
}

export function projectDiagnosticCategory(diagnostic: DocumentDiagnostic): ProjectDiagnosticCategory {
  const code = diagnostic.code.trim().toLocaleLowerCase()
  return CATEGORY_PATTERNS.find(([, pattern]) => pattern.test(code))?.[0] ?? 'Source'
}

export function projectDiagnosticCounts(diagnostics: DocumentDiagnostic[]) {
  return diagnostics.reduce((counts, diagnostic) => ({ ...counts, [diagnostic.level]: counts[diagnostic.level] + 1 }), {
    error: 0,
    warning: 0,
    info: 0,
  })
}

function DiagnosticRow({ diagnostic }: { diagnostic: DocumentDiagnostic }) {
  return (
    <div className={`diagnostic-${diagnostic.level}`} role="listitem">
      <i aria-hidden="true" />
      <span>{diagnostic.message}</span>
    </div>
  )
}

export function ProjectDiagnostics({
  diagnostics,
  previewCount = 3,
  onViewAll,
}: {
  diagnostics: DocumentDiagnostic[]
  previewCount?: number
  onViewAll?: () => void
}) {
  if (diagnostics.length === 0) return null
  const ordered = prioritizeProjectDiagnostics(diagnostics)
  const preview = ordered.slice(0, previewCount)
  const remaining = ordered.slice(previewCount)

  return (
    <section className="project-diagnostics" aria-label={`${ordered.length} project checks`}>
      <header><span>Project checks</span><small>{ordered.length}</small></header>
      <div className="project-diagnostic-list" role="list">
        {preview.map((diagnostic, index) => <DiagnosticRow diagnostic={diagnostic} key={`${diagnostic.code}-${index}`} />)}
      </div>
      {remaining.length > 0 && (
        <details>
          <summary>Show {remaining.length} more check{remaining.length === 1 ? '' : 's'}</summary>
          <div className="project-diagnostic-list" role="list">
            {remaining.map((diagnostic, index) => <DiagnosticRow diagnostic={diagnostic} key={`${diagnostic.code}-${preview.length + index}`} />)}
          </div>
        </details>
      )}
      {onViewAll && <button className="project-diagnostics-view-all" type="button" onClick={onViewAll}>View all checks</button>}
    </section>
  )
}

function ProjectCheckGroup({
  category,
  level,
  diagnostics,
  onAction,
}: {
  category: ProjectDiagnosticCategory
  level: DocumentDiagnostic['level']
  diagnostics: DocumentDiagnostic[]
  onAction?: (action: ProjectCheckAction) => void
}) {
  const action = CATEGORY_ACTIONS[category]
  const headingId = `project-check-group-${level}-${category.toLocaleLowerCase()}`
  return (
    <section className="project-check-group" aria-labelledby={headingId}>
      <header>
        <h4 id={headingId}>{category}</h4>
        {action && onAction && <button type="button" onClick={() => onAction(action.action)}>{action.label}</button>}
      </header>
      <ul>
        {diagnostics.map((diagnostic, index) => (
          <li className={`project-check-item diagnostic-${diagnostic.level}`} key={`${diagnostic.code}-${index}`}>
            <i aria-hidden="true" />
            <span><p>{diagnostic.message}</p><code>{diagnostic.code}</code></span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function ProjectChecksDialog({
  diagnostics,
  onClose,
  onAction,
}: {
  diagnostics: DocumentDiagnostic[]
  onClose: () => void
  onAction?: (action: ProjectCheckAction) => void
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const ordered = prioritizeProjectDiagnostics(diagnostics)
  const counts = projectDiagnosticCounts(ordered)

  useEffect(() => closeRef.current?.focus(), [])

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? [])]
    if (!focusable.length) return
    const first = focusable[0]
    const last = focusable.at(-1)!
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="modal-backdrop project-checks-backdrop" onMouseDown={onClose}>
      <div
        className="project-checks-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-checks-title"
        aria-describedby="project-checks-description"
        onKeyDown={handleKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="project-checks-head">
          <span className="project-checks-mark"><Icon name="spark" size={18} /></span>
          <span><small>Project health</small><h2 id="project-checks-title">Project checks</h2><p id="project-checks-description">Issues and notices reported by the current project state.</p></span>
          <button className="icon-button" type="button" ref={closeRef} onClick={onClose} aria-label="Close Project checks"><Icon name="close" /></button>
        </header>
        <div className="project-check-counts" aria-label={`${counts.error} errors, ${counts.warning} warnings, ${counts.info} informational checks`}>
          <span className="error"><strong>{counts.error}</strong><small>{counts.error === 1 ? 'Error' : 'Errors'}</small></span>
          <span className="warning"><strong>{counts.warning}</strong><small>{counts.warning === 1 ? 'Warning' : 'Warnings'}</small></span>
          <span className="info"><strong>{counts.info}</strong><small>Information</small></span>
        </div>
        <div className="project-checks-body">
          {ordered.length === 0 ? (
            <div className="project-checks-empty"><Icon name="check" size={22} /><strong>No project issues detected.</strong><p>DraftMatter has no source, citation, computation, output, or export checks to report.</p></div>
          ) : (['error', 'warning', 'info'] as const).map((level) => {
            const levelDiagnostics = ordered.filter((diagnostic) => diagnostic.level === level)
            if (!levelDiagnostics.length) return null
            return (
              <section className="project-check-severity" data-severity={level} key={level} aria-labelledby={`project-check-severity-${level}`}>
                <h3 id={`project-check-severity-${level}`}>{levelDiagnostics.length === 1 ? LEVEL_LABELS[level].singular : LEVEL_LABELS[level].plural}<small>{levelDiagnostics.length}</small></h3>
                {PROJECT_DIAGNOSTIC_CATEGORIES.map((category) => {
                  const grouped = levelDiagnostics.filter((diagnostic) => projectDiagnosticCategory(diagnostic) === category)
                  return grouped.length ? <ProjectCheckGroup category={category} level={level} diagnostics={grouped} onAction={onAction} key={category} /> : null
                })}
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}
