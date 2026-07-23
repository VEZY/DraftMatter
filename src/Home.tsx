import { useMemo, useState } from 'react'
import { desktopHost } from './desktopHost'
import { Icon } from './Icon'
import {
  useCollaborationSession,
  type CatalogueDraft,
  type CollaborationProjectLaunch,
} from './collaboration/sessionContext'
import type { WorkspaceRole } from './collaboration/workspaceService'

interface HomeProps {
  preferredWorkspaceId?: string
  onOpenDraft: (launch: CollaborationProjectLaunch) => void
  onNewDraft: () => void
  onOpenLocalProject: () => void
  onOpenExample: () => void
  onOpenLearn: () => void
}

function roleLabel(role: WorkspaceRole) {
  return role[0].toUpperCase() + role.slice(1)
}

function createdLabel(createdAt: string) {
  const created = new Date(createdAt)
  if (Number.isNaN(created.getTime())) return 'Created date unavailable'
  return `Created ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(created)}`
}

function DraftRow({
  draft,
  onOpen,
}: {
  draft: CatalogueDraft
  onOpen: () => void
}) {
  return (
    <button className="home-draft-row" onClick={onOpen}>
      <span className="home-draft-icon"><Icon name="document" size={18} /></span>
      <span className="home-draft-copy">
        <strong>{draft.name}</strong>
        <small>{draft.workspaceName} · {createdLabel(draft.createdAt)}</small>
      </span>
      <span className={`home-role home-role-${draft.role}`}>{roleLabel(draft.role)}</span>
      <Icon name="arrowRight" size={16} />
    </button>
  )
}

function SignedOutHome({
  onOpenLocalProject,
  onOpenExample,
  onOpenLearn,
}: Pick<HomeProps, 'onOpenLocalProject' | 'onOpenExample' | 'onOpenLearn'>) {
  const session = useCollaborationSession()
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [serviceUrl, setServiceUrl] = useState(session.serviceUrl || 'https://')
  const [accessToken, setAccessToken] = useState('')

  return (
    <main className="home-welcome">
      <header className="home-welcome-header">
        <a className="home-brand" href="/" aria-label="DraftMatter home">
          <img src="/draftmatter-pencil-mark.svg" alt="" />
          <span>DraftMatter</span>
        </a>
        <button className="home-link-button" onClick={onOpenLearn}>Learn DraftMatter</button>
      </header>

      <section className="home-hero" aria-labelledby="home-title">
        <span className="home-kicker">A calm place for research manuscripts</span>
        <h1 id="home-title">Write together without giving up a portable source.</h1>
        <p>DraftMatter keeps the manuscript, review history, citations, and reproducible outputs close—while collaborators work in one shared draft.</p>
        <div className="home-hero-actions">
          <button className="home-primary" onClick={() => void session.signIn()} disabled={session.state === 'signing-in'}>
            <Icon name="users" size={17} />
            {session.state === 'signing-in' ? 'Opening sign-in…' : 'Sign in'}
          </button>
          {desktopHost.available && <button onClick={onOpenLocalProject}><Icon name="folder" size={17} />Open local project</button>}
          <button onClick={onOpenExample}><Icon name="spark" size={17} />Explore complete example</button>
        </div>
        {session.error && <p className="home-account-error" role="alert">{session.error}</p>}
        {!session.serviceUrl && (
          <p className="home-deployment-note">Online collaboration is not configured for this installation. Local projects and the complete example remain available.</p>
        )}
      </section>

      <section className="home-steps" aria-label="How DraftMatter works">
        <article><span>01</span><strong>Start from a portable manuscript</strong><p>Create a draft or open the source you already own.</p></article>
        <article><span>02</span><strong>Invite the right people</strong><p>Give collaborators only the role they need.</p></article>
        <article><span>03</span><strong>Publish clean results</strong><p>Keep code private while figures, tables, and values stay reproducible.</p></article>
      </section>

      <section className="home-advanced">
        <button className="home-disclosure" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((open) => !open)}>
          Advanced connection setup
          <Icon name="chevronDown" size={15} />
        </button>
        {advancedOpen && (
          <form onSubmit={(event) => {
            event.preventDefault()
            session.configureDevelopmentService(serviceUrl)
            if (accessToken.trim()) void session.useAccessToken(serviceUrl, accessToken.trim())
          }}>
            <p>For development and self-hosted installations. Access tokens are held in memory only.</p>
            <label><span>Collaboration service</span><input value={serviceUrl} onChange={(event) => setServiceUrl(event.target.value)} inputMode="url" autoCapitalize="none" spellCheck={false} /></label>
            <label><span>Short-lived access token</span><input type="password" value={accessToken} onChange={(event) => setAccessToken(event.target.value)} autoComplete="one-time-code" /></label>
            <button type="submit">Use this service</button>
          </form>
        )}
      </section>
    </main>
  )
}

