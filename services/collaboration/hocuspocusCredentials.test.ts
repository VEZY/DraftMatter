import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { Server } from '@hocuspocus/server'
import { jwtVerify, SignJWT } from 'jose'
import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import type { ProjectAuthorizationService } from '../../src/collaboration/workspaceService'
import { collaborationSocketCredential, collaborationUpgradeMessage } from '../../src/sharedEditor/collaborationProtocol'
import { FileCollaborationStore } from './fileStore'
import { createDraftMatterHocuspocusServer } from './hocuspocusServer'

async function waitFor(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 4_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function fixture(options: { maxSocketConnections?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'draftmatter-credential-deadline-'))
  const key = new Uint8Array(32).fill(7)
  const issue = (milliseconds: number, userId = 'reader') => new SignJWT({ sid: `session-${userId}` })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(userId).setIssuedAt()
    .setExpirationTime((Date.now() + milliseconds) / 1_000).sign(key)
  const authorize = vi.fn<ProjectAuthorizationService['authorizeProject']>(async (token, _workspace, _project, capability) => {
    const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] })
    return { userId: payload.sub!, sessionId: String(payload.sid), role: 'viewer', capability }
  })
  const persistence = new FileCollaborationStore({ root })
  const seed = new Y.Doc()
  seed.getText('draftmatter:document').insert(0, 'Private manuscript')
  await persistence.createSnapshot({ workspaceId: 'forest', projectId: 'paper' }, 'seed', Y.encodeStateAsUpdate(seed))
  seed.destroy()
  const server = createDraftMatterHocuspocusServer({
    authorization: { authorizeProject: authorize }, persistence,
    port: 0, tokenRefreshMs: 100, debounceMs: 10, maxDebounceMs: 20,
    ...options,
  })
  await server.listen()
  const document = new Y.Doc()
  const closed = vi.fn()
  const tokens = vi.fn<() => Promise<string>>()
  const provider = new HocuspocusProvider({
    url: server.webSocketURL, name: 'forest:paper', document,
    token: async () => collaborationSocketCredential(await tokens()), WebSocketPolyfill: WebSocket, onClose: closed,
  } as ConstructorParameters<typeof HocuspocusProvider>[0])
  provider.disconnect()
  const connections = () => server.hocuspocus.documents.get('forest:paper')?.getConnections() ?? []
  const connect = async () => {
    await provider.configuration.websocketProvider.connect()
    await waitFor(() => provider.isSynced, 'The reader did not synchronize.')
    closed.mockClear()
    expect(document.getText('draftmatter:document').toString()).toBe('Private manuscript')
  }
  const cleanup = async () => {
    provider.destroy()
    document.destroy()
    await server.destroy()
    await rm(root, { recursive: true, force: true })
  }
  return { issue, authorize, provider, tokens, closed, connections, connect, cleanup, server }
}

