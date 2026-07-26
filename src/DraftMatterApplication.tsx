import { isTauri } from '@tauri-apps/api/core'
import { useEffect, useRef, useState } from 'react'
import App from './App'
import { desktopLaunchTarget } from './desktopLaunch'
import { Home } from './Home'
import { InvitationEntry } from './InvitationEntry'
import { NewDraftWizard } from './NewDraftWizard'
import { Learn } from './Learn'
import { AiLearn } from './AiLearn'
import { AssistantConnectionsDialog } from './AssistantConnectionsDialog'
import { ProgrammingLanguages } from './ProgrammingLanguages'
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
  const [startCollaborationRoot, setStartCollaborationRoot] = useState('')
  const [newDraftOpen, setNewDraftOpen] = useState(false)
  const [newDraftLocation, setNewDraftLocation] = useState<'collaborative' | 'local'>('collaborative')
  const [localProjects, setLocalProjects] = useState(() => readLocalProjectRecents(localStorage))
  const [localProblem, setLocalProblem] = useState('')
  const [browserDraftIsNew, setBrowserDraftIsNew] = useState(false)
  const [assistantConnectionsOpen, setAssistantConnectionsOpen] = useState(false)

  useEffect(() => {
    const onPopState = () => {
      setLaunch(null)
      setLocalLaunch(null)
      setStartCollaborationRoot('')
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

  const openLocalDraft = (project: ProjectSnapshot, startCollaboration = false) => {
    setLocalProjects(rememberLocalProject(localStorage, project))
    setLocalProblem('')
    setStartCollaborationRoot(startCollaboration ? project.root : '')
    setLocalLaunch(project)
    setNewDraftOpen(false)
    navigate({ destination: 'local-editor', localProjectId: project.root, ...(startCollaboration ? { startCollaboration: true } : {}) })
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
        onStartLocalCollaboration={(project) => {
          if (!desktopHost.available) return
          setLocalProblem('')
          void desktopHost.openProject(project.root).then((snapshot) => openLocalDraft(snapshot, true)).catch((error) => {
            setLocalProjects(forgetLocalProject(localStorage, project.root))
            setLocalProblem(`${error instanceof Error ? error.message : String(error)} The unavailable folder was removed from recent projects.`)
          })
        }}
        localProjects={localProjects}
        localProblem={localProblem}
        onOpenExample={() => navigate({ destination: 'example' })}
        onOpenBrowserDraft={() => { setBrowserDraftIsNew(true); navigate({ destination: 'browser-editor' }) }}
        onOpenLearn={() => navigate({ destination: 'learn' })}
        onOpenAiLearn={() => navigate({ destination: 'learn-ai' })}
        onOpenLanguages={() => navigate({ destination: 'languages' })}
        onOpenTutorial={() => navigate({ destination: 'tutorial' })}
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
    void desktopHost.openProject(route.localProjectId).then((project) => openLocalDraft(project, route.startCollaboration === true)).catch((error) => {
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
      return <App collaborationLaunch={launch} onOpenLearn={() => navigate({ destination: 'learn' })} onOpenAiLearn={() => navigate({ destination: 'learn-ai' })} onOpenLanguages={() => navigate({ destination: 'languages' })} onNavigateHome={() => { setLaunch(null); navigate({ destination: 'home', workspaceId: launch.workspaceId }) }} />
    }
    if (!session.profile) {
      return home()
    }
    if (session.state === 'loading') return <div className="home-route-status" role="status">Opening manuscript…</div>
    return <main className="home-route-status"><section><h1>Manuscript unavailable</h1><p>This draft is not available to your account, or its workspace could not be loaded.</p><button onClick={() => navigate({ destination: 'home' })}>Return to Home</button></section></main>
  }

  if (route.destination === 'local-editor') {
    if (!localLaunch) return <main className="home-route-status"><section><h1>Open the local project from Home</h1><p>DraftMatter needs permission to read a project folder on this computer.</p><button onClick={() => navigate({ destination: 'home' })}>Return to Home</button></section></main>
    return <App desktopProjectLaunch={localLaunch} startCollaborationOnMount={startCollaborationRoot === localLaunch.root} onOpenLearn={() => navigate({ destination: 'learn' })} onOpenAiLearn={() => navigate({ destination: 'learn-ai' })} onOpenLanguages={() => navigate({ destination: 'languages' })} onNavigateHome={() => { setLocalProjects(readLocalProjectRecents(localStorage)); setStartCollaborationRoot(''); setLocalLaunch(null); navigate({ destination: 'home' }) }} />
  }

  if (route.destination === 'example') return <App initialExperience="complete-example" onOpenLearn={() => navigate({ destination: 'learn' })} onOpenLanguages={() => navigate({ destination: 'languages' })} onNavigateHome={() => navigate({ destination: 'home' })} />
  if (route.destination === 'learn') return <Learn onBack={() => navigate({ destination: 'home' })} onStartTour={() => navigate({ destination: 'tutorial' })} />
  if (route.destination === 'learn-ai') return (
    <>
      <AiLearn onBack={() => navigate({ destination: 'home' })} onConnectAssistants={() => setAssistantConnectionsOpen(true)} />
      <AssistantConnectionsDialog open={assistantConnectionsOpen} onClose={() => setAssistantConnectionsOpen(false)} />
    </>
  )
  if (route.destination === 'languages') return <ProgrammingLanguages onBack={() => navigate({ destination: 'home' })} />
  if (route.destination === 'tutorial') return <App initialExperience="complete-example" startExampleTour onOpenLearn={() => navigate({ destination: 'learn' })} onOpenLanguages={() => navigate({ destination: 'languages' })} onNavigateHome={() => navigate({ destination: 'home' })} />
  if (route.destination === 'browser-editor') return <App initialExperience={browserDraftIsNew ? 'browser-new' : undefined} onOpenLearn={() => navigate({ destination: 'learn' })} onOpenLanguages={() => navigate({ destination: 'languages' })} onNavigateHome={() => { setBrowserDraftIsNew(false); navigate({ destination: 'home' }) }} />

  return home(route.workspaceId)
}

export interface DraftMatterApplicationProps {
  collaboration?: Omit<CollaborationSessionProviderProps, 'children'>
}

export function DraftMatterApplication({ collaboration }: DraftMatterApplicationProps) {
  const desktop = isTauri()
  const [desktopLaunchReady, setDesktopLaunchReady] = useState(!desktop)
  const [sessionGeneration, setSessionGeneration] = useState(0)
  const lastDesktopTargetRef = useRef('')

  useEffect(() => {
    if (!desktop) return
    let active = true
    let unlisten: (() => void) | undefined
    const open = (urls: string[] | null) => {
      const target = urls?.map(desktopLaunchTarget).find((candidate): candidate is string => Boolean(candidate))
      if (!target || target === lastDesktopTargetRef.current) return
      lastDesktopTargetRef.current = target
      window.history.replaceState({}, '', target)
      setSessionGeneration((current) => current + 1)
    }
    void import('@tauri-apps/plugin-deep-link').then(async ({ getCurrent, onOpenUrl }) => {
      open(await getCurrent())
      if (!active) return
      unlisten = await onOpenUrl(open)
    }).finally(() => {
      if (active) setDesktopLaunchReady(true)
    })
    return () => {
      active = false
      unlisten?.()
    }
  }, [desktop])

  if (!desktopLaunchReady) return <div className="home-route-status" role="status">Opening DraftMatter…</div>
  return <CollaborationSessionProvider key={sessionGeneration} {...collaboration}><ApplicationRouter /></CollaborationSessionProvider>
}
