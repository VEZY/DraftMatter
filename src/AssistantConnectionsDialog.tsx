import { useEffect, useState } from 'react'
import {
  desktopHost,
  type AssistantClientId,
  type AssistantConnectionOperation,
  type AssistantConnectionPlan,
  type AssistantConnectionsStatus,
} from './desktopHost'
import { Icon } from './Icon'
import './assistantConnections.css'

export function AssistantConnectionsDialog({
  open,
  onClose,
  onOpenLearn,
}: {
  open: boolean
  onClose: () => void
  onOpenLearn?: () => void
}) {
  const [status, setStatus] = useState<AssistantConnectionsStatus>()
  const [preview, setPreview] = useState<AssistantConnectionPlan>()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')

  const refresh = async () => {
    setBusy(true)
    setProblem('')
    try {
      setStatus(await desktopHost.assistantConnectionsStatus())
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!open) return
    setPreview(undefined)
    void refresh()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null

  const plan = async (client: AssistantClientId, operation: AssistantConnectionOperation, apply = false) => {
    setBusy(true)
    setProblem('')
    try {
      const result = await desktopHost.assistantConnectionAction(client, operation, apply)
      setPreview(result)
      if (apply && result.ok) {
        setStatus(await desktopHost.assistantConnectionsStatus())
        setPreview(undefined)
      }
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const selected = preview?.results[0]

  return (
    <div className="assistant-connections-backdrop" onMouseDown={onClose}>
      <section className="assistant-connections-dialog" role="dialog" aria-modal="true" aria-labelledby="assistant-connections-title" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <span className="home-kicker">Once per computer and AI client</span>
            <h2 id="assistant-connections-title">Connect AI assistants</h2>
            <p>Register the MCP server bundled with DraftMatter and its canonical authoring skill. This does not enable AI in any project.</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close assistant connections"><Icon name="close" /></button>
        </header>

        <div className="assistant-scope-strip">
          <span><Icon name="check" size={15} /><strong>Device/client-wide</strong><small>Codex, Claude Code, Copilot, or Vibe</small></span>
          <Icon name="arrowRight" size={16} />
          <span><Icon name="folder" size={15} /><strong>Project enablement stays separate</strong><small>Choose it inside each DraftMatter project</small></span>
        </div>

        {busy && !status && <p className="assistant-loading" role="status">Checking installed assistants…</p>}
        {problem && <p className="assistant-problem" role="alert">{problem}</p>}

        {selected ? (
          <div className="assistant-preview">
            <div className="assistant-preview-heading">
              <button onClick={() => setPreview(undefined)}><Icon name="undo" size={14} />Back</button>
              <div><span>Review changes</span><h3>{selected.operation[0].toUpperCase() + selected.operation.slice(1)} {selected.statusBefore.name}</h3></div>
            </div>
            <ul className="assistant-change-list">
              {selected.changes.map((change) => (
                <li key={`${change.kind}:${change.path}`} data-action={change.action}>
                  <span>{change.action}</span>
                  <div><code>{change.path}</code><small>{change.message}</small></div>
                </li>
              ))}
            </ul>
            {selected.conflicts.length > 0 && <p className="assistant-problem">Resolve the conflicts above or choose Repair to replace only DraftMatter-managed entries.</p>}
            <div className="assistant-safety-note">
              <Icon name="focus" size={17} />
              <span><strong>Connection only</strong><small>No model contact, code execution, project trust, citation-network access, or automatic tool approval.</small></span>
            </div>
            <details className="assistant-cli-fallback">
              <summary>Advanced CLI fallback</summary>
              <code>{selected.advancedCommand} --apply</code>
            </details>
            <footer>
              <button onClick={() => setPreview(undefined)}>Cancel</button>
              <button
                className="primary-button"
                disabled={busy || !selected.ok}
                onClick={() => void plan(selected.client, selected.operation, true)}
              >
                {busy ? 'Applying…' : selected.operation === 'remove' ? 'Remove connection' : `${selected.operation[0].toUpperCase() + selected.operation.slice(1)} connection`}
              </button>
            </footer>
          </div>
        ) : (
          <>
            <div className="assistant-client-list">
              {status?.clients.map((client) => (
                <article key={client.client} className="assistant-client-card">
                  <div className="assistant-client-title">
                    <span className={`assistant-detected ${client.detected ? 'yes' : 'no'}`}><Icon name={client.detected ? 'check' : 'info'} size={14} /></span>
                    <div><h3>{client.name}</h3><small>{client.detected ? 'Detected on this computer' : 'Not detected · connection can be prepared'}</small></div>
                    <strong className={client.connected ? 'connected' : 'not-connected'}>{client.connected ? 'Connected' : 'Not connected'}</strong>
                  </div>
                  <dl>
                    <div><dt>Bundled MCP</dt><dd>{client.mcpCurrent ? 'Current' : client.mcpInstalled ? 'Needs update' : 'Not installed'}</dd></div>
                    <div><dt>Canonical skill</dt><dd>{client.skillCurrent ? 'Current' : client.skillInstalled ? 'Needs update' : 'Not installed'}</dd></div>
                    <div><dt>Scope</dt><dd>{client.registrationMethod === 'codex-plugin' ? 'Codex plugin · user' : 'User/device-wide'}</dd></div>
                  </dl>
                  {client.notes[0] && <p>{client.notes[0]}</p>}
                  <div className="assistant-client-actions">
                    {!client.mcpInstalled && !client.skillInstalled && <button className="primary-button" onClick={() => void plan(client.client, 'install')} disabled={busy}>Install</button>}
                    {(client.mcpInstalled || client.skillInstalled) && !client.connected && <button onClick={() => void plan(client.client, 'update')} disabled={busy}>Update</button>}
                    {(client.mcpInstalled || client.skillInstalled) && <button onClick={() => void plan(client.client, 'repair')} disabled={busy}>Repair</button>}
                    {(client.mcpInstalled || client.skillInstalled) && <button onClick={() => void plan(client.client, 'remove')} disabled={busy}>Remove</button>}
                  </div>
                </article>
              ))}
            </div>
            <div className="assistant-dialog-footer">
              <p><strong>Next:</strong> enable AI separately inside each project you want an assistant to access.</p>
              {onOpenLearn && <button onClick={onOpenLearn}>How AI integration works <Icon name="arrowRight" size={14} /></button>}
            </div>
          </>
        )}
      </section>
    </div>
  )
}
