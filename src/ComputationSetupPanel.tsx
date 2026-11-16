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
  preparing?: boolean
  onConfigureEnvironments: () => void
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
  runtimes, discovering = false, preparing = false, onConfigureEnvironments,
  onPrepareEnvironments, setupSource, onCreateSetup, computedValueSource,
  manuscriptSource, runControls, notices,
}: ComputationSetupPanelProps) {
  const hasSetup = Children.toArray(setupSource).length > 0
  const hasComputedValues = Children.toArray(computedValueSource).length > 0
  const hasManuscriptCode = Children.toArray(manuscriptSource).length > 0
  return <div className="computation-setup-panel">
    <section className="computation-setup-section" aria-labelledby="computation-environment-heading">
      <div className="computation-setup-heading"><Icon name="settings" size={17} /><h3 id="computation-environment-heading">Language environment</h3></div>
      <p>Check the language you want to use before running code. A detected kernel is checked again when you run a calculation; an installed language alone is not enough.</p>
      <ul className="computation-runtime-list" aria-label="Project language environments">
        {runtimes.map((runtime) => <li key={runtime.language}>
          <div><strong>{runtime.label}</strong>{runtime.detail && <small>{runtime.detail}</small>}</div>
          <span className={`computation-runtime-status ${discovering ? 'checking' : runtime.status}`}>{discovering ? 'Checking…' : runtimeStatus[runtime.status]}</span>
        </li>)}
      </ul>
      <div className="computation-setup-actions code-workspace-toolbar">
        <button type="button" onClick={onConfigureEnvironments} aria-label="Execution environments and options"><Icon name="settings" size={14} />Environments</button>
        {onPrepareEnvironments && <button type="button" onClick={onPrepareEnvironments} disabled={preparing || discovering}>{preparing ? 'Preparing environments…' : 'Prepare project languages'}</button>}
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

    {runControls && <div className="computation-project-actions" role="group" aria-label="Run project computations">{runControls}</div>}
    {notices}
  </div>
}
