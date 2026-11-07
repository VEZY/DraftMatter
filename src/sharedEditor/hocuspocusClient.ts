import { collaborationJournalKey, createCollaborationJournal, retainCollaborativeDocument, type CollaborationJournal } from './collaborationJournal'
import { publishProjectResources, readProjectResources, type ProjectResources } from './projectResources'
import { HocuspocusProvider, type WebSocketStatus } from '@hocuspocus/provider'
import {
  CollaborativeDocument,
  type ActiveCollaborator,
  type CollaboratorPresence,
} from './collaboration'
import {
  createCollaborationCheckpoint,
  projectCollaborationPortableSource,
  type CollaborationCheckpoint,
} from './collaborationCheckpoint'
import {
  setCollaborativeEditorPresence,
  type CollaborativeEditorBinding,
} from './prosemirrorCollaboration'
import { COLLABORATIVE_REVIEW_ORIGIN, CollaborativeReviewBinding } from './collaborativeReview'

export type CollaborationClientStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

export interface CollaborationClientOptions {
  url: string
  workspaceId: string
  projectId: string
  token: string | (() => string | Promise<string>)
  bootstrapSource: string
  canBootstrap?: boolean
  requireEmptyForBootstrap?: boolean
  presence: CollaboratorPresence
  timeoutMs?: number
  onStatus?: (status: CollaborationClientStatus, detail?: string) => void
  onPortableSource?: (source: string) => void
  resources?: ProjectResources
  /** Read local files only after an empty room has been confirmed and bootstrap authorized. */
  resourceProvider?: () => Promise<ProjectResources>
  onResources?: (resources: ProjectResources) => void
  onRecoveryWarning?: (message: string) => void
  journal?: CollaborationJournal
  onCollaborators?: (collaborators: ActiveCollaborator[]) => void
}

const SAFE_ID = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/
const LOCAL_ORIGIN = 'draftmatter-local-portable-source'

export function validateCollaborationServiceUrl(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Enter a valid collaboration WebSocket URL.')
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback)) {
    throw new Error('Collaboration requires wss://, except for a localhost development service.')
  }
  url.hash = ''
  url.search = ''
  return url.toString().replace(/\/$/, '')
}

function documentName(workspaceId: string, projectId: string) {
  if (!SAFE_ID.test(workspaceId) || !SAFE_ID.test(projectId)) throw new Error('Workspace and project IDs must use safe portable identifiers.')
  return `${workspaceId}:${projectId}`
}

export function bootstrapCollaborationSource(collaboration: CollaborativeDocument, source: string, canBootstrap = true, requireEmpty = false) {
  if (collaboration.source || collaboration.snapshot().authors.length > 0) {
    if (requireEmpty) throw new Error('The collaborative draft already contains content. DraftMatter did not overwrite it.')
    return false
  }
  if (!canBootstrap) throw new Error('The manuscript has not been initialized by its owner yet.')
  collaboration.reconcilePortableSource(source, 'collaboration-bootstrap')
  return true
}

export async function initializeCollaborationSource(collaboration: CollaborativeDocument, options: {
  source: string
  canBootstrap: boolean
  requireEmpty?: boolean
  resources?: ProjectResources
  resourceProvider?: () => Promise<ProjectResources>
}) {
  const initialized = Boolean(collaboration.source || collaboration.snapshot().authors.length)
  if (initialized || !options.canBootstrap) return bootstrapCollaborationSource(collaboration, options.source, options.canBootstrap, options.requireEmpty)
  const resources = await options.resourceProvider?.() ?? options.resources
  // Validate before mutating the room: a failed resource import must leave it empty.
  if (resources) {
    const staging = new CollaborativeDocument()
    try { publishProjectResources(staging.doc, resources) } finally { staging.destroy() }
  }
  let bootstrapped = false
  collaboration.doc.transact(() => {
    // A peer may have initialized the room while the filesystem read was pending.
    bootstrapped = bootstrapCollaborationSource(collaboration, options.source, options.canBootstrap, options.requireEmpty)
    if (bootstrapped && resources) publishProjectResources(collaboration.doc, resources)
  }, 'collaboration-bootstrap')
  return bootstrapped
}

export class HocuspocusCollaborationClient {
  readonly collaboration: CollaborativeDocument
  readonly editorBinding: CollaborativeEditorBinding
  private readonly provider: HocuspocusProvider
  private readonly stopUpdate: () => void
  private readonly awarenessHandler: () => void
  private lastPortableSource = ''
  private resourceHandler?: () => void
  private beforeUnload?: (event: BeforeUnloadEvent) => void
  private recovery?: Awaited<ReturnType<typeof retainCollaborativeDocument>>
  private readonly onRecoveryWarning?: (message: string) => void

  private constructor(collaboration: CollaborativeDocument, provider: HocuspocusProvider, options: CollaborationClientOptions) {
    this.collaboration = collaboration
    this.onRecoveryWarning = options.onRecoveryWarning
    this.editorBinding = {
      document: collaboration.doc,
      awareness: collaboration.awareness,
      user: { id: options.presence.userId, name: options.presence.name, color: options.presence.color ?? '#617f73' },
      publishPortableSource: (source) => this.publishPortableSource(source),
      review: new CollaborativeReviewBinding(collaboration, (source) => { this.lastPortableSource = source }),
    }
    this.provider = provider
    this.stopUpdate = collaboration.onPortableUpdate((origin) => {
      if (origin === LOCAL_ORIGIN || origin === COLLABORATIVE_REVIEW_ORIGIN || origin === 'collaboration-bootstrap') return
      try {
        const source = projectCollaborationPortableSource(collaboration)
        this.lastPortableSource = source
        options.onPortableSource?.(source)
      } catch (error) {
        options.onStatus?.('error', error instanceof Error ? error.message : String(error))
      }
    })
    this.awarenessHandler = () => options.onCollaborators?.(collaboration.activeCollaborators())
    collaboration.awareness.on('change', this.awarenessHandler)
  }

