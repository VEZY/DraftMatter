import type { ExecutionAvailabilityView } from './retainedOutputs'

export function RuntimeProvenance({ view, readingMode = false }: { view: ExecutionAvailabilityView; readingMode?: boolean }) {
  return <div
    className={`runtime-provenance ${view.tone} ${readingMode ? 'reading' : ''}`}
    role={view.tone === 'warning' ? 'alert' : readingMode ? 'status' : 'note'}
    aria-label={view.message}
  >
    <span className="runtime-provenance-message">{readingMode && view.outputAvailable ? 'ⓘ' : view.message}</span>
    {!readingMode && view.provenance.length > 0 && <span className="runtime-provenance-detail">{view.provenance.join(' · ')}</span>}
  </div>
}
