/** Implementation detail of benchmark-collaboration.mjs; never imported by the service. */
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { AuthenticatedWorkspaceService } from '../src/collaboration/workspaceService'
import { collaborationSocketCredential } from '../src/sharedEditor/collaborationProtocol'
import { PROJECT_RESOURCES_ROOT, publishProjectResources, sharedImage } from '../src/sharedEditor/projectResources'
import * as transport from '../services/collaboration/hocuspocusServer'
import { FileCollaborationStore } from '../services/collaboration/fileStore'

const [scenario, mode, fixtureName, sampleArgument, roundArgument] = process.argv.slice(2)
const samples = Number(sampleArgument)
const rounds = Number(roundArgument)
const clientsCount = 10
const warmupRounds = 2
const scope = { workspaceId: 'benchmark', projectId: 'paper' }
const documentName = 'benchmark:paper'
const roles = Array.from({ length: clientsCount }, (_, index) => index < 8 ? 'editor' as const : 'commenter' as const)
const rootNames = ['draftmatter:document', 'draftmatter:anchors', 'draftmatter:authors', 'draftmatter:proposals', 'draftmatter:threads', 'draftmatter:thread-messages', 'draftmatter:thread-statuses', 'draftmatter:decisions', 'draftmatter:meta', 'draftmatter:prosemirror', PROJECT_RESOURCES_ROOT]
const figureSizes = { article: 128 * 1024, rich: 512 * 1024 }
const settings = fixtureName === 'rich'
  ? { prose: 160 * 1024, images: 4, imageBytes: figureSizes.rich, citations: 200, threads: 200, messagesPerThread: 5, proposals: 100 }
  : { prose: 40 * 1024, images: 2, imageBytes: figureSizes.article, citations: 50, threads: 50, messagesPerThread: 5, proposals: 25 }

function quantiles(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]
  return { count: values.length, p50Ms: at(0.5), p95Ms: at(0.95), p99Ms: at(0.99), maxMs: sorted.at(-1), meanMs: values.reduce((sum, value) => sum + value, 0) / values.length }
}

function fixture() {
  const document = new Y.Doc()
  // Fixed IDs make fixture size and structure deterministic across processes.
  document.clientID = 1
  const paragraph = 'Oil-palm canopy assimilation responded to soil water and intercepted light. We compare simulations with field observations and report uncertainty [@vezy2026].\n\n'
  const source = '# Canopy response under drought\n\n' + paragraph.repeat(Math.ceil(settings.prose / paragraph.length)).slice(0, settings.prose)
  const text = document.getText('draftmatter:document')
  text.insert(0, source)
  document.getMap('draftmatter:meta').set('schemaVersion', 1)
  const authors = document.getMap('draftmatter:authors')
  for (let index = 0; index < clientsCount; index++) authors.set(`user${index}`, { id: `user${index}`, name: `Researcher ${index}` })
  const anchors = document.getMap('draftmatter:anchors')
  const position = (index: number) => Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, index))).toString('hex')
  for (let index = 0; index < settings.threads; index++) {
    const anchorId = `dm-anchor-${index}`
    const threadId = `dm-thread-${index}`
    anchors.set(anchorId, { id: anchorId, start: position(100 + index * 10), end: position(105 + index * 10), context: { quote: 'canopy', prefix: 'Oil-palm ', suffix: ' response' } })
    document.getMap('draftmatter:threads').set(threadId, { id: threadId, anchorId, authorId: `user${index % clientsCount}`, status: 'open', messages: [] })
    document.getMap('draftmatter:thread-statuses').set(threadId, { id: threadId, status: 'open' })
    for (let message = 0; message < settings.messagesPerThread; message++) {
      const id = `history-${index}-${message}`
      document.getMap('draftmatter:thread-messages').set(id, { id, threadId, authorId: `user${message % clientsCount}`, content: `Historical review ${index}/${message}: please verify model assumptions and uncertainty intervals.`, index: message, timestamp: '2026-11-01T10:00:00.000Z' })
    }
  }
  for (let index = 0; index < settings.proposals; index++) {
    const id = `dm-proposal-${index}`
    const accepted = index % 2 === 0
    document.getMap('draftmatter:proposals').set(id, { id, anchorId: `dm-anchor-${index}`, authorId: 'user0', kind: 'replace', status: accepted ? 'accepted' : 'open', proposal: 'Assimilation declined during drought.', baseRevision: 'historical-revision' })
    if (accepted) {
      const decisionId = `dm-decision-${index}`
      document.getMap('draftmatter:decisions').set(decisionId, { id: decisionId, changeId: id, authorId: 'user1', action: 'accepted', baseRevision: 'historical-revision', timestamp: '2026-11-01T10:01:00.000Z' })
    }
  }
  const svgPrefix = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><path d="M0 480L640 0" stroke="green"/><!--'
  const svgSuffix = '--></svg>'
  const images = Array.from({ length: settings.images }, (_, index) => sharedImage(`figures/canopy-${index}.svg`, new TextEncoder().encode(svgPrefix + `figure ${index} `.padEnd(settings.imageBytes - svgPrefix.length - svgSuffix.length, 'x') + svgSuffix)))
  const citations = Array.from({ length: settings.citations }, (_, index) => ({ citekey: `vezy${2026 + index}`, type: 'article-journal', title: `Canopy processes and model evaluation ${index}`, authors: ['Ada Author', 'Benoit Botanist'], year: String(2026 + index), source: 'csl-json' as const }))
  publishProjectResources(document, { images, citations })
  materialize(document)
  return document
}

