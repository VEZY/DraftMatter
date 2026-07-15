import { Server, type ServerConfiguration } from '@hocuspocus/server'
import * as Y from 'yjs'
import { AuthenticatedWorkspaceService, type WorkspaceRole } from '../../src/collaboration/workspaceService'
import { CollaborationStoreError, type CollaborationProjectScope } from './fileStore'
import type { CollaborationPersistence } from './persistence'

const SAFE_ID = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/
const ROOTS = {
  document: 'draftmatter:document',
  anchors: 'draftmatter:anchors',
  authors: 'draftmatter:authors',
  proposals: 'draftmatter:proposals',
  threads: 'draftmatter:threads',
  decisions: 'draftmatter:decisions',
  meta: 'draftmatter:meta',
  prosemirror: 'draftmatter:prosemirror',
} as const

export interface CollaborationConnectionContext extends CollaborationProjectScope {
  userId: string
  sessionId: string
  role: WorkspaceRole
}

export interface DraftMatterHocuspocusOptions {
  authorization: AuthenticatedWorkspaceService
  persistence: CollaborationPersistence
  port?: number
  address?: string
  snapshotIdFactory?: () => string
  debounceMs?: number
  maxDebounceMs?: number
  maxPayloadBytes?: number
}

export function collaborationDocumentName(scope: CollaborationProjectScope) {
  if (!SAFE_ID.test(scope.workspaceId) || !SAFE_ID.test(scope.projectId)) throw new Error('Collaboration document scope is invalid.')
  return `${scope.workspaceId}:${scope.projectId}`
}

export function parseCollaborationDocumentName(documentName: string): CollaborationProjectScope {
  const separator = documentName.indexOf(':')
  const workspaceId = documentName.slice(0, separator)
  const projectId = documentName.slice(separator + 1)
  if (separator <= 0 || !SAFE_ID.test(workspaceId) || !SAFE_ID.test(projectId)) throw new Error('Collaboration document was not found.')
  return { workspaceId, projectId }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]))
  return value
}

function protectedFingerprint(document: Y.Doc) {
  const knownRoots = new Set<string>(Object.values(ROOTS))
  const unknownRoots = [...document.share.keys()].filter((name) => !knownRoots.has(name)).sort()
  return JSON.stringify(canonical({
    document: document.getText(ROOTS.document).toString(),
    anchors: document.getMap(ROOTS.anchors).toJSON(),
    proposals: document.getMap(ROOTS.proposals).toJSON(),
    decisions: document.getMap(ROOTS.decisions).toJSON(),
    meta: document.getMap(ROOTS.meta).toJSON(),
    prosemirror: document.getXmlFragment(ROOTS.prosemirror).toJSON(),
    unknownRoots,
  }))
}

function mapSnapshot(document: Y.Doc, name: string) {
  return new Map([...document.getMap<Record<string, unknown>>(name).entries()].map(([key, value]) => [key, canonical(value)]))
}

