import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { useCollaborationSession, type CollaborationProjectLaunch } from './collaboration/sessionContext'
import { LegalLinks } from './LegalDocuments'
import { legalConfiguration, type LegalDocumentId } from './legalConfig'
import { alphaAccessLink } from './alphaAccess'

export function InvitationEntry({
  onOpenDraft,
  onBack,
  onOpenLegal,
}: {
  onOpenDraft: (launch: CollaborationProjectLaunch) => void
  onBack: () => void
  onOpenLegal?: (documentId: LegalDocumentId) => void
}) {
  const session = useCollaborationSession()
  const [accepting, setAccepting] = useState(false)
  const [message, setMessage] = useState('')
  const acceptButtonRef = useRef<HTMLButtonElement>(null)
  const accessLink = alphaAccessLink(legalConfiguration.contactEmail)

  useEffect(() => {
    acceptButtonRef.current?.focus()
  }, [])

  const accept = async () => {
    if (!session.profile) {
      try {
        setMessage('')
        await session.signIn()
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error))
      }
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
        onBack()
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setAccepting(false)
    }
  }

  if (!session.pendingInvitation && !accepting) {
    const problem = message || session.error
    return (
      <main className="home-invitation">
        <section><span className="home-invitation-icon"><Icon name="link" size={23} /></span><h1>{problem ? 'Could not finish opening this workspace' : 'This invitation is no longer available'}</h1>{problem ? <p role="alert">{problem}</p> : <p>It may already have been accepted, expired, or been revoked. Ask the workspace owner for a new invitation.</p>}<button onClick={onBack}>Return to Home</button><LegalLinks onNavigate={onOpenLegal} target={onOpenLegal ? undefined : '_blank'} /></section>
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
        <p>This is a workspace invitation. Accepting gives your account access to its current and future papers and shared files, according to your assigned role.</p>
        {session.profile
          ? <p>Signed in as <strong>{session.profile.email ?? session.profile.displayName ?? session.profile.userId}</strong>. Use the email address your colleague invited.</p>
          : <p>A project invitation does not create an alpha account. If you do not yet have sign-in details, <a href={accessLink.href}>request alpha access</a> first.</p>}
        <p>The hosted alpha is free and by invitation. Please read the terms of use and privacy policy before continuing.</p>
        <LegalLinks onNavigate={onOpenLegal} target={onOpenLegal ? undefined : '_blank'} />
        {(message || session.error) && <p className="home-account-error" role="alert">{message || session.error}</p>}
        <div>
          <button onClick={() => { session.dismissInvitation(); onBack() }} disabled={accepting || session.state === 'signing-in'}>Not now</button>
          <button ref={acceptButtonRef} className="home-primary" onClick={() => void accept()} disabled={accepting || session.state === 'signing-in'}>{accepting ? 'Accepting…' : session.profile ? 'Accept invitation' : 'Sign in to continue'}</button>
        </div>
      </section>
    </main>
  )
}
