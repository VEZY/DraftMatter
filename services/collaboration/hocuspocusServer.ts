import { Server, type ServerConfiguration } from '@hocuspocus/server'
import type { IncomingMessage, ServerResponse } from 'node:http'
import * as Y from 'yjs'
import type { ProjectAuthorizationService, WorkspaceRole } from '../../src/collaboration/workspaceService'
import { CollaborationStoreError, type CollaborationProjectScope } from './fileStore'
import type { CollaborationPersistence } from './persistence'

const SAFE_ID = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/
const ROOTS = {
  document: 'draftmatter:document',
  anchors: 'draftmatter:anchors',
  authors: 'draftmatter:authors',
  proposals: 'draftmatter:proposals',
  threads: 'draftmatter:threads',
  threadMessages: 'draftmatter:thread-messages',
  threadStatuses: 'draftmatter:thread-statuses',
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
  authorization: ProjectAuthorizationService
  persistence: CollaborationPersistence
  port?: number
  address?: string
  snapshotIdFactory?: () => string
  debounceMs?: number
  maxDebounceMs?: number
  maxPayloadBytes?: number
  tokenRefreshMs?: number
  allowedOrigins?: string[]
  httpHandler?: (request: IncomingMessage, response: ServerResponse) => Promise<void>
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
  const unknownRoots = Object.fromEntries([...document.share.entries()]
    .filter(([name]) => !knownRoots.has(name))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => [name, canonical(value.toJSON())]))
  return JSON.stringify(canonical({
    document: document.getText(ROOTS.document).toString(),
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
    && (message.timestamp === undefined || (typeof message.timestamp === 'string' && message.timestamp.length <= 100))
    && (message.index === undefined || (Number.isSafeInteger(message.index) && Number(message.index) >= 0))
}

function validContext(value: unknown) {
  if (value === undefined) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const context = value as Record<string, unknown>
  return Object.keys(context).every((key) => key === 'quote' || key === 'prefix' || key === 'suffix')
    && typeof context.quote === 'string'
    && typeof context.prefix === 'string'
    && typeof context.suffix === 'string'
    && context.quote.length <= 20_000
    && context.prefix.length <= 1_024
    && context.suffix.length <= 1_024
}

function validNewThread(value: unknown, key: string, userId: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const thread = value as Record<string, unknown>
  return thread.id === key
    && thread.authorId === userId
    && typeof thread.anchorId === 'string'
    && SAFE_ID.test(thread.anchorId)
    && thread.status === 'open'
    && validContext(thread.context)
    && Array.isArray(thread.messages)
    && thread.messages.length <= 500
    && thread.messages.every((message) => validMessage(message, userId))
    && Object.keys(thread).every((field) => ['id', 'anchorId', 'authorId', 'status', 'messages', 'context'].includes(field))
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

function hexBytes(value: unknown) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8_192 || value.length % 2 !== 0 || !/^[a-f0-9]+$/i.test(value)) return null
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16))
}

function validNewAnchor(document: Y.Doc, value: unknown, key: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !SAFE_ID.test(key)) return false
  const anchor = value as Record<string, unknown>
  if (anchor.id !== key || !validContext(anchor.context) || !Object.keys(anchor).every((field) => ['id', 'start', 'end', 'context'].includes(field))) return false
  try {
    const startBytes = hexBytes(anchor.start)
    const endBytes = hexBytes(anchor.end)
    if (!startBytes || !endBytes) return false
    const text = document.getText(ROOTS.document)
    const start = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(startBytes), document)
    const end = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(endBytes), document)
    return Boolean(start && end && start.type === text && end.type === text && start.index <= end.index && end.index <= text.length)
  } catch {
    return false
  }
}

function validStoredMessage(value: unknown, key: string, userId: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || key.length > 50_000) return false
  const message = value as Record<string, unknown>
  return message.id === key
    && typeof message.threadId === 'string'
    && SAFE_ID.test(message.threadId)
    && validMessage(message, userId)
    && Object.keys(message).every((field) => ['id', 'threadId', 'content', 'authorId', 'timestamp', 'index'].includes(field))
}