describe('live collaboration credential expiration', () => {
  it('refuses incompatible peers in both directions before loading or synchronizing the room', async () => {
    const test = await fixture()
    const token = await test.issue(8_000)
    const loadLegacyRoom = vi.fn(async () => null)
    // Legacy servers pass the entire socket credential to their normal JWT verifier.
    const legacy = new Server({
      port: 0, address: '127.0.0.1', quiet: true, stopOnSignals: false,
      onAuthenticate: async ({ token }) => test.authorize(token, 'forest', 'paper', 'read'),
      onLoadDocument: loadLegacyRoom,
    })
    async function refused(url: string, credential: string, reason: string) {
      const document = new Y.Doc()
      const denied = vi.fn()
      const provider = new HocuspocusProvider({
        url, name: 'forest:paper', document, token: credential, WebSocketPolyfill: WebSocket,
        onAuthenticationFailed: denied,
      } as ConstructorParameters<typeof HocuspocusProvider>[0])
      try {
        await waitFor(() => denied.mock.calls.length > 0, 'Expected an incompatible peer to be refused.')
        expect(denied).toHaveBeenCalledWith({ reason })
        expect(provider.isSynced).toBe(false)
        expect(document.getText('draftmatter:document').length).toBe(0)
      } finally { provider.destroy(); document.destroy() }
    }
    try {
      await refused(test.server.webSocketURL, token, collaborationUpgradeMessage)
      expect(test.authorize).not.toHaveBeenCalled()
      expect(test.server.hocuspocus.documents.size).toBe(0)
      await legacy.listen()
      await refused(legacy.webSocketURL, collaborationSocketCredential(token), 'permission-denied')
      expect(loadLegacyRoom).not.toHaveBeenCalled()
      expect(legacy.hocuspocus.documents.size).toBe(0)
    } finally { await legacy.destroy(); await test.cleanup() }
  })

  it('closes a synchronized room if a renewal provides a valid credential in an incompatible format', async () => {
    const test = await fixture()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const token = await test.issue(8_000)
      test.tokens.mockResolvedValue(token)
      await test.connect()
      test.provider.configuration.token = token
      await test.provider.sendToken()
      await waitFor(() => test.closed.mock.calls.length > 0, 'The incompatible renewal kept the room open.')
      expect(test.closed.mock.calls.some(([payload]) => payload.event.reason === collaborationUpgradeMessage)).toBe(true)
      expect(test.connections()).toHaveLength(0)
    } finally { errors.mockRestore(); await test.cleanup() }
  })

  it.each([true, false])('disconnects idle readers at expiry when refresh is ignored=%s, including replayed tokens', async (ignoreRefresh) => {
    const test = await fixture()
    try {
      const token = await test.issue(900)
      test.tokens.mockResolvedValue(token)
      await test.connect()
      const ignored = ignoreRefresh ? vi.spyOn(test.provider, 'sendToken').mockResolvedValue() : undefined
      await waitFor(() => test.closed.mock.calls.length > 0, 'Expired credentials retained a live room connection.')
      expect(test.closed.mock.calls.some(([payload]) => payload.event.reason.includes('credentials expired'))).toBe(true)
      expect(test.connections()).toHaveLength(0)
      if (ignoreRefresh) expect(ignored).toHaveBeenCalled()
      else expect(test.tokens.mock.calls.length).toBeGreaterThan(1)
    } finally { await test.cleanup() }
  })

  it('keeps a reader connected beyond the original expiry after a verified same-account renewal', async () => {
    const test = await fixture()
    try {
      const original = await test.issue(700)
      const renewed = await test.issue(8_000)
      test.tokens.mockResolvedValueOnce(original).mockResolvedValue(renewed)
      await test.connect()
      await waitFor(() => test.tokens.mock.calls.length > 1, 'The server did not request a token before expiry.')
      await new Promise((resolve) => setTimeout(resolve, 850))
      expect(test.connections()).toHaveLength(1)
      expect(test.closed).not.toHaveBeenCalled()
      expect(test.authorize).toHaveBeenCalledWith(renewed, 'forest', 'paper', 'read')
    } finally { await test.cleanup() }
  })

  it('requires reconnecting to switch the authenticated account during renewal', async () => {
    const test = await fixture()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const original = await test.issue(8_000)
      const anotherAccount = await test.issue(8_000, 'another-reader')
      test.tokens.mockResolvedValueOnce(original).mockResolvedValue(anotherAccount)
      await test.connect()
      await waitFor(() => test.closed.mock.calls.length > 0, 'A connection changed account during renewal.')
      expect(test.closed.mock.calls.some(([payload]) => payload.event.reason.includes('change the collaboration account'))).toBe(true)
      expect(test.connections()).toHaveLength(0)
    } finally { errors.mockRestore(); await test.cleanup() }
  })

  it('caps authenticated documents per account across sockets, releases closed slots, and keeps other accounts independent', async () => {
    const test = await fixture()
    const extra: Array<{ provider: HocuspocusProvider; document: Y.Doc; closed: ReturnType<typeof vi.fn> }> = []
    const open = async (token: string) => {
      const document = new Y.Doc(), closed = vi.fn()
      const provider = new HocuspocusProvider({
        url: test.server.webSocketURL, name: 'forest:paper', document,
        token: collaborationSocketCredential(token), WebSocketPolyfill: WebSocket, onClose: closed,
      } as ConstructorParameters<typeof HocuspocusProvider>[0])
      const result = { provider, document, closed }
      extra.push(result)
      await provider.configuration.websocketProvider.connect()
      await waitFor(() => provider.isSynced || closed.mock.calls.length > 0, 'Additional reader did not connect or get rejected.')
      return result
    }
    try {
      const token = await test.issue(8_000)
      test.tokens.mockResolvedValue(token)
      await test.connect()
      for (let index = 0; index < 7; index++) await open(token)
      expect(test.connections()).toHaveLength(8)
      const excess = await open(token)
      await waitFor(() => excess.closed.mock.calls.length > 0, 'The per-account connection cap was not enforced.')
      expect(excess.closed.mock.calls.some(([payload]) => payload.event.reason.includes('eight open collaboration documents'))).toBe(true)
      expect(test.connections()).toHaveLength(8)
      await open(await test.issue(8_000, 'other-reader'))
      expect(test.connections()).toHaveLength(9)
      extra[0].provider.destroy()
      await waitFor(() => test.connections().length === 8, 'A closed account slot was not released.')
      const replacement = await open(token)
      expect(replacement.closed).not.toHaveBeenCalled()
      expect(test.connections()).toHaveLength(9)
    } finally {
      for (const item of extra) { item.provider.destroy(); item.document.destroy() }
      await test.cleanup()
    }
  })

  it('bounds physical sockets before authentication and releases capacity when they close', async () => {
    const test = await fixture({ maxSocketConnections: 3 })
    const sockets: WebSocket[] = []
    const open = () => {
      const socket = new WebSocket(test.server.webSocketURL)
      sockets.push(socket)
      socket.addEventListener('error', () => {})
      return socket
    }
    try {
      for (let index = 0; index < 3; index++) {
        const socket = open()
        await waitFor(() => socket.readyState === WebSocket.OPEN, 'Anonymous socket did not open.')
      }
      const excess = open()
      await waitFor(() => excess.readyState === WebSocket.CLOSED, 'The pre-authentication socket cap was not enforced.')
      expect(test.authorize).not.toHaveBeenCalled()
      sockets[0].close()
      await waitFor(() => sockets[0].readyState === WebSocket.CLOSED, 'The anonymous socket did not close.')
      const replacement = open()
      await waitFor(() => replacement.readyState === WebSocket.OPEN, 'The closed anonymous slot was not released.')
    } finally {
      for (const socket of sockets) if (socket.readyState !== WebSocket.CLOSED) socket.close()
      await waitFor(() => sockets.every((socket) => socket.readyState === WebSocket.CLOSED), 'Fixture sockets did not close.')
      await test.cleanup()
    }
  })
})