function materialize(document: Y.Doc) {
  for (const name of rootNames) {
    if (name === 'draftmatter:document') document.getText(name)
    else if (name === 'draftmatter:prosemirror') document.getXmlFragment(name)
    else document.getMap(name)
  }
}

function clone(document: Y.Doc, clientId: number) {
  const result = new Y.Doc()
  result.clientID = clientId
  materialize(result)
  Y.applyUpdate(result, Y.encodeStateAsUpdate(document))
  return result
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]))
  return value
}

function fingerprint(document: Y.Doc) {
  materialize(document)
  return createHash('sha256').update(JSON.stringify(canonical(document.toJSON()))).digest('hex')
}

function mutate(document: Y.Doc, client: number, step: number) {
  const id = `bench-${client}-${step}`
  if (roles[client] === 'editor') document.getText('draftmatter:document').insert(document.getText('draftmatter:document').length, `\n<!-- ${id} -->`)
  else document.getMap('draftmatter:thread-messages').set(id, { id, threadId: 'dm-thread-0', authorId: `user${client}`, content: `Please verify this result (${id}).`, index: settings.messagesPerThread + step })
  return id
}

function metricsStart() {
  global.gc?.()
  const initialMemory = process.memoryUsage()
  const initialCPU = process.cpuUsage()
  const initialResources = process.resourceUsage()
  const start = performance.now()
  let peakRSS = initialMemory.rss
  let peakHeap = initialMemory.heapUsed
  const sample = () => {
    const memory = process.memoryUsage()
    peakRSS = Math.max(peakRSS, memory.rss)
    peakHeap = Math.max(peakHeap, memory.heapUsed)
  }
  const interval = setInterval(sample, 10)
  const eventLoop = monitorEventLoopDelay({ resolution: 10 })
  eventLoop.enable()
  const stop = () => {
    clearInterval(interval)
    sample()
    const elapsedMs = performance.now() - start
    const cpu = process.cpuUsage(initialCPU)
    const resources = process.resourceUsage()
    const finalMemory = process.memoryUsage()
    eventLoop.disable()
    return { elapsedMs, cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000, cpuTotalMs: (cpu.user + cpu.system) / 1000, cpuOneCorePercent: ((cpu.user + cpu.system) / 1000) / elapsedMs * 100, initialRSSBytes: initialMemory.rss, peakRSSBytes: peakRSS, finalRSSBytes: finalMemory.rss, initialHeapBytes: initialMemory.heapUsed, peakHeapBytes: peakHeap, finalHeapBytes: finalMemory.heapUsed, lifetimeMaxRSSKiB: resources.maxRSS, voluntaryContextSwitches: resources.voluntaryContextSwitches - initialResources.voluntaryContextSwitches, involuntaryContextSwitches: resources.involuntaryContextSwitches - initialResources.involuntaryContextSwitches, eventLoopP95Ms: eventLoop.percentile(95) / 1e6, eventLoopMaxMs: eventLoop.max / 1e6 }
  }
  return Object.assign(stop, { sample })
}

