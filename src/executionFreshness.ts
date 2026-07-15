import type { ExecutableCell, ExecutionLanguage } from './executionCells'
import { sha256, type ExecutionProviderKind, type NormalizedExecutionResult } from './executionProvider'

export type ExecutionFreshnessStatus =
  | 'never-run'
  | 'queued'
  | 'running'
  | 'current'
  | 'stale'
  | 'failed'
  | 'interrupted'
  | 'environment-changed'
  | 'output-missing'

export interface ExecutionManifest {
  schemaVersion: 1
  cellId: string
  language: ExecutionLanguage
  status: NormalizedExecutionResult['status']
  codeHash: string
  inputsHash: string
  environmentFingerprint: string
  environmentIdentity?: string
  environmentVersion?: string
  resultHash: string
  artifacts: Array<{ path: string; bytes: number; hash: string; mediaType?: string }>
  provider: ExecutionProviderKind
  providerRunId?: string
  executionCount?: number
  startedAt: string
  finishedAt: string
  durationMs: number
  sequence: number
  cleanRunId?: string
}

export interface ExecutionCellFreshness {
  cellId: string
  language: ExecutionLanguage
  status: ExecutionFreshnessStatus
  reason?: string
  lastAttempt?: ExecutionManifest
  lastSuccessful?: ExecutionManifest
}

export interface CleanRunCertification {
  cleanRunId: string
  completedAt: string
  resultHashes: string[]
  environmentFingerprints: Partial<Record<ExecutionLanguage, string>>
}

export function executionManifestFromResult(result: NormalizedExecutionResult, sequence: number, cleanRunId?: string): ExecutionManifest {
  return {
    schemaVersion: 1,
    cellId: result.cellId,
    language: result.language,
    status: result.status,
    codeHash: result.hashes.code,
    inputsHash: result.hashes.inputs,
    environmentFingerprint: result.hashes.environment,
    environmentIdentity: result.environment.identity,
    ...(result.environment.version ? { environmentVersion: result.environment.version } : {}),
    resultHash: result.hashes.result,
    artifacts: result.artifacts.map((artifact) => ({ ...artifact })),
    provider: result.provenance.provider,
    ...(result.provenance.providerRunId ? { providerRunId: result.provenance.providerRunId } : {}),
    ...(result.provenance.executionCount === undefined ? {} : { executionCount: result.provenance.executionCount }),
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.durationMs,
    sequence,
    ...(cleanRunId ? { cleanRunId } : {}),
  }
}

function initialState(cell: ExecutableCell, manifest?: ExecutionManifest): ExecutionCellFreshness {
  if (!manifest) return { cellId: cell.id, language: cell.language, status: 'never-run' }
  return {
    cellId: cell.id,
    language: cell.language,
    status: manifest.status === 'succeeded' ? 'current' : manifest.status === 'interrupted' ? 'interrupted' : 'failed',
    lastAttempt: manifest,
    ...(manifest.status === 'succeeded' ? { lastSuccessful: manifest } : {}),
  }
}

function validHash(value: unknown) {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
}

