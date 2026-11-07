import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  CollaborationServiceClient,
  normalizeCollaborationServiceUrl,
  type CollaborationAccessToken,
  type WorkspaceSummary,
} from './serviceClient'
import {
  readCollaborationInvitationLink,
  storePendingCollaborationInvitation,
  takePendingCollaborationInvitation,
  type CollaborationInvitationLink,
} from './invitationLink'
import {
  completeOidcAuthorization,
  hasOidcCallback,
  prepareOidcAuthorization,
} from './oidcBrowser'
import type {
  CollaborationSessionProfile,
  WorkspaceMembership,
  WorkspaceProject,
  WorkspaceRole,
} from './workspaceService'

import { signInDesktop, usesDesktopIdentity } from './oidcDesktop'

const DEVELOPMENT_SERVICE_KEY = 'draftmatter.collaboration.development-service.v1'

export type CollaborationAccountState = 'signed-out' | 'signing-in' | 'loading' | 'ready' | 'error'

export interface CatalogueDraft extends WorkspaceProject {
  role: WorkspaceRole
  workspaceName: string
  workspaceRole: WorkspaceRole
}

export interface WorkspaceCatalogueFailure {
  workspaceId: string
  workspaceName: string
  message: string
}

export interface CollaborationProjectLaunch {
  serviceUrl: string
  token: CollaborationAccessToken
  client: CollaborationServiceClient
  profile: CollaborationSessionProfile
  workspaces: WorkspaceSummary[]
  projects: WorkspaceProject[]
  workspaceId: string
  projectId: string
  bootstrapSource?: string
  canBootstrap?: boolean
  requireEmptyForBootstrap?: boolean
}

interface CollaborationSessionContextValue {
  state: CollaborationAccountState
  serviceUrl: string
  profile: CollaborationSessionProfile | null
  workspaces: WorkspaceSummary[]
  drafts: CatalogueDraft[]
  workspaceFailures: WorkspaceCatalogueFailure[]
  pendingInvitation: CollaborationInvitationLink | null
  error: string
  client: CollaborationServiceClient | null
  token: CollaborationAccessToken | null
  configureDevelopmentService: (serviceUrl: string) => void
  signIn: () => Promise<void>
  useAccessToken: (serviceUrl: string, token: string) => Promise<void>
  signOut: () => void
  refresh: () => Promise<void>
  acceptInvitation: () => Promise<WorkspaceMembership>
  createWorkspace: (request: { id: string; name: string }) => Promise<WorkspaceSummary>
  createProject: (workspaceId: string, request: { id: string; name: string }) => Promise<WorkspaceProject>
  projectsForWorkspace: (workspaceId: string) => WorkspaceProject[]
  launchFor: (workspaceId: string, projectId: string, options?: Pick<CollaborationProjectLaunch, 'bootstrapSource' | 'canBootstrap' | 'requireEmptyForBootstrap'>) => CollaborationProjectLaunch | null
}

const CollaborationSessionContext = createContext<CollaborationSessionContextValue | null>(null)

function readableError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function configuredServiceUrl(storage: Pick<Storage, 'getItem'>) {
  const environment = typeof import.meta.env.VITE_DRAFTMATTER_COLLABORATION_URL === 'string'
    ? import.meta.env.VITE_DRAFTMATTER_COLLABORATION_URL.trim()
    : ''
  const metadata = typeof document === 'undefined'
    ? ''
    : document.querySelector<HTMLMetaElement>('meta[name="draftmatter-collaboration-service"]')?.content.trim() ?? ''
  const candidate = environment || metadata || storage.getItem(DEVELOPMENT_SERVICE_KEY)?.trim() || ''
  if (!candidate) return ''
  try {
    return normalizeCollaborationServiceUrl(candidate).apiUrl
  } catch {
    return ''
  }
}

export interface CollaborationSessionProviderProps {
  children: ReactNode
  initialServiceUrl?: string
  navigateToIdentity?: (url: string) => void
}