  static async connect(options: CollaborationClientOptions) {
    const url = validateCollaborationServiceUrl(options.url)
    const name = documentName(options.workspaceId, options.projectId)
    if (typeof options.token === 'string' && (!options.token.trim() || options.token.length > 16_384)) throw new Error('A valid short-lived collaboration token is required.')
    const collaboration = new CollaborativeDocument()
    const journal = options.journal ?? createCollaborationJournal(collaborationJournalKey(url, options.workspaceId, options.projectId, options.presence.userId))
    let recovery: Awaited<ReturnType<typeof retainCollaborativeDocument>>
    try {
      recovery = await retainCollaborativeDocument(collaboration.doc, journal, (message) => {
        if (options.onRecoveryWarning) options.onRecoveryWarning(message)
        else options.onStatus?.('error', message)
      })
    } catch (error) {
      collaboration.destroy()
      throw error
    }
    collaboration.setLocalPresence(options.presence)
    setCollaborativeEditorPresence(collaboration.awareness, {
      id: options.presence.userId,
      name: options.presence.name,
      color: options.presence.color ?? '#617f73',
    })
    options.onStatus?.('connecting')

    let resolveSync!: () => void
    let rejectSync!: (error: Error) => void
    const synced = new Promise<void>((resolve, reject) => {
      resolveSync = resolve
      rejectSync = reject
    })
    const providerOptions = {
      url,
      name,
      token: options.token,
      document: collaboration.doc,
      awareness: collaboration.awareness,
      flushDelay: 120,
      onSynced: ({ state }: { state: boolean }) => { if (state) resolveSync() },
      onAuthenticationFailed: ({ reason }: { reason: string }) => {
        const message = reason || 'Collaboration authentication failed.'
        options.onStatus?.('error', message)
        rejectSync(new Error(message))
      },
      onStatus: ({ status }: { status: WebSocketStatus }) => {
        if (status === 'connected') options.onStatus?.('connected')
        else if (status === 'disconnected') options.onStatus?.('disconnected')
        else options.onStatus?.('connecting')
      },
    } as ConstructorParameters<typeof HocuspocusProvider>[0]
    const provider = new HocuspocusProvider(providerOptions)
    const client = new HocuspocusCollaborationClient(collaboration, provider, options)
    client.recovery = recovery
    client.beforeUnload = (event) => {
      if (recovery.unsafeToClose || provider.hasUnsyncedChanges) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', client.beforeUnload)
    client.resourceHandler = () => {
      try { options.onResources?.(readProjectResources(collaboration.doc)) } catch (error) { options.onStatus?.('error', error instanceof Error ? error.message : String(error)) }
    }
    collaboration.doc.getMap('draftmatter:resources').observe(client.resourceHandler)
    const timeout = window.setTimeout(() => rejectSync(new Error('The collaboration service did not synchronize in time.')), options.timeoutMs ?? 10_000)
    try {
      await synced
      window.clearTimeout(timeout)
      await initializeCollaborationSource(collaboration, {
        source: options.bootstrapSource,
        canBootstrap: options.canBootstrap === true,
        requireEmpty: !recovery.recovered && options.requireEmptyForBootstrap === true,
        resources: options.resources,
        resourceProvider: options.resourceProvider,
      })
      client.resourceHandler()
      await recovery.flush()
      options.onRecoveryWarning?.(recovery.unsafeToClose ? 'Offline recovery could not be saved. Keep this window open until your changes synchronize.' : '')
      const source = projectCollaborationPortableSource(collaboration)
      client.lastPortableSource = source
      options.onPortableSource?.(source)
      options.onCollaborators?.(collaboration.activeCollaborators())
      options.onStatus?.('connected')
      return client
    } catch (error) {
      window.clearTimeout(timeout)
      client.destroy()
      options.onStatus?.('error', error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  publishPortableSource(source: string) {
    if (source === this.lastPortableSource) return this.lastPortableSource
    this.collaboration.reconcilePortableSource(source, LOCAL_ORIGIN)
    this.lastPortableSource = projectCollaborationPortableSource(this.collaboration)
    return this.lastPortableSource
  }

  publishResources(resources: ProjectResources) { publishProjectResources(this.collaboration.doc, resources) }

  async flushRecovery() {
    await this.recovery?.flush()
    const safe = !this.recovery?.unsafeToClose
    this.onRecoveryWarning?.(safe ? '' : 'Offline recovery could not be saved. Keep this window open until your changes synchronize.')
    return safe
  }

  createCheckpoint(): CollaborationCheckpoint {
    const checkpoint = createCollaborationCheckpoint(this.collaboration)
    this.lastPortableSource = checkpoint.source
    return checkpoint
  }

  disconnect() {
    this.provider.disconnect()
  }

  destroy() {
    this.stopUpdate()
    if (this.beforeUnload) window.removeEventListener('beforeunload', this.beforeUnload)
    if (this.resourceHandler) this.collaboration.doc.getMap('draftmatter:resources').unobserve(this.resourceHandler)
    this.recovery?.close()
    this.collaboration.awareness.off('change', this.awarenessHandler)
    this.provider.destroy()
    this.collaboration.destroy()
  }
}