export function parseExecutionManifest(source: string): { manifest?: ExecutionManifest; error?: string } {
  try {
    const value = JSON.parse(source) as Partial<ExecutionManifest>
    if (value.schemaVersion !== 1) return { error: 'Execution manifest schemaVersion must be 1.' }
    if (typeof value.cellId !== 'string' || !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(value.cellId)) return { error: 'Execution manifest cellId is invalid.' }
    if (value.language !== 'python' && value.language !== 'r' && value.language !== 'julia') return { error: 'Execution manifest language is invalid.' }
    if (value.status !== 'succeeded' && value.status !== 'failed' && value.status !== 'interrupted') return { error: 'Execution manifest status is invalid.' }
    if (!validHash(value.codeHash) || !validHash(value.inputsHash) || !validHash(value.environmentFingerprint) || !validHash(value.resultHash)) return { error: 'Execution manifest hashes must be SHA-256 fingerprints.' }
    if (!Array.isArray(value.artifacts) || value.artifacts.some((artifact) => !artifact || typeof artifact.path !== 'string' || typeof artifact.bytes !== 'number' || !validHash(artifact.hash))) return { error: 'Execution manifest artifacts are invalid.' }
    const sequence = value.sequence
    if ((value.provider !== 'kernel' && value.provider !== 'direct') || typeof value.startedAt !== 'string' || typeof value.finishedAt !== 'string' || typeof value.durationMs !== 'number' || typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence < 0) return { error: 'Execution manifest provenance is invalid.' }
    return { manifest: value as ExecutionManifest }
  } catch (error) {
    return { error: `Execution manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export function serializeExecutionManifest(manifest: ExecutionManifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

export class ExecutionFreshnessTracker {
  private cells: ExecutableCell[]
  private readonly states = new Map<string, ExecutionCellFreshness>()
  private readonly codeHashes = new Map<string, string>()
  private certification?: CleanRunCertification

  private constructor(cells: ExecutableCell[], manifests: ExecutionManifest[]) {
    this.cells = [...cells]
    const byCell = new Map(manifests.map((manifest) => [manifest.cellId, manifest]))
    for (const cell of cells) this.states.set(cell.id, initialState(cell, byCell.get(cell.id)))
  }

  static async create(cells: ExecutableCell[], manifests: ExecutionManifest[] = []) {
    const tracker = new ExecutionFreshnessTracker(cells, manifests)
    await tracker.initializeCodeHashes()
    return tracker
  }

  private async initializeCodeHashes() {
    await Promise.all(this.cells.map(async (cell) => {
      const hash = await sha256(cell.source)
      this.codeHashes.set(cell.id, hash)
      const state = this.states.get(cell.id)!
      if (state.lastSuccessful && state.lastSuccessful.codeHash !== hash) {
        state.status = 'stale'
        state.reason = 'Code changed since the last successful run.'
      }
    }))
  }

  snapshot() {
    return this.cells.map((cell) => structuredClone(this.states.get(cell.id)!))
  }

  cleanRunCertification() {
    return this.certification ? structuredClone(this.certification) : undefined
  }

  private invalidateSuffix(language: ExecutionLanguage, start: number, reason: string, status: ExecutionFreshnessStatus = 'stale') {
    this.certification = undefined
    for (let index = start; index < this.cells.length; index += 1) {
      const cell = this.cells[index]
      if (cell.language !== language) continue
      const state = this.states.get(cell.id)!
      if (state.status === 'never-run') continue
      state.status = status
      state.reason = reason
    }
  }

  async reconcileCells(nextCells: ExecutableCell[]) {
    const nextHashes = new Map<string, string>()
    await Promise.all(nextCells.map(async (cell) => nextHashes.set(cell.id, await sha256(cell.source))))
    const previousByLanguage = (language: ExecutionLanguage) => this.cells.filter((cell) => cell.language === language)
    const nextByLanguage = (language: ExecutionLanguage) => nextCells.filter((cell) => cell.language === language)
    const firstChanges = new Map<ExecutionLanguage, number>()
    for (const language of ['python', 'r', 'julia'] as const) {
      const previous = previousByLanguage(language)
      const next = nextByLanguage(language)
      const length = Math.max(previous.length, next.length)
      for (let index = 0; index < length; index += 1) {
        const before = previous[index]
        const after = next[index]
        if (!before || !after || before.id !== after.id || this.codeHashes.get(before.id) !== nextHashes.get(after.id)) {
          const changed = after ? nextCells.findIndex((cell) => cell.id === after.id) : nextCells.length
          firstChanges.set(language, changed)
          break
        }
      }
    }
    const previousStates = new Map(this.states)
    this.cells = [...nextCells]
    this.states.clear()
    this.codeHashes.clear()
    for (const cell of nextCells) {
      this.codeHashes.set(cell.id, nextHashes.get(cell.id)!)
      this.states.set(cell.id, previousStates.get(cell.id) ?? initialState(cell))
    }
    for (const [language, start] of firstChanges) {
      this.invalidateSuffix(language, start, 'This cell or an earlier cell in the same language changed.')
    }
  }

  markQueued(cellId: string) {
    const state = this.states.get(cellId)
    if (!state) throw new Error(`Executable cell ${cellId} was not found.`)
    state.status = 'queued'
    state.reason = undefined
    this.certification = undefined
  }

  markRunning(cellId: string) {
    const state = this.states.get(cellId)
    if (!state) throw new Error(`Executable cell ${cellId} was not found.`)
    state.status = 'running'
    state.reason = undefined
    this.certification = undefined
  }

  recordResult(result: NormalizedExecutionResult, sequence: number, cleanRunId?: string) {
    const state = this.states.get(result.cellId)
    if (!state || state.language !== result.language) throw new Error(`Execution result does not match cell ${result.cellId}.`)
    const manifest = executionManifestFromResult(result, sequence, cleanRunId)
    this.certification = undefined
    state.lastAttempt = manifest
    state.reason = undefined
    if (result.status === 'succeeded') {
      state.lastSuccessful = manifest
      state.status = 'current'
      this.codeHashes.set(result.cellId, result.hashes.code)
    } else {
      state.status = result.status === 'interrupted' ? 'interrupted' : 'failed'
      state.reason = result.status === 'interrupted' ? 'The latest run was interrupted.' : 'The latest run failed; the last successful output is retained.'
    }
    return manifest
  }

  environmentChanged(language: ExecutionLanguage, fingerprint: string) {
    this.certification = undefined
    for (const cell of this.cells.filter((candidate) => candidate.language === language)) {
      const state = this.states.get(cell.id)!
      if (state.lastSuccessful && state.lastSuccessful.environmentFingerprint !== fingerprint) {
        state.status = 'environment-changed'
        state.reason = 'The selected execution environment changed.'
      }
    }
  }

  inputsChanged(cellId: string, inputsHash: string) {
    const index = this.cells.findIndex((cell) => cell.id === cellId)
    if (index < 0) throw new Error(`Executable cell ${cellId} was not found.`)
    const state = this.states.get(cellId)!
    if (state.lastSuccessful && state.lastSuccessful.inputsHash !== inputsHash) {
      this.invalidateSuffix(state.language, index, 'A declared input changed since the last successful run.')
    }
  }

  verifyArtifacts(available: ReadonlyMap<string, string>) {
    for (const cell of this.cells) {
      const state = this.states.get(cell.id)!
      const artifacts = state.lastSuccessful?.artifacts ?? []
      if (artifacts.length === 0) continue
      if (artifacts.some((artifact) => !available.has(artifact.path))) {
        state.status = 'output-missing'
        state.reason = 'One or more generated artifacts are missing.'
        this.certification = undefined
      } else if (artifacts.some((artifact) => available.get(artifact.path) !== artifact.hash)) {
        state.status = 'stale'
        state.reason = 'A generated artifact changed outside DraftMatter.'
        this.certification = undefined
      }
    }
  }

  certifyCleanRun(cleanRunId: string): CleanRunCertification | undefined {
    const states = this.cells.map((cell) => this.states.get(cell.id)!)
    const complete = states.length > 0 && states.every((state, index) =>
      state.status === 'current'
      && state.lastAttempt?.status === 'succeeded'
      && state.lastAttempt.cleanRunId === cleanRunId
      && state.lastAttempt.sequence === index,
    )
    if (!complete) {
      this.certification = undefined
      return undefined
    }
    const environmentFingerprints: Partial<Record<ExecutionLanguage, string>> = {}
    for (const state of states) environmentFingerprints[state.language] = state.lastAttempt!.environmentFingerprint
    this.certification = {
      cleanRunId,
      completedAt: states.at(-1)!.lastAttempt!.finishedAt,
      resultHashes: states.map((state) => state.lastAttempt!.resultHash),
      environmentFingerprints,
    }
    return structuredClone(this.certification)
  }
}