export function CollaborationSessionProvider({
  children,
  initialServiceUrl,
  navigateToIdentity,
}: CollaborationSessionProviderProps) {
  const initialInvitation = useMemo(() => readCollaborationInvitationLink(window.location.href), [])
  const [serviceUrl, setServiceUrl] = useState(() => {
    if (initialInvitation) return initialInvitation.serviceUrl
    if (initialServiceUrl) {
      try {
        return normalizeCollaborationServiceUrl(initialServiceUrl).apiUrl
      } catch {
        return ''
      }
    }
    return configuredServiceUrl(localStorage)
  })
  const [state, setState] = useState<CollaborationAccountState>('signed-out')
  const [profile, setProfile] = useState<CollaborationSessionProfile | null>(null)
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([])
  const [drafts, setDrafts] = useState<CatalogueDraft[]>([])
  const [workspaceFailures, setWorkspaceFailures] = useState<WorkspaceCatalogueFailure[]>([])
  const [pendingInvitation, setPendingInvitation] = useState<CollaborationInvitationLink | null>(initialInvitation)
  const [error, setError] = useState('')
  const [client, setClient] = useState<CollaborationServiceClient | null>(null)
  const tokenRef = useRef<CollaborationAccessToken | null>(null)
  const clientRef = useRef<CollaborationServiceClient | null>(null)
  const callbackStartedRef = useRef(false)

  const loadCatalogue = useCallback(async (nextClient: CollaborationServiceClient) => {
    setState('loading')
    setError('')
    const [nextProfile, nextWorkspaces] = await Promise.all([
      nextClient.getSession(),
      nextClient.listWorkspaces(),
    ])
    const results = await Promise.allSettled(nextWorkspaces.map((workspace) => nextClient.listProjects(workspace.id)))
    const nextDrafts: CatalogueDraft[] = []
    const failures: WorkspaceCatalogueFailure[] = []
    results.forEach((result, index) => {
      const workspace = nextWorkspaces[index]
      if (result.status === 'rejected') {
        failures.push({ workspaceId: workspace.id, workspaceName: workspace.name, message: readableError(result.reason) })
        return
      }
      for (const project of result.value) {
        nextDrafts.push({
          ...project,
          role: project.role ?? workspace.role,
          workspaceName: workspace.name,
          workspaceRole: workspace.role,
        })
      }
    })
    setProfile(nextProfile)
    setWorkspaces(nextWorkspaces)
    setDrafts(nextDrafts)
    setWorkspaceFailures(failures)
    setState('ready')
  }, [])

  const activate = useCallback(async (nextServiceUrl: string, token: CollaborationAccessToken) => {
    const normalized = normalizeCollaborationServiceUrl(nextServiceUrl).apiUrl
    const nextClient = new CollaborationServiceClient(normalized, token)
    tokenRef.current = token
    clientRef.current = nextClient
    setServiceUrl(normalized)
    setClient(nextClient)
    try {
      await loadCatalogue(nextClient)
    } catch (nextError) {
      tokenRef.current = null
      clientRef.current = null
      setClient(null)
      setProfile(null)
      setWorkspaces([])
      setDrafts([])
      setWorkspaceFailures([])
      setState('error')
      setError(readableError(nextError))
      throw nextError
    }
  }, [loadCatalogue])

  useEffect(() => {
    if (!initialInvitation) return
    window.history.replaceState({}, '', initialInvitation.cleanUrl)
  }, [initialInvitation])

  useEffect(() => {
    if (!hasOidcCallback(window.location.href) || callbackStartedRef.current) return
    callbackStartedRef.current = true
    const retainedInvitation = takePendingCollaborationInvitation(sessionStorage)
    setState('signing-in')
    setError('')
    void completeOidcAuthorization(window.location.href, sessionStorage).then(async (result) => {
      if (!result) return
      window.history.replaceState({}, '', result.cleanUrl)
      if (retainedInvitation?.serviceUrl === result.serviceUrl) {
        setPendingInvitation({
          ...retainedInvitation,
          cleanUrl: result.cleanUrl,
        })
      }
      await activate(result.serviceUrl, result.token)
    }).catch((nextError) => {
      setState('error')
      setError(readableError(nextError))
    })
  }, [activate])

  const configureDevelopmentService = (nextServiceUrl: string) => {
    const normalized = normalizeCollaborationServiceUrl(nextServiceUrl).apiUrl
    localStorage.setItem(DEVELOPMENT_SERVICE_KEY, normalized)
    setServiceUrl(normalized)
    setError('')
  }

  const signIn = async () => {
    if (!serviceUrl || state === 'signing-in') {
      if (!serviceUrl) {
        setState('error')
        setError('This DraftMatter deployment has not configured a collaboration service.')
      }
      return
    }
    setState('signing-in')
    setError('')
    try {
      if (usesDesktopIdentity()) {
        const result = await signInDesktop(serviceUrl)
        await activate(result.serviceUrl, result.token)
        return
      }
      const request = await prepareOidcAuthorization(serviceUrl, window.location.href, sessionStorage)
      if (pendingInvitation) {
        storePendingCollaborationInvitation(sessionStorage, pendingInvitation)
      }
      ;(navigateToIdentity ?? ((url: string) => window.location.assign(url)))(request.authorizationUrl)
    } catch (nextError) {
      setState('error')
      setError(readableError(nextError))
    }
  }

  const useAccessToken = async (nextServiceUrl: string, accessToken: string) => {
    setState('loading')
    setError('')
    try {
      await activate(nextServiceUrl, accessToken)
    } catch {
      // activate publishes the actionable account error.
    }
  }

  const signOut = () => {
    tokenRef.current = null
    clientRef.current = null
    setClient(null)
    setProfile(null)
    setWorkspaces([])
    setDrafts([])
    setWorkspaceFailures([])
    setState('signed-out')
    setError('')
  }

  const refresh = async () => {
    const current = clientRef.current
    if (!current) return
    try {
      await loadCatalogue(current)
    } catch (nextError) {
      setState('error')
      setError(readableError(nextError))
    }
  }

  const acceptInvitation = async () => {
    const current = clientRef.current
    if (!current || !pendingInvitation) throw new Error('Sign in before accepting this invitation.')
    try {
      const membership = await current.acceptInvitation(pendingInvitation.token)
      setPendingInvitation(null)
      await loadCatalogue(current)
      return membership
    } catch (nextError) {
      setError(readableError(nextError))
      throw nextError
    }
  }

  const createWorkspace = async (request: { id: string; name: string }) => {
    const current = clientRef.current
    if (!current) throw new Error('Sign in before creating a workspace.')
    const created = await current.createWorkspace(request)
    await loadCatalogue(current)
    return created
  }

  const createProject = async (workspaceId: string, request: { id: string; name: string }) => {
    const current = clientRef.current
    if (!current) throw new Error('Sign in before creating a draft.')
    const created = await current.createProject(workspaceId, request)
    await loadCatalogue(current)
    return created
  }

  const projectsForWorkspace = useCallback((workspaceId: string) => (
    drafts.filter((draft) => draft.workspaceId === workspaceId)
  ), [drafts])

  const launchFor = useCallback((
    workspaceId: string,
    projectId: string,
    options: Pick<CollaborationProjectLaunch, 'bootstrapSource' | 'canBootstrap' | 'requireEmptyForBootstrap'> = {},
  ) => {
    const currentClient = clientRef.current
    const token = tokenRef.current
    if (!currentClient || !token || !profile) return null
    const workspaceProjects = drafts.filter((draft) => draft.workspaceId === workspaceId)
    if (!workspaceProjects.some((project) => project.id === projectId)) return null
    return {
      serviceUrl,
      token,
      client: currentClient,
      profile,
      workspaces,
      projects: workspaceProjects,
      workspaceId,
      projectId,
      ...options,
    }
  }, [drafts, profile, serviceUrl, workspaces])

  const value = useMemo<CollaborationSessionContextValue>(() => ({
    state,
    serviceUrl,
    profile,
    workspaces,
    drafts,
    workspaceFailures,
    pendingInvitation,
    error,
    client,
    token: tokenRef.current,
    configureDevelopmentService,
    signIn,
    useAccessToken,
    signOut,
    refresh,
    acceptInvitation,
    createWorkspace,
    createProject,
    projectsForWorkspace,
    launchFor,
  }), [client, drafts, error, launchFor, pendingInvitation, profile, projectsForWorkspace, serviceUrl, state, workspaceFailures, workspaces])

  return <CollaborationSessionContext.Provider value={value}>{children}</CollaborationSessionContext.Provider>
}

export function useCollaborationSession() {
  const value = useContext(CollaborationSessionContext)
  if (!value) throw new Error('Collaboration session state is unavailable outside the application shell.')
  return value
}

export function useOptionalCollaborationSession() {
  return useContext(CollaborationSessionContext)
}
