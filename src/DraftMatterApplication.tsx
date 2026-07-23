import { useEffect, useState } from 'react'
import App from './App'
import { Home } from './Home'
import { InvitationEntry } from './InvitationEntry'
import { NewDraftWizard } from './NewDraftWizard'
import { applicationRoutePath, parseApplicationRoute, type ApplicationRoute } from './applicationRoute'
import {
  CollaborationSessionProvider,
  useCollaborationSession,
  type CollaborationProjectLaunch,
  type CollaborationSessionProviderProps,
} from './collaboration/sessionContext'
import { desktopHost, type ProjectSnapshot } from './desktopHost'
import {
  forgetLocalProject,
  readLocalProjectRecents,
  rememberLocalProject,
  type LocalProjectRecent,
} from './localProjectCatalogue'
import './home.css'

function ApplicationRouter() {
  const session = useCollaborationSession()
  const [route, setRoute] = useState<ApplicationRoute>(() => parseApplicationRoute(window.location))
  const [launch, setLaunch] = useState<CollaborationProjectLaunch | null>(null)
  const [localLaunch, setLocalLaunch] = useState<ProjectSnapshot | null>(null)
  const [newDraftOpen, setNewDraftOpen] = useState(false)
  const [newDraftLocation, setNewDraftLocation] = useState<'collaborative' | 'local'>('collaborative')
  const [localProjects, setLocalProjects] = useState(() => readLocalProjectRecents(localStorage))
  const [localProblem, setLocalProblem] = useState('')

  useEffect(() => {
    const onPopState = () => {
      setLaunch(null)
      setLocalLaunch(null)
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

  const openLocalDraft = (project: ProjectSnapshot) => {
    setLocalProjects(rememberLocalProject(localStorage, project))
    setLocalProblem('')
    setLocalLaunch(project)
    setNewDraftOpen(false)
    navigate({ destination: 'local-editor', localProjectId: project.root })
  }

  const openLocalProject = async (recent?: LocalProjectRecent) => {
    if (!desktopHost.available) return
    setLocalProblem('')
    try {
      const root = recent?.root ?? await desktopHost.pickProjectFolder()
      if (!root) return
      openLocalDraft(await desktopHost.openProject(root))
    } catch (error) {
      if (recent) setLocalProjects(forgetLocalProject(localStorage, recent.root))
      setLocalProblem(`${error instanceof Error ? error.message : String(error)}${recent ? ' The unavailable folder was removed from recent projects.' : ''}`)
    }
  }

  const home = (preferredWorkspaceId?: string) => (
    <>
      <Home
        preferredWorkspaceId={preferredWorkspaceId}
        onOpenDraft={openDraft}
        onNewDraft={() => { setNewDraftLocation('collaborative'); setNewDraftOpen(true) }}
        onNewLocalDraft={() => { setNewDraftLocation('local'); setNewDraftOpen(true) }}
        onOpenLocalProject={() => void openLocalProject()}
        onOpenLocalRecent={(project) => void openLocalProject(project)}
        onForgetLocalRecent={(project) => setLocalProjects(forgetLocalProject(localStorage, project.root))}
        localProjects={localProjects}
        localProblem={localProblem}
        onOpenExample={() => navigate({ destination: 'example' })}
        onOpenLearn={() => navigate({ destination: 'home' })}
      />
      <NewDraftWizard
        open={newDraftOpen}
        initialLocation={newDraftLocation}
        onClose={() => setNewDraftOpen(false)}
        onCollaborativeCreated={(nextLaunch) => {
          setNewDraftOpen(false)
          openDraft(nextLaunch)
        }}
        onLocalCreated={openLocalDraft}
      />
    </>
  )

  useEffect(() => {
    if (route.destination !== 'collaborative-editor' || launch || session.state !== 'ready') return
    const nextLaunch = session.launchFor(route.workspaceId, route.projectId, { canBootstrap: false })
    if (nextLaunch) setLaunch(nextLaunch)
  }, [launch, route, session])

  useEffect(() => {
    if (route.destination !== 'local-editor' || localLaunch || !desktopHost.available || route.localProjectId === 'open') return
    void desktopHost.openProject(route.localProjectId).then(openLocalDraft).catch((error) => {
      setLocalProjects(forgetLocalProject(localStorage, route.localProjectId))
      setLocalProblem(error instanceof Error ? error.message : String(error))
      navigate({ destination: 'home' }, true)
    })
  // The URL provides the durable local project identity after a desktop reload.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localLaunch, route])

  if (session.pendingInvitation || route.destination === 'invitation') {
    return <InvitationEntry onOpenDraft={openDraft} onBack={() => navigate({ destination: 'home' })} />
  }

  if (route.destination === 'collaborative-editor') {
    if (launch) {
      return <App collaborationLaunch={launch} onNavigateHome={() => { setLaunch(null); navigate({ destination: 'home', workspaceId: launch.workspaceId }) }} />
    }
    if (!session.profile) {
      return home()
    }
    if (session.state === 'loading') return <div className="home-route-status" role="status">Opening manuscript…</div>
    return <main className="home-route-status"><section><h1>Manuscript unavailable</h1><p>This draft is not available to your account, or its workspace could not be loaded.</p><button onClick={() => navigate({ destination: 'home' })}>Return to Home</button></section></main>
  }

  if (route.destination === 'local-editor') {
    if (!localLaunch) return <main className="home-route-status"><section><h1>Open the local project from Home</h1><p>DraftMatter needs permission to read a project folder on this computer.</p><button onClick={() => navigate({ destination: 'home' })}>Return to Home</button></section></main>
    return <App desktopProjectLaunch={localLaunch} onNavigateHome={() => { setLocalProjects(readLocalProjectRecents(localStorage)); setLocalLaunch(null); navigate({ destination: 'home' }) }} />
  }

  if (route.destination === 'example') return <App initialExperience="complete-example" onNavigateHome={() => navigate({ destination: 'home' })} />

  return home(route.workspaceId)
}

export interface DraftMatterApplicationProps {
  collaboration?: Omit<CollaborationSessionProviderProps, 'children'>
}

export function DraftMatterApplication({ collaboration }: DraftMatterApplicationProps) {
  return <CollaborationSessionProvider {...collaboration}><ApplicationRouter /></CollaborationSessionProvider>
}
