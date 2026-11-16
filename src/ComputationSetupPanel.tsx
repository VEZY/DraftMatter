import { Children, type ReactNode } from 'react'
import { Icon } from './Icon'
import './computationSetupPanel.css'

export interface ComputationRuntimeSummary {
  language: 'python' | 'r' | 'julia'
  label: string
  status: 'ready' | 'available' | 'missing' | 'not-checked' | 'unhealthy'
  detail?: string
}

export interface ComputationSetupPanelProps {
  runtimes: readonly ComputationRuntimeSummary[]
  discovering?: boolean
  checkingLanguage?: ComputationRuntimeSummary['language']
  preparing?: boolean
  trusted?: boolean
  projectTrust?: ReactNode
  onOpenDocumentation?: () => void
  expandedLanguage?: ComputationRuntimeSummary['language']
  onToggleLanguage: (language: ComputationRuntimeSummary['language']) => void
  onCheckLanguage: (language: ComputationRuntimeSummary['language']) => void
  languageOptions?: Partial<Record<ComputationRuntimeSummary['language'], ReactNode>>
  onPrepareEnvironments?: () => void
  setupSource?: ReactNode
  onCreateSetup?: () => void
  computedValueSource?: ReactNode
  manuscriptSource?: ReactNode
  runControls?: ReactNode
  notices?: ReactNode
}

const runtimeStatus: Record<ComputationRuntimeSummary['status'], string> = {
  ready: 'Kernel detected',
  available: 'Installed only',
  missing: 'Not installed',
  'not-checked': 'Not checked',
  unhealthy: 'Needs attention',
}

/** Explain the execution concepts without making a shared setup a mandatory first cell. */
export function ComputationSetupPanel({
  runtimes, discovering = false, checkingLanguage, preparing = false, trusted = false, projectTrust,
  onOpenDocumentation, expandedLanguage, onToggleLanguage, onCheckLanguage, languageOptions,
  onPrepareEnvironments, setupSource, onCreateSetup, computedValueSource,
  manuscriptSource, runControls, notices,
}: ComputationSetupPanelProps) {
  const hasSetup = Children.toArray(setupSource).length > 0
  const hasComputedValues = Children.toArray(computedValueSource).length > 0
  const hasManuscriptCode = Children.toArray(manuscriptSource).length > 0
  return <div className="computation-setup-panel">
    <section className="computation-setup-section" aria-labelledby="computation-environment-heading">
      <div className="computation-setup-heading"><Icon name="settings" size={17} /><h3 id="computation-environment-heading">Language environment</h3></div>
      <p>Check a language, then expand its options to choose an environment or install tools. A detected kernel is verified again when you run code.</p>
      {projectTrust}
      {onOpenDocumentation && <button className="computation-language-help" type="button" onClick={onOpenDocumentation}><Icon name="document" size={13} />How languages work</button>}
      <ul className="computation-runtime-list" aria-label="Project language environments">
        {runtimes.map((runtime) => {
          const expanded = expandedLanguage === runtime.language
          const checking = discovering && (!checkingLanguage || checkingLanguage === runtime.language)
          return <li key={runtime.language} className={expanded ? 'expanded' : ''}>
            <div className="computation-language-header">
              <button type="button" className="computation-language-toggle" onClick={() => onToggleLanguage(runtime.language)} aria-label={`${runtime.label} environment options`} aria-expanded={expanded} aria-controls={`computation-language-${runtime.language}`}>
                <Icon name="chevronDown" className={expanded ? 'expanded' : ''} size={14} />
                <span><strong>{runtime.label}</strong>{runtime.detail && <small>{runtime.detail}</small>}</span>
                {runtime.status !== 'not-checked' && <span className={`computation-runtime-status ${runtime.status}`}>{runtimeStatus[runtime.status]}</span>}
              </button>
              <button type="button" className={`computation-check-language ${checking ? 'checking' : ''}`} aria-label={`Check ${runtime.label}`} disabled={!trusted || discovering || preparing} onClick={() => onCheckLanguage(runtime.language)}>{checking ? 'Checking…' : 'Check'}</button>
            </div>
            {expanded && <fieldset id={`computation-language-${runtime.language}`} className="computation-language-options" disabled={!trusted} aria-label={`${runtime.label} environment controls`}>{languageOptions?.[runtime.language] ?? <p>Check {runtime.label} to detect its environment and kernel.</p>}</fieldset>}
          </li>
        })}
      </ul>
      <div className="computation-setup-actions code-workspace-toolbar">
        {onPrepareEnvironments && <button type="button" onClick={onPrepareEnvironments} disabled={!trusted || preparing || discovering}>{preparing ? 'Preparing environments…' : 'Prepare project languages'}</button>}
      </div>
    </section>

    <section className="computation-setup-section" aria-labelledby="computation-shared-setup-heading">
      <div className="computation-setup-heading"><Icon name="code" size={17} /><h3 id="computation-shared-setup-heading">Shared setup <span>Optional</span></h3></div>
      <p>A setup cell holds imports, functions, or shared data. It runs first for its language in a fresh session and stays off the manuscript page.</p>
      <p className="computation-setup-hint">You can run a standalone calculation without creating a setup cell.</p>
      {hasSetup ? setupSource : onCreateSetup ? <button type="button" className="computation-add-setup" onClick={onCreateSetup}><Icon name="plus" size={14} />Add shared setup</button> : <p className="computation-setup-hint">This project has no shared setup cell.</p>}
    </section>

    <section className="computation-setup-section" aria-labelledby="computation-values-heading">
      <div className="computation-setup-heading"><Icon name="table" size={17} /><h3 id="computation-values-heading">Computed values</h3></div>
      <p>Calculations define named results. Choose <strong>Insert → Computed value</strong> to place a result inside a sentence or create its calculation. The calculation’s code stays here.</p>
      {hasComputedValues ? computedValueSource : <p className="computation-setup-hint">No computed value calculations yet.</p>}
    </section>

    {hasManuscriptCode && <section className="computation-setup-section" aria-labelledby="computation-manuscript-heading">
      <div className="computation-setup-heading"><Icon name="document" size={17} /><h3 id="computation-manuscript-heading">Calculations in the manuscript</h3></div>
      <p>Figure, table, and other code blocks stay with the paper. Add new figures and tables from <strong>Insert</strong>.</p>
      {manuscriptSource}
    </section>}

    {runControls && <fieldset disabled={!trusted} className="computation-project-actions" aria-label="Run project computations">{runControls}</fieldset>}
    {notices}
  </div>
}