function Catalogue({
  preferredWorkspaceId,
  onOpenDraft,
  onNewDraft,
  onOpenLearn,
}: Pick<HomeProps, 'preferredWorkspaceId' | 'onOpenDraft' | 'onNewDraft' | 'onOpenLearn'>) {
  const session = useCollaborationSession()
  const [query, setQuery] = useState('')
  const [workspaceId, setWorkspaceId] = useState(() => (
    preferredWorkspaceId && session.workspaces.some((workspace) => workspace.id === preferredWorkspaceId)
      ? preferredWorkspaceId
      : 'all'
  ))
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleDrafts = useMemo(() => session.drafts.filter((draft) => (
    (workspaceId === 'all' || draft.workspaceId === workspaceId)
    && (!normalizedQuery || `${draft.name} ${draft.workspaceName}`.toLocaleLowerCase().includes(normalizedQuery))
  )), [normalizedQuery, session.drafts, workspaceId])
  const owned = visibleDrafts.filter((draft) => draft.role === 'owner')
  const shared = visibleDrafts.filter((draft) => draft.role !== 'owner')
  const accountName = session.profile?.displayName ?? session.profile?.email ?? session.profile?.userId ?? 'Account'

  const openDraft = (draft: CatalogueDraft) => {
    const launch = session.launchFor(draft.workspaceId, draft.id, { canBootstrap: false })
    if (launch) onOpenDraft(launch)
  }

  return (
    <main className="home-catalogue">
      <header className="home-catalogue-bar">
        <a className="home-brand" href="/" aria-label="DraftMatter home">
          <img src="/draftmatter-pencil-mark.svg" alt="" />
          <span>DraftMatter</span>
        </a>
        <label className="home-search">
          <Icon name="search" size={16} />
          <span className="sr-only">Search drafts</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search drafts" />
        </label>
        <button className="home-link-button" onClick={onOpenLearn}>Help</button>
        <div className="home-account">
          <span aria-hidden="true">{accountName.slice(0, 1).toUpperCase()}</span>
          <span><strong>{accountName}</strong><small>Signed in</small></span>
          <button onClick={session.signOut}>Sign out</button>
        </div>
      </header>

      <div className="home-catalogue-content">
        <section className="home-catalogue-heading">
          <div><span className="home-kicker">Your research workspace</span><h1>Drafts</h1><p>Every manuscript you can access, across all of your workspaces.</p></div>
          <button className="home-primary" onClick={onNewDraft}><Icon name="plus" size={16} />New draft</button>
        </section>

        <div className="home-catalogue-tools">
          <label><span>Workspace</span><select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}><option value="all">All workspaces</option>{session.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label>
          <span>{visibleDrafts.length} draft{visibleDrafts.length === 1 ? '' : 's'}</span>
        </div>

        {session.workspaceFailures.length > 0 && (
          <section className="home-partial-failure" role="status" aria-label="Some workspaces could not be loaded">
            <Icon name="info" size={17} />
            <span><strong>Some workspaces could not be loaded.</strong><small>{session.workspaceFailures.map((failure) => failure.workspaceName).join(', ')}</small></span>
            <button onClick={() => void session.refresh()}>Retry</button>
          </section>
        )}

        {session.state === 'loading' ? (
          <div className="home-loading" role="status">Loading your drafts…</div>
        ) : visibleDrafts.length === 0 ? (
          <section className="home-empty">
            <span><Icon name="document" size={24} /></span>
            <h2>{query ? 'No matching drafts' : 'No drafts here yet'}</h2>
            <p>{query ? 'Try a different title or workspace.' : 'Create a manuscript with a portable source, then invite collaborators when you are ready.'}</p>
            {!query && <button className="home-primary" onClick={onNewDraft}>Create your first draft</button>}
          </section>
        ) : (
          <div className="home-draft-sections">
            {shared.length > 0 && <section aria-labelledby="shared-drafts-title"><div className="home-section-title"><h2 id="shared-drafts-title">Shared with me</h2><span>{shared.length}</span></div><div className="home-draft-list">{shared.map((draft) => <DraftRow key={`${draft.workspaceId}:${draft.id}`} draft={draft} onOpen={() => openDraft(draft)} />)}</div></section>}
            {owned.length > 0 && <section aria-labelledby="owned-drafts-title"><div className="home-section-title"><h2 id="owned-drafts-title">My drafts</h2><span>{owned.length}</span></div><div className="home-draft-list">{owned.map((draft) => <DraftRow key={`${draft.workspaceId}:${draft.id}`} draft={draft} onOpen={() => openDraft(draft)} />)}</div></section>}
          </div>
        )}
      </div>
    </main>
  )
}

export function Home(props: HomeProps) {
  const session = useCollaborationSession()
  if (session.profile) return <Catalogue {...props} />
  return <SignedOutHome {...props} />
}