async function micro() {
  const document = fixture()
  const bytes = Y.encodeStateAsUpdate(document).byteLength
  const clients = Array.from({ length: clientsCount }, (_, index) => clone(document, index + 100))
  const validator = mode === 'incremental' ? new transport.CollaborationUpdateValidator() : undefined
  const origin = { id: 'benchmark-connection' }
  const latency: number[] = []
  let stopMetrics: ReturnType<typeof metricsStart> | undefined
  for (let step = 0; step < samples + 20; step++) {
    const client = step % clientsCount
    let update!: Uint8Array
    const listener = (value: Uint8Array) => { update = value }
    clients[client].on('update', listener)
    mutate(clients[client], client, step)
    clients[client].off('update', listener)
    if (step === 20) stopMetrics = metricsStart()
    const start = performance.now()
    const diagnostic = validator
      ? validator.validate(document, update, roles[client], `user${client}`, origin)
      : roles[client] === 'editor'
        ? transport.editorUpdateDiagnostic(document, update, `user${client}`)
        : transport.commenterUpdateDiagnostic(document, update, `user${client}`)
    const elapsed = performance.now() - start
    assert.equal(diagnostic, null)
    if (step >= 20) latency.push(elapsed)
    Y.applyUpdate(document, update, { source: 'connection', connection: origin })
    validator?.release(document)
    for (let index = 0; index < clientsCount; index++) if (index !== client) Y.applyUpdate(clients[index], update)
    stopMetrics?.sample()
  }
  const resources = stopMetrics!()
  const expectedFingerprint = fingerprint(document)
  for (const client of clients) assert.equal(fingerprint(client), expectedFingerprint)
  validator?.release(document)
  const result = { fixture: { ...settings, encodedBytes: bytes, historicalMessages: settings.threads * settings.messagesPerThread }, validationLatency: quantiles(latency), resources, converged: true }
  document.destroy()
  for (const client of clients) client.destroy()
  return result
}

