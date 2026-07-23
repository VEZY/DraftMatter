import { useEffect, useState } from 'react'
import App from './App'
import { Home } from './Home'
import { InvitationEntry } from './InvitationEntry'
import { applicationRoutePath, parseApplicationRoute, type ApplicationRoute } from './applicationRoute'
import {
  CollaborationSessionProvider,
  useCollaborationSession,
  type CollaborationProjectLaunch,
  type CollaborationSessionProviderProps,
} from './collaboration/sessionContext'
import { desktopHost } from './desktopHost'
import './home.css'

function ApplicationRouter() {
  const session = useCollaborationSession()
  const [route, setRoute] = useState<ApplicationRoute>(() => parseApplicationRoute(window.location))
  const [launch, setLaunch] = useState<CollaborationProjectLaunch | null>(null)

  useEffect(() => {
    const onPopState = () => {
      setLaunch(null)
      setRoute(parseApplicationRoute(window.location))
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const navigate = (next: ApplicationRoute, replace = false) => {
    const path = applicationRoutePath(next)
    window.history[replace ? 'replaceState' : 'pushState']({}, '', path)
    setRoute(next)
  }

  const openDraft = (nextLaunch: CollaborationProjectLaunch) => {
    setLaunch(nextLaunch)
    navigate({ destination: 'collaborative-editor', workspaceId: nextLaunch.workspaceId, projectId: nextLaunch.projectId })
  }

  useEffect(() => {
    if (route.destination !== 'collaborative-editor' || launch || session.state !== 'ready') return
    const nextLaunch = session.launchFor(route.workspaceId, route.projectId, { canBootstrap: false })
    if (nextLaunch) setLaunch(nextLaunch)
  }, [launch, route, session])

  if (session.pendingInvitation || route.destination === 'invitation') {
    return <InvitationEntry onOpenDraft={openDraft} onBack={() => navigate({ destination: 'home' })} />
  }

  if (route.destination === 'collaborative-editor') {
    if (launch) {
      return <App collaborationLaunch={launch} onNavigateHome={() => { setLaunch(null); navigate({ destination: 'home', workspaceId: launch.workspaceId }) }} />
    }
    if (!session.profile) {
      return <Home onOpenDraft={openDraft} onNewDraft={() => navigate({ destination: 'home' })} onOpenLocalProject={() => navigate({ destination: 'home' })} onOpenExample={() => navigate({ destination: 'example' })} onOpenLearn={() => navigate({ destination: 'home' })} />
    }
    if (session.state === 'loading') return <div className="home-route-status" role="status">Opening manuscript…</div>
    return <main className="home-route-status"><section><h1>Manuscript unavailable</h1><p>This draft is not available to your account, or its workspace could not be loaded.</p><button onClick={() => navigate({ destination: 'home' })}>Return to Home</button></section></main>
  }

  if (route.destination === 'local-editor' || route.destination === 'example') {
    return <App initialExperience={route.destination === 'example' ? 'complete-example' : undefined} onNavigateHome={() => navigate({ destination: 'home' })} />
  }

  return (
    <Home
      preferredWorkspaceId={route.workspaceId}
      onOpenDraft={openDraft}
      onNewDraft={() => navigate({ destination: 'home' })}
      onOpenLocalProject={() => {
        if (!desktopHost.available) return
        navigate({ destination: 'local-editor', localProjectId: 'open' })
      }}
      onOpenExample={() => navigate({ destination: 'example' })}
      onOpenLearn={() => navigate({ destination: 'home' })}
    />
  )
}

export interface DraftMatterApplicationProps {
  collaboration?: Omit<CollaborationSessionProviderProps, 'children'>
}

export function DraftMatterApplication({ collaboration }: DraftMatterApplicationProps) {
  return <CollaborationSessionProvider {...collaboration}><ApplicationRouter /></CollaborationSessionProvider>
}