function validNewThreadStatus(value: unknown, key: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const status = value as Record<string, unknown>
  return status.id === key && status.status === 'open' && Object.keys(status).every((field) => field === 'id' || field === 'status')
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
  const newThreadIds = new Set<string>()
  const threadKeys = new Set([...beforeThreads.keys(), ...afterThreads.keys()])
  for (const key of threadKeys) {
    const previous = beforeThreads.get(key)
    const next = afterThreads.get(key)
    if (same(previous, next)) continue
    if (previous === undefined) {
      if (!validNewThread(next, key, userId)) return false
      newThreadIds.add(key)
    } else if (!validThreadReply(previous, next, userId)) return false
  }

  const beforeMessages = mapSnapshot(before, ROOTS.threadMessages)
  const afterMessages = mapSnapshot(after, ROOTS.threadMessages)
  const addedMessagesByThread = new Map<string, number>()
  for (const key of new Set([...beforeMessages.keys(), ...afterMessages.keys()])) {
    const previous = beforeMessages.get(key)
    const next = afterMessages.get(key)
    if (same(previous, next)) continue
    if (previous !== undefined || !validStoredMessage(next, key, userId)) return false
    const threadId = String((next as Record<string, unknown>).threadId)
    if (!afterThreads.has(threadId)) return false
    addedMessagesByThread.set(threadId, (addedMessagesByThread.get(threadId) ?? 0) + 1)
  }

  const beforeStatuses = mapSnapshot(before, ROOTS.threadStatuses)
  const afterStatuses = mapSnapshot(after, ROOTS.threadStatuses)
  for (const key of new Set([...beforeStatuses.keys(), ...afterStatuses.keys()])) {
    const previous = beforeStatuses.get(key)
    const next = afterStatuses.get(key)
    if (same(previous, next)) continue
    if (previous !== undefined || !newThreadIds.has(key) || !validNewThreadStatus(next, key)) return false
  }

  const beforeAnchors = mapSnapshot(before, ROOTS.anchors)
  const afterAnchors = mapSnapshot(after, ROOTS.anchors)
  const newThreadAnchorIds = new Set([...newThreadIds].map((threadId) => String((afterThreads.get(threadId) as Record<string, unknown>).anchorId)))
  for (const key of new Set([...beforeAnchors.keys(), ...afterAnchors.keys()])) {
    const previous = beforeAnchors.get(key)
    const next = afterAnchors.get(key)
    if (same(previous, next)) continue
    if (previous !== undefined || !newThreadAnchorIds.has(key) || !validNewAnchor(after, next, key)) return false
  }

  for (const threadId of newThreadIds) {
    const thread = afterThreads.get(threadId) as Record<string, unknown>
    const embeddedMessages = Array.isArray(thread.messages) ? thread.messages.length : 0
    if (!afterAuthors.has(userId) || !afterAnchors.has(String(thread.anchorId)) || embeddedMessages + (addedMessagesByThread.get(threadId) ?? 0) === 0) return false
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
  const authorizeConnection = async (token: string, scope: CollaborationProjectScope, connectionConfig: { readOnly: boolean }) => {
    const access = await options.authorization.authorizeProject(token, scope.workspaceId, scope.projectId, 'read')
    let readOnly = access.role === 'viewer'
    if (!readOnly) {
      try {
        await options.authorization.authorizeProject(token, scope.workspaceId, scope.projectId, access.role === 'commenter' ? 'comment' : 'edit')
      } catch (error) {
        if ((error as { code?: string }).code !== 'forbidden') throw error
        readOnly = true
      }
    }
    connectionConfig.readOnly = readOnly
    return { ...scope, userId: access.userId, sessionId: access.sessionId, role: access.role }
  }
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
    async onConnect({ requestHeaders }) {
      const origin = requestHeaders.get('origin')?.replace(/\/$/, '')
      if (origin && options.allowedOrigins?.length && !options.allowedOrigins.includes(origin)) {
        throw { code: 4403, reason: 'This browser origin is not allowed.' }
      }
    },
    async onRequest({ request, response }) {
      if (!options.httpHandler) return
      await options.httpHandler(request, response)
      throw null
    },
    async onAuthenticate({ token, documentName, connectionConfig }) {
      const scope = parseCollaborationDocumentName(documentName)
      return authorizeConnection(token, scope, connectionConfig)
    },
    async connected({ connection }) {
      const interval = setInterval(() => connection.requestToken(), options.tokenRefreshMs ?? 5 * 60_000)
      interval.unref()
      connection.onClose(() => clearInterval(interval))
    },
    async onTokenSync({ token, documentName, connectionConfig, connection }) {
      const context = await authorizeConnection(token, parseCollaborationDocumentName(documentName), connectionConfig)
      connection.readOnly = connectionConfig.readOnly
      return context
    },
    async beforeHandleMessage({ context, document, update, connection }) {
      if (options.authorization.reauthorizeProject) {
        try {
          await options.authorization.reauthorizeProject(
            context,
            context.workspaceId,
            context.projectId,
            context.role === 'commenter' ? 'comment' : context.role === 'viewer' ? 'read' : 'edit',
          )
        } catch (error) {
          connection.close({ code: 4403, reason: 'Collaboration access was revoked.' })
          throw error
        }
      }
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