async function serverProcess() {
  const temporary = await mkdtemp(join(tmpdir(), 'draftmatter-benchmark-store-'))
  const seed = fixture()
  const authorization = new AuthenticatedWorkspaceService({ secret: Uint8Array.from({ length: 32 }, (_, index) => 100 + index) })
  const tokens = []
  for (let index = 0; index < clientsCount; index++) tokens.push(await authorization.createSessionForVerifiedIdentity({ userId: `user${index}`, sessionId: `session-${index}` }))
  await authorization.createWorkspace(tokens[0], { id: scope.workspaceId, name: 'Benchmark' })
  await authorization.createProject(tokens[0], scope.workspaceId, { id: scope.projectId, name: 'Benchmark paper' })
  for (let index = 1; index < clientsCount; index++) await authorization.acceptInvitation(tokens[index], (await authorization.createInvitation(tokens[0], scope.workspaceId, { role: roles[index] })).token)
  let id = 0
  const persistence = new FileCollaborationStore({ root: temporary, idFactory: () => `record-${++id}` })
  await persistence.createSnapshot(scope, 'seed', Y.encodeStateAsUpdate(seed))
  const server = transport.createDraftMatterHocuspocusServer({ authorization, persistence, validationMode: mode as 'reference' | 'incremental', port: 0, debounceMs: 60_000, maxDebounceMs: 60_000, snapshotIdFactory: () => `snapshot-${++id}` })
  await server.listen()
  let stopMetrics: ReturnType<typeof metricsStart> | undefined
  process.on('message', async (message: { type: string; requestId: number }) => {
    try {
      if (message.type === 'measure-start') {
        stopMetrics = metricsStart()
        process.send?.({ requestId: message.requestId, value: true })
      } else if (message.type === 'measure-stop') process.send?.({ requestId: message.requestId, value: stopMetrics!() })
      else if (message.type === 'shutdown') {
        const authoritative = server.hocuspocus.documents.get(documentName)
        assert(authoritative)
        const expected = fingerprint(authoritative)
        await server.destroy()
        const stored = await persistence.load(scope)
        const reloaded = new Y.Doc()
        materialize(reloaded)
        if (stored.snapshot) Y.applyUpdate(reloaded, stored.snapshot)
        for (const update of stored.updates) Y.applyUpdate(reloaded, update)
        assert.equal(fingerprint(reloaded), expected)
        assert.equal(reloaded.getMap('draftmatter:thread-messages').size, settings.threads * settings.messagesPerThread + 2 * (rounds + warmupRounds))
        const result = { persistedReloadMatches: true, fingerprint: expected, encodedFinalBytes: Y.encodeStateAsUpdate(reloaded).byteLength }
        reloaded.destroy()
        seed.destroy()
        await rm(temporary, { recursive: true, force: true })
        process.send?.({ requestId: message.requestId, value: result }, () => process.disconnect?.())
      }
    } catch (error) {
      console.error(error)
      process.exit(1)
    }
  })
  process.send?.({ type: 'ready', url: server.webSocketURL, tokens, fixture: { ...settings, encodedBytes: Y.encodeStateAsUpdate(seed).byteLength, historicalMessages: settings.threads * settings.messagesPerThread } })
}

