import type { ExecutableCell, ExecutionLanguage } from './executionCells'
import type { ExecutionProviderKind } from './executionProvider'
import type { ExecutionCellFreshness, ExecutionFreshnessStatus } from './executionFreshness'
import { parseLosslessPortableSource } from './portableSource'
import { healthyKernelsFor, type RuntimeHealth, type RuntimeInventory } from './runtimeDiscovery'
import type { DocumentDiagnostic } from './types'

export interface RetainedOutputBlock {
  cellId: string
  runHash?: string
  markdown: string
  artifactPaths: string[]
}

export interface RetainedOutputParseResult {
  outputs: RetainedOutputBlock[]
  diagnostics: DocumentDiagnostic[]
}

export interface ExecutionAvailabilityView {
  cellId: string
  language: ExecutionLanguage
  provider: ExecutionProviderKind
  runtimeHealth: RuntimeHealth | 'not-checked'
  executionEnabled: boolean
  outputAvailable: boolean
  freshness: ExecutionFreshnessStatus
  tone: 'quiet' | 'warning'
  message: string
  provenance: string[]
  retained?: RetainedOutputBlock
}

const languageName: Record<ExecutionLanguage, string> = { python: 'Python', r: 'R', julia: 'Julia' }

function artifactPaths(markdown: string) {
  return [...markdown.matchAll(/!?(?:\[[^\]]*\])\((?:<([^>]+)>|([^\s)]+))(?:\s+[^)]*)?\)/g)]
    .map((match) => match[1] ?? match[2])
    .filter((path): path is string => Boolean(path) && !/^[a-z]+:/i.test(path))
}

export function parseRetainedOutputs(source: string): RetainedOutputParseResult {
  const diagnostics: DocumentDiagnostic[] = []
  const outputs: RetainedOutputBlock[] = []
  const seen = new Set<string>()
  for (const node of parseLosslessPortableSource(source).semanticNodes.filter((candidate) => candidate.kind === 'output')) {
    const cellId = typeof node.attributes.cell === 'string' ? node.attributes.cell : undefined
    if (!cellId) continue
    if (!node.raw.includes('<!-- dm-output:end -->')) {
      diagnostics.push({ code: `retained-output-unclosed-${cellId}`, level: 'error', message: `The retained output block for ${cellId} is not closed.` })
      continue
    }
    if (seen.has(cellId)) {
      diagnostics.push({ code: `retained-output-duplicate-${cellId}`, level: 'error', message: `More than one retained output block targets ${cellId}.` })
      continue
    }
    seen.add(cellId)
    const openingEnd = node.raw.indexOf('-->')
    const closingStart = node.raw.lastIndexOf('<!-- dm-output:end -->')
    const markdown = node.raw.slice(openingEnd + 3, closingStart).trim()
    outputs.push({
      cellId,
      runHash: node.raw.match(/<!-- dm-output:start[^>]*\brun="([^"]+)"/)?.[1],
      markdown,
      artifactPaths: artifactPaths(markdown),
    })
  }
  return { outputs, diagnostics }
}

function runtimeHealth(
  inventory: RuntimeInventory | undefined,
  language: ExecutionLanguage,
  provider: ExecutionProviderKind,
) {
  if (!inventory) return 'not-checked' as const
  if (provider === 'direct') return inventory.executables[language].health
  return healthyKernelsFor(inventory, language).length > 0
    ? 'available' as const
    : inventory.jupyter.health === 'unhealthy' ? 'unhealthy' as const : 'missing' as const
}

function generatedDate(value?: string) {
  if (!value) return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return undefined
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date)
}

function shortHash(value?: string) {
  return value?.startsWith('sha256:') ? value.slice(7, 15) : value
}

function unavailableMessage(language: ExecutionLanguage, freshness: ExecutionFreshnessStatus, outputAvailable: boolean, date?: string) {
  const runtime = languageName[language]
  if (!outputAvailable) return `${runtime} unavailable — no generated output is available.`
  const generated = date ? ` generated ${date}` : ''
  if (freshness === 'current') return `${runtime} unavailable — showing current output${generated}.`
  return `${runtime} unavailable — showing retained output${generated}; it may be stale.`
}

export function buildExecutionAvailability(options: {
  cells: ExecutableCell[]
  states: ExecutionCellFreshness[]
  providers: Record<ExecutionLanguage, ExecutionProviderKind> | ((cell: ExecutableCell) => ExecutionProviderKind)
  inventory?: RuntimeInventory
  retainedOutputs?: RetainedOutputBlock[]
  cachedResultCells?: ReadonlySet<string>
}) {
  const stateByCell = new Map(options.states.map((state) => [state.cellId, state]))
  const retainedByCell = new Map((options.retainedOutputs ?? []).map((output) => [output.cellId, output]))
  return options.cells.map<ExecutionAvailabilityView>((cell) => {
    const state = stateByCell.get(cell.id) ?? { cellId: cell.id, language: cell.language, status: 'never-run' as const }
    const provider = typeof options.providers === 'function' ? options.providers(cell) : options.providers[cell.language]
    const health = runtimeHealth(options.inventory, cell.language, provider)
    const retained = retainedByCell.get(cell.id)
    const outputAvailable = state.status !== 'output-missing'
      && (Boolean(retained?.markdown) || Boolean(options.cachedResultCells?.has(cell.id)))
    const date = generatedDate(state.lastSuccessful?.finishedAt)
    const provenance = [
      state.lastSuccessful?.environmentIdentity ?? state.lastSuccessful?.environmentFingerprint,
      date,
      retained?.runHash ? `run ${shortHash(retained.runHash)}` : state.lastSuccessful ? `run ${shortHash(state.lastSuccessful.resultHash)}` : undefined,
      state.lastSuccessful?.artifacts[0]?.hash ? `artifact ${shortHash(state.lastSuccessful.artifacts[0].hash)}` : undefined,
    ].filter((value): value is string => Boolean(value))
    if (health === 'available') {
      return {
        cellId: cell.id,
        language: cell.language,
        provider,
        runtimeHealth: health,
        executionEnabled: true,
        outputAvailable,
        freshness: state.status,
        tone: state.status === 'output-missing' ? 'warning' : 'quiet',
        message: state.status === 'output-missing' ? 'Generated output is missing.' : state.status === 'never-run' ? 'Not run yet.' : `Output ${state.status}.`,
        provenance,
        ...(retained ? { retained } : {}),
      }
    }
    const missing = health === 'not-checked' ? `${languageName[cell.language]} environment not checked — choose an environment before running.` : unavailableMessage(cell.language, state.status, outputAvailable, date)
    return {
      cellId: cell.id,
      language: cell.language,
      provider,
      runtimeHealth: health,
      executionEnabled: false,
      outputAvailable,
      freshness: state.status,
      tone: outputAvailable ? 'quiet' : 'warning',
      message: missing,
      provenance,
      ...(retained ? { retained } : {}),
    }
  })
}