function same(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function validSelfAuthor(value: unknown, userId: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.id === userId
    && typeof record.name === 'string'
    && record.name.trim().length > 0
    && record.name.length <= 200
    && Object.keys(record).every((key) => key === 'id' || key === 'name')
}

function validMessage(value: unknown, userId: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const message = value as Record<string, unknown>
  return message.authorId === userId
    && typeof message.content === 'string'
    && message.content.length > 0
    && message.content.length <= 20_000
    && (message.timestamp === undefined || typeof message.timestamp === 'string')
    && (message.index === undefined || Number.isSafeInteger(message.index))
}

function validNewThread(value: unknown, key: string, userId: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const thread = value as Record<string, unknown>
  return thread.id === key
    && thread.authorId === userId
    && typeof thread.anchorId === 'string'
    && SAFE_ID.test(thread.anchorId)
    && thread.status === 'open'
    && Array.isArray(thread.messages)
    && thread.messages.length > 0
    && thread.messages.length <= 500
    && thread.messages.every((message) => validMessage(message, userId))
}

function validThreadReply(before: unknown, after: unknown, userId: string) {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object' || Array.isArray(before) || Array.isArray(after)) return false
  const oldThread = before as Record<string, unknown>
  const newThread = after as Record<string, unknown>
  for (const field of ['id', 'anchorId', 'authorId', 'status', 'context']) {
    if (!same(oldThread[field], newThread[field])) return false
  }
  const oldMessages = oldThread.messages
  const newMessages = newThread.messages
  if (!Array.isArray(oldMessages) || !Array.isArray(newMessages) || newMessages.length <= oldMessages.length || newMessages.length > 500) return false
  if (!oldMessages.every((message, index) => same(message, newMessages[index]))) return false
  return newMessages.slice(oldMessages.length).every((message) => validMessage(message, userId))
}

function commenterMapsAllowed(before: Y.Doc, after: Y.Doc, userId: string) {
  const beforeAuthors = mapSnapshot(before, ROOTS.authors)
  const afterAuthors = mapSnapshot(after, ROOTS.authors)
  const authorKeys = new Set([...beforeAuthors.keys(), ...afterAuthors.keys()])
  for (const key of authorKeys) {
    if (same(beforeAuthors.get(key), afterAuthors.get(key))) continue
    if (key !== userId || !validSelfAuthor(afterAuthors.get(key), userId)) return false
  }

  const beforeThreads = mapSnapshot(before, ROOTS.threads)
  const afterThreads = mapSnapshot(after, ROOTS.threads)
  const threadKeys = new Set([...beforeThreads.keys(), ...afterThreads.keys()])
  for (const key of threadKeys) {
    const previous = beforeThreads.get(key)
    const next = afterThreads.get(key)
    if (same(previous, next)) continue
    if (previous === undefined ? !validNewThread(next, key, userId) : !validThreadReply(previous, next, userId)) return false
  }
  return true
}

export function commenterUpdateDiagnostic(document: Y.Doc, update: Uint8Array, userId: string): 'update-invalid' | 'protected-state-changed' | 'comment-record-invalid' | null {
  const candidate = new Y.Doc()
  try {
    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(document))
    Y.applyUpdate(candidate, update)
    if (protectedFingerprint(document) !== protectedFingerprint(candidate)) return 'protected-state-changed'
    if (!commenterMapsAllowed(document, candidate, userId)) return 'comment-record-invalid'
    return null
  } catch {
    return 'update-invalid'
  } finally {
    candidate.destroy()
  }
}

export function commenterUpdateAllowed(document: Y.Doc, update: Uint8Array, userId: string) {
  return commenterUpdateDiagnostic(document, update, userId) === null
}

export function createDraftMatterHocuspocusServer(options: DraftMatterHocuspocusOptions) {
  const snapshotIdFactory = options.snapshotIdFactory ?? (() => crypto.randomUUID())
  const configuration: Partial<ServerConfiguration<CollaborationConnectionContext>> = {
    port: options.port ?? 0,
    address: options.address ?? '127.0.0.1',
    stopOnSignals: false,
    quiet: true,
    debounce: options.debounceMs ?? 1_000,
    maxDebounce: options.maxDebounceMs ?? 10_000,
    maxUnauthenticatedQueueSize: options.maxPayloadBytes ?? 1024 * 1024,
    maxUnauthenticatedQueueMessages: 256,
    maxPendingDocuments: 8,
    websocketOptions: { maxPayload: options.maxPayloadBytes ?? 1024 * 1024 },
    async onAuthenticate({ token, documentName, connectionConfig }) {
      const scope = parseCollaborationDocumentName(documentName)
      const access = await options.authorization.authorizeProject(token, scope.workspaceId, scope.projectId, 'read')
      connectionConfig.readOnly = access.role === 'viewer'
      return { ...scope, userId: access.userId, sessionId: access.sessionId, role: access.role }
    },
    async beforeHandleMessage({ context, document, update }) {
      if (context.role === 'commenter' && !commenterUpdateAllowed(document, update, context.userId)) {
        throw new Error('Commenter updates may only create attributed threads or append attributed replies.')
      }
    },
    async onLoadDocument({ documentName }) {
      const scope = parseCollaborationDocumentName(documentName)
      try {
        const stored = await options.persistence.load(scope)
        const updates = [...(stored.snapshot ? [stored.snapshot] : []), ...stored.updates]
        return updates.length > 0 ? Y.mergeUpdates(updates) : undefined
      } catch (error) {
        if (error instanceof CollaborationStoreError && error.code === 'not-found') return undefined
        throw error
      }
    },
    async onChange({ documentName, update }) {
      await options.persistence.appendUpdate(parseCollaborationDocumentName(documentName), update)
    },
    async onStoreDocument({ documentName, document }) {
      await options.persistence.createSnapshot(
        parseCollaborationDocumentName(documentName),
        `snapshot-${snapshotIdFactory()}`,
        Y.encodeStateAsUpdate(document),
      )
    },
  }
  return new Server<CollaborationConnectionContext>(configuration)
}