async function transportProcess() {
  const server = fork(fileURLToPath(import.meta.url), ['server', mode, fixtureName, sampleArgument, roundArgument], { execArgv: ['--expose-gc'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
  let requestId = 0
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  const ready = new Promise<any>((resolve, reject) => {
    server.on('message', (message: any) => {
      if (message.type === 'ready') resolve(message)
      else if (message.requestId) { pending.get(message.requestId)?.resolve(message.value); pending.delete(message.requestId) }
    })
    server.on('error', reject)
    server.on('exit', (code) => {
      if (code) {
        const error = new Error(`Server exited with ${code}`)
        reject(error)
        for (const value of pending.values()) value.reject(error)
      }
    })
  })
  const request = (type: string) => new Promise<any>((resolve, reject) => { const id = ++requestId; pending.set(id, { resolve, reject }); server.send({ type, requestId: id }) })
  const clients: Y.Doc[] = []
  const providers: HocuspocusProvider[] = []
  try {
    const configuration = await ready
    const syncStart = performance.now()
    await Promise.all(Array.from({ length: clientsCount }, async (_, index) => {
      const document = new Y.Doc()
      document.clientID = index + 100
      materialize(document)
      clients[index] = document
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Client ${index} did not sync.`)), 60_000)
        providers[index] = new HocuspocusProvider({ url: configuration.url, name: documentName, token: collaborationSocketCredential(configuration.tokens[index]), document, WebSocketPolyfill: WebSocket, onSynced: ({ state }) => { if (state) { clearTimeout(timeout); resolve() } }, onAuthenticationFailed: ({ reason }) => { clearTimeout(timeout); reject(new Error(reason)) } } as ConstructorParameters<typeof HocuspocusProvider>[0])
      })
      providers[index].awareness?.setLocalState({ draftmatter: { userId: `user${index}`, name: `Researcher ${index}`, color: '#617f73' }, user: { id: `user${index}`, name: `Researcher ${index}`, color: '#617f73' } })
    }))
    const coldSyncMs = performance.now() - syncStart
    const latencies: number[] = []
    const deliveries = new Map<string, { start: number; seen: Set<number>; measured: boolean; resolve: () => void }>()
    const acknowledge = (documentIndex: number, id: string) => {
      const delivery = deliveries.get(id)
      if (!delivery) return
      delivery.seen.add(documentIndex)
      if (delivery.seen.size !== clientsCount) return
      if (delivery.measured) latencies.push(performance.now() - delivery.start)
      deliveries.delete(id)
      delivery.resolve()
    }
    // Track only inserted marker deltas/changed message keys. Repeatedly scanning
    // ten complete manuscript strings would distort the propagation measurement.
    for (const [index, document] of clients.entries()) {
      document.getText('draftmatter:document').observe((event) => {
        for (const change of event.delta) if (typeof change.insert === 'string') {
          for (const match of change.insert.matchAll(/bench-\d+-\d+/g)) acknowledge(index, match[0])
        }
      })
      document.getMap('draftmatter:thread-messages').observe((event) => {
        for (const key of event.keysChanged) if (key.startsWith('bench-')) acknowledge(index, key)
      })
    }
    let measuredStart = 0
    let stopClientMetrics: ReturnType<typeof metricsStart> | undefined
    for (let round = 0; round < rounds + warmupRounds; round++) {
      if (round === warmupRounds) { stopClientMetrics = metricsStart(); await request('measure-start'); measuredStart = performance.now() }
      const observations = Array.from({ length: clientsCount }, (_, client) => {
        const id = `bench-${client}-${round}`
        return new Promise<void>((resolve) => {
          deliveries.set(id, { start: performance.now(), seen: new Set(), measured: round >= warmupRounds, resolve })
        })
      })
      // All ten writers mutate before yielding: the server receives a concurrent burst.
      for (let client = 0; client < clientsCount; client++) mutate(clients[client], client, round)
      await Promise.race([Promise.all(observations), new Promise((_, reject) => { const timeout = setTimeout(() => reject(new Error('Burst did not converge.')), 60_000); timeout.unref() })])
      if (round < rounds + warmupRounds - 1) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const elapsedMs = performance.now() - measuredStart
    const resources = await request('measure-stop')
    const clientResources = stopClientMetrics!()
    const expected = fingerprint(clients[0])
    for (const client of clients) assert.equal(fingerprint(client), expected)
    // Keep the room alive until persisted-state verification, then stop reconnects.
    const persisted = await request('shutdown')
    for (const provider of providers) provider.destroy()
    assert.equal(persisted.fingerprint, expected)
    return { fixture: configuration.fixture, clients: clientsCount, roleMix: { owners: 1, editors: 7, commenters: 2 }, warmupUpdates: warmupRounds * clientsCount, measuredUpdates: rounds * clientsCount, burstThinkTimeMs: 100, coldSyncMs, elapsedMs, acceptedUpdatesPerSecond: rounds * clientsCount / elapsedMs * 1000, allPeersPropagationLatency: quantiles(latencies), serverResources: resources, clientResources, converged: true, ...persisted, persistence: `FileCollaborationStore on local temporary directory; append awaited before integration; Hocuspocus snapshots debounced beyond measured window; default FileStore compaction threshold is 128 appends; ${clientsCount * (rounds + warmupRounds)} workload writes ${clientsCount * (rounds + warmupRounds) >= 128 ? 'cross' : 'do not cross'} that threshold (initial sync appends are additional)` }
  } finally {
    for (const provider of providers) provider?.destroy()
    for (const document of clients) document?.destroy()
    if (server.connected) server.kill()
  }
}

if (!['reference', 'incremental'].includes(mode) || !['article', 'rich'].includes(fixtureName)) throw new Error('Invalid benchmark mode or fixture.')
try {
  if (scenario === 'server') await serverProcess()
  else console.log(JSON.stringify(scenario === 'micro' ? await micro() : await transportProcess()))
} catch (error) {
  console.error(error)
  process.exit(1)
}
