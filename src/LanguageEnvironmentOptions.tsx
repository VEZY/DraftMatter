import type { ExecutionLanguage } from './executionCells'
import type { JupyterKernelProbe } from './runtimeDiscovery'

export interface LanguageEnvironmentOptionsProps {
  language: ExecutionLanguage
  label: string
  checked: boolean
  kernels: readonly JupyterKernelProbe[]
  selectedKernel?: JupyterKernelProbe
  unavailableKernelName?: string
  environmentPath?: string
  setupAvailable: boolean
  busy?: boolean
  setupBusy?: boolean
  formatterBusy?: boolean
  formatterAvailable?: boolean
  formatterVersion?: string
  installationGuidance?: string
  problem?: string
  onSelectKernel: (name: string) => void
  onSetup: () => void
  onInstallFormatter: () => void
  onRestart: () => void
  onTerminate: () => void
  onManagePackages?: () => void
}

const explanations: Record<ExecutionLanguage, string> = {
  python: 'Python dependencies are kept in this project’s .venv, with pyproject.toml and uv.lock.',
  r: 'R dependencies are kept in this project’s isolated renv library and renv.lock.',
  julia: 'Julia dependencies are kept in this project’s Project.toml and Manifest.toml.',
}

export function LanguageEnvironmentOptions({
  language, label, checked, kernels, selectedKernel, unavailableKernelName, environmentPath,
  setupAvailable, busy = false, setupBusy = false, formatterBusy = false, formatterAvailable = false,
  formatterVersion, installationGuidance, problem, onSelectKernel, onSetup, onInstallFormatter,
  onRestart, onTerminate, onManagePackages,
}: LanguageEnvironmentOptionsProps) {
  const formatter = language === 'python' ? 'Ruff' : language === 'r' ? 'styler' : 'JuliaFormatter'
  return <>
    <label className="computation-environment-select">
      <strong>{label} environment</strong>
      <select aria-label={`${label} Jupyter kernel`} value={selectedKernel?.name ?? ''} onChange={(event) => onSelectKernel(event.currentTarget.value)} disabled={!checked || !kernels.length || busy}>
        {unavailableKernelName && <option value="" disabled>{unavailableKernelName} · unavailable</option>}
        {!checked || (!kernels.length && !unavailableKernelName) ? <option value="">{checked ? 'No healthy kernel found' : 'Check this language first'}</option> : kernels.map((kernel) => <option value={kernel.name} key={kernel.name}>{kernel.displayName}</option>)}
      </select>
      <small>{selectedKernel ? `${selectedKernel.displayName} · ${selectedKernel.executable ?? selectedKernel.resourceDir}` : environmentPath ? `Saved environment · ${environmentPath} · integration unavailable` : checked ? 'No environment selected' : 'Use Check to detect an installed language and its kernels.'}</small>
    </label>
    <p>{explanations[language]}</p>
    {setupAvailable && <div className="computation-formatter-option">
      <span><strong>Automatic code formatting</strong><small>{formatterAvailable ? `${formatter}${formatterVersion ? ` ${formatterVersion}` : ''} is available in the selected environment.` : `Install ${formatter} into the selected environment.`}</small></span>
      <button type="button" onClick={onInstallFormatter} disabled={busy || formatterBusy || setupBusy}>{formatterBusy ? 'Installing…' : formatterAvailable ? `Repair ${formatter}` : `Install ${formatter}`}</button>
    </div>}
    {installationGuidance && <p role="status" className="computation-language-guidance">{installationGuidance}</p>}
    {problem && <p role="alert" className="computation-language-problem">{problem}</p>}
    <div className="computation-language-actions">
      {(setupAvailable || language === 'python') && <button type="button" onClick={onSetup} disabled={busy || formatterBusy || setupBusy}>{setupBusy ? 'Setting up…' : selectedKernel ? 'Repair integration' : `Set up ${label}`}</button>}
      <button type="button" onClick={onRestart} disabled={busy || !selectedKernel || setupBusy || formatterBusy}>Restart {label}</button>
      <button type="button" onClick={onTerminate} disabled={busy || !selectedKernel || setupBusy || formatterBusy}>Terminate {label}</button>
      {onManagePackages && <button type="button" onClick={onManagePackages} disabled={busy || setupBusy || formatterBusy}>Manage Julia packages</button>}
    </div>
  </>
}
