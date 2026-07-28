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
  const [notice, setNotice] = useState('')

  const refresh = async () => {
    setBusy(true)
    setProblem('')
    setNotice('')
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
    setNotice('')
    void refresh()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null

  const act = async (client: AssistantClientId, operation: AssistantConnectionOperation, apply = false) => {
    setBusy(true)
    setProblem('')
    setNotice('')
    try {
      const result = await desktopHost.assistantConnectionAction(client, operation, apply)
      if (apply && result.ok) {
        const nextStatus = await desktopHost.assistantConnectionsStatus()
        setStatus(nextStatus)
        setPreview(undefined)
        const name = nextStatus.clients.find((candidate) => candidate.client === client)?.name ?? 'Your assistant'
        setNotice(operation === 'remove'
          ? `${name} is no longer connected to DraftMatter.`
          : `${name} is connected. If it was already open, reopen it once to show the DraftMatter tools.`)
      } else {
        setPreview(result)
      }
    } catch (error) {
      setProblem(`DraftMatter could not update this connection. ${error instanceof Error ? error.message : String(error)}`)
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
            <span className="home-kicker">One-time setup</span>
            <h2 id="assistant-connections-title">Connect an AI assistant</h2>
            <p>Choose the assistant you use. DraftMatter sets up the connection automatically.</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close assistant connections"><Icon name="close" /></button>
        </header>

        <div className="assistant-scope-strip">
          <span><Icon name="check" size={15} /><strong>Connect once</strong><small>The connection is available on this computer</small></span>
          <Icon name="arrowRight" size={16} />
          <span><Icon name="folder" size={15} /><strong>Choose projects separately</strong><small>DraftMatter never opens every project to AI</small></span>
        </div>

        {busy && !status && <p className="assistant-loading" role="status">Checking installed assistants…</p>}
        {problem && <p className="assistant-problem" role="alert">{problem}</p>}
        {notice && <p className="assistant-notice" role="status"><Icon name="check" size={15} />{notice}</p>}

        {selected ? (
          <div className="assistant-preview">
            <div className="assistant-preview-heading">
              <button onClick={() => setPreview(undefined)}><Icon name="undo" size={14} />Back</button>
              <div><span>Confirm</span><h3>Disconnect {selected.statusBefore.name}?</h3></div>
            </div>
            <div className="assistant-safety-note">
              <Icon name="focus" size={17} />
              <span><strong>Only the DraftMatter connection is removed</strong><small>Your manuscripts, assistant settings, and other tools are left alone.</small></span>
            </div>
            <details className="assistant-connection-details">
              <summary>What will change</summary>
              <ul className="assistant-change-list">
                {selected.changes.map((change) => (
                  <li key={`${change.kind}:${change.path}`} data-action={change.action}>
                    <span>{change.action}</span>
                    <div><code>{change.path}</code><small>{change.message}</small></div>
                  </li>
                ))}
              </ul>
              {selected.conflicts.length > 0 && <p className="assistant-problem">Some connection files were changed outside DraftMatter and will be preserved.</p>}
            </details>
            <details className="assistant-cli-fallback">
              <summary>Advanced troubleshooting</summary>
              <code>{selected.advancedCommand} --apply</code>
            </details>
            <footer>
              <button onClick={() => setPreview(undefined)}>Cancel</button>
              <button
                className="primary-button"
                disabled={busy || !selected.ok}
                onClick={() => void act(selected.client, selected.operation, true)}
              >
                {busy ? 'Disconnecting…' : 'Disconnect'}
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
                    <div><h3>{client.name}</h3><small>{client.detected ? 'Found on this computer' : 'You can prepare the connection before installing it'}</small></div>
                    <strong className={client.connected ? 'connected' : 'not-connected'}>{client.connected ? 'Connected' : 'Not connected'}</strong>
                  </div>
                  {client.notes[0] && <p>{client.notes[0]}</p>}
                  <div className="assistant-client-actions">
                    {client.recommendedAction !== 'none' && (
                      <button
                        className="primary-button"
                        onClick={() => void act(client.client, client.recommendedAction as AssistantConnectionOperation, true)}
                        disabled={busy}
                      >
                        {busy ? 'Working…' : client.connected ? 'Update connection' : 'Connect'}
                      </button>
                    )}
                  </div>
                  {(client.mcpInstalled || client.skillInstalled) && (
                    <details className="assistant-connection-details">
                      <summary>Connection details</summary>
                      <dl>
                        <div><dt>DraftMatter tools</dt><dd>{client.mcpCurrent ? 'Current' : client.mcpInstalled ? 'Needs update' : 'Not installed'}</dd></div>
                        <div><dt>Authoring guidance</dt><dd>{client.skillCurrent ? 'Current' : client.skillInstalled ? 'Needs update' : 'Not installed'}</dd></div>
                        <div><dt>Scope</dt><dd>This computer</dd></div>
                      </dl>
                      <div className="assistant-client-actions">
                        <button onClick={() => void act(client.client, 'repair', true)} disabled={busy}>Reconnect</button>
                        <button onClick={() => void act(client.client, 'remove')} disabled={busy}>Disconnect</button>
                      </div>
                    </details>
                  )}
                </article>
              ))}
            </div>
            <div className="assistant-dialog-footer">
              <p><strong>Next:</strong> open a project and choose “Allow assistant access.”</p>
              {onOpenLearn && <button onClick={onOpenLearn}>Learn about assistant access <Icon name="arrowRight" size={14} /></button>}
            </div>
          </>
        )}
      </section>
    </div>
  )
}
