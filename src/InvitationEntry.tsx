import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { useCollaborationSession, type CollaborationProjectLaunch } from './collaboration/sessionContext'

export function InvitationEntry({
  onOpenDraft,
  onBack,
}: {
  onOpenDraft: (launch: CollaborationProjectLaunch) => void
  onBack: () => void
}) {
  const session = useCollaborationSession()
  const [accepting, setAccepting] = useState(false)
  const [message, setMessage] = useState('')
  const acceptButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    acceptButtonRef.current?.focus()
  }, [])

  const accept = async () => {
    if (!session.profile) {
      await session.signIn()
      return
    }
    setAccepting(true)
    setMessage('')
    try {
      const membership = await session.acceptInvitation()
      const projects = await session.client!.listProjects(membership.workspaceId)
      if (projects.length === 1) {
        const workspaces = await session.client!.listWorkspaces()
        if (!session.token || !session.profile) throw new Error('The signed-in collaboration session is no longer available.')
        onOpenDraft({
          serviceUrl: session.serviceUrl,
          token: session.token,
          client: session.client!,
          profile: session.profile,
          workspaces,
          projects,
          workspaceId: membership.workspaceId,
          projectId: projects[0].id,
          canBootstrap: false,
        })
      } else {
        setMessage(projects.length
          ? 'Invitation accepted. Choose the manuscript you want to open from this workspace.'
          : 'Invitation accepted. This workspace does not contain a manuscript yet.')
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setAccepting(false)
    }
  }

  if (!session.pendingInvitation) {
    return (
      <main className="home-invitation">
        <section><span className="home-invitation-icon"><Icon name="link" size={23} /></span><h1>This invitation is no longer available</h1><p>It may already have been accepted, expired, or been revoked. Ask the workspace owner for a new invitation.</p><button onClick={onBack}>Return to Home</button></section>
      </main>
    )
  }

  return (
    <main className="home-invitation">
      <section>
        <span className="home-kicker">Workspace invitation</span>
        <span className="home-invitation-icon"><Icon name="users" size={24} /></span>
        <h1>You have been invited to collaborate</h1>
        <p>{session.profile ? 'Accept the invitation to add this workspace to your DraftMatter account.' : 'Sign in securely first. DraftMatter will keep this invitation through the sign-in round trip.'}</p>
        {message && <p className="home-account-error" role="alert">{message}</p>}
        <div>
          <button onClick={onBack}>Not now</button>
          <button ref={acceptButtonRef} className="home-primary" onClick={() => void accept()} disabled={accepting || session.state === 'signing-in'}>{accepting ? 'Accepting…' : session.profile ? 'Accept invitation' : 'Sign in to continue'}</button>
        </div>
      </section>
    </main>
  )
}
