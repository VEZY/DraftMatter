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

function DiagnosticRow({ diagnostic }: { diagnostic: DocumentDiagnostic }) {
  return (
    <div className={`diagnostic-${diagnostic.level}`} role="listitem">
      <i aria-hidden="true" />
      <span>{diagnostic.message}</span>
    </div>
  )
}

export function ProjectDiagnostics({ diagnostics, previewCount = 3 }: { diagnostics: DocumentDiagnostic[]; previewCount?: number }) {
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
    </section>
  )
}
