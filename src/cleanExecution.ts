import { extractExecutableCells, isSetupCell, type ExecutionLanguage } from './executionCells'
import {
  ExecutionFreshnessTracker,
  type CleanRunCertification,
  type ExecutionCellFreshness,
  type ExecutionManifest,
} from './executionFreshness'
import {
  ExecutionLifecycle,
  type ExecutionRequestFactory,
  type ExecutionRunReport,
  type LifecycleCellState,
} from './executionLifecycle'
import type { NormalizedExecutionResult } from './kernelExecution'
import type { TrustedKernelExecution } from './executionTrust'
import { materializeExecutionOutput, type OutputPresentation } from './outputMaterializer'
import { parseRetainedOutputs, type RetainedOutputBlock } from './retainedOutputs'
import type { DocumentDiagnostic } from './types'

export interface CleanExecutionOptions {
  source: string
  root: string
  execution: TrustedKernelExecution
  existingManifests?: ExecutionManifest[]
  cleanRunId?: string
  requestFactory?: ExecutionRequestFactory
  presentation?: Partial<Record<string, OutputPresentation>>
  onLifecycleChange?: (states: LifecycleCellState[]) => void
}

export interface RunAllSummary {
  succeeded: number
  failed: number
  interrupted: number
  skipped: number
  problemCellId?: string
}

export function runAllSummaryText(summary: RunAllSummary) {
  const counts = [`${summary.succeeded} succeeded`, `${summary.failed} failed`]
  if (summary.interrupted) counts.push(`${summary.interrupted} interrupted`)
  counts.push(`${summary.skipped} skipped`)
  return counts.join(' · ')
}

export interface CleanExecutionOutcome {
  summary: RunAllSummary
  ok: boolean
  source: string
  cleanRunId: string
  report: ExecutionRunReport
  results: NormalizedExecutionResult[]
  manifests: ExecutionManifest[]
  states: ExecutionCellFreshness[]
  retainedOutputs: RetainedOutputBlock[]
  certification?: CleanRunCertification
  diagnostics: DocumentDiagnostic[]
  error?: string
}

function newCleanRunId() {
  const random = globalThis.crypto.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `clean-${random}`
}

function errorDiagnostic(code: string, message: string): DocumentDiagnostic {
  return { code, level: 'error', message }
}

function readableError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Runs every executable cell from restarted language sessions and advances the
 * portable source only when the complete run and every output materialization
 * succeed. Existing output blocks and manifests therefore survive partial runs.
 */
export async function cleanExecutePortableDocument(options: CleanExecutionOptions): Promise<CleanExecutionOutcome> {
  const extracted = extractExecutableCells(options.source)
  const cleanRunId = options.cleanRunId ?? newCleanRunId()
  const blockingDiagnostics = extracted.diagnostics.filter((diagnostic) => diagnostic.level === 'error')
  const tracker = await ExecutionFreshnessTracker.create(extracted.cells, options.existingManifests)
  const retainedBefore = parseRetainedOutputs(options.source)

  const base = {
    source: options.source,
    cleanRunId,
    summary: { succeeded: 0, failed: 0, interrupted: 0, skipped: extracted.cells.length },
    results: [] as NormalizedExecutionResult[],
    manifests: [...(options.existingManifests ?? [])],
    states: tracker.snapshot(),
    retainedOutputs: retainedBefore.outputs,
  }

  if (blockingDiagnostics.length > 0) {
    return {
      ...base,
      ok: false,
      report: { requested: [], completed: [], certified: false },
      diagnostics: [...extracted.diagnostics, ...retainedBefore.diagnostics],
      error: blockingDiagnostics[0].message,
    }
  }
  if (extracted.cells.length === 0) {
    const message = 'The document has no executable Python, R, or Julia cells.'
    return {
      ...base,
      ok: false,
      report: { requested: [], completed: [], certified: false },
      diagnostics: [...extracted.diagnostics, ...retainedBefore.diagnostics, errorDiagnostic('clean-run-empty', message)],
      error: message,
    }
  }

  const lifecycle = new ExecutionLifecycle(
    options.root,
    extracted.cells,
    options.execution,
    options.requestFactory,
  )
  const unsubscribe = options.onLifecycleChange ? lifecycle.subscribe(options.onLifecycleChange) : undefined
  let report: ExecutionRunReport
  let executionError: string | undefined
  try {
    report = await lifecycle.cleanRunAll()
  } catch (error) {
    executionError = readableError(error)
    const snapshot = lifecycle.snapshot()
    report = {
      requested: extracted.cells.map((cell) => cell.id),
      completed: snapshot.filter((state) => state.status === 'succeeded').map((state) => state.cellId),
      certified: false,
    }
  } finally {
    unsubscribe?.()
  }

  const attempts = lifecycle.snapshot()
  const results = attempts.flatMap((state) => state.result ? [state.result] : [])
  const failed = attempts.filter((state) => state.status === 'failed')
  const interrupted = attempts.filter((state) => state.status === 'interrupted')
  const problem = failed[0] ?? interrupted[0]
  const summary: RunAllSummary = {
    succeeded: report.completed.length,
    failed: failed.length,
    interrupted: interrupted.length,
    skipped: attempts.length - report.completed.length - failed.length - interrupted.length,
    ...(problem && { problemCellId: problem.cellId }),
  }
  const attemptManifests = results.map((result) => {
    const sequence = extracted.cells.findIndex((cell) => cell.id === result.cellId)
    return tracker.recordResult(result, sequence, cleanRunId)
  })
  const runSucceeded = report.certified
    && results.length === extracted.cells.length
    && results.every((result) => result.status === 'succeeded')

  if (!runSucceeded) {
    const message = problem?.result?.errors[0]?.message ?? problem?.message ?? executionError
      ?? (problem?.status === 'interrupted' ? 'Execution was interrupted.' : 'The run did not complete.')
    return {
      ...base,
      ok: false,
      report,
      summary,
      results,
      states: tracker.snapshot(),
      diagnostics: [...extracted.diagnostics, ...retainedBefore.diagnostics, errorDiagnostic('clean-run-incomplete', message)],
      error: message,
    }
  }

  let nextSource = options.source
  const materializationDiagnostics: DocumentDiagnostic[] = []
  for (const result of results) {
    const cell = extracted.cells.find((candidate) => candidate.id === result.cellId)
    if (cell && isSetupCell(cell)) continue
    const materialized = materializeExecutionOutput({
      source: nextSource,
      cellId: result.cellId,
      result,
      presentation: options.presentation?.[result.cellId],
    })
    materializationDiagnostics.push(...materialized.diagnostics)
    if (!materialized.ok) {
      return {
        ...base,
        ok: false,
        report: { ...report, certified: false },
        summary: { ...summary, problemCellId: result.cellId },
        results,
        states: tracker.snapshot(),
        diagnostics: [...extracted.diagnostics, ...retainedBefore.diagnostics, ...materializationDiagnostics],
        error: materialized.diagnostics[0]?.message ?? `The result of ${result.cellId} could not be added to the manuscript.`,
      }
    }
    nextSource = materialized.source
  }

  const retainedAfter = parseRetainedOutputs(nextSource)
  const certification = tracker.certifyCleanRun(cleanRunId)
  const publishedCellCount = extracted.cells.filter((cell) => !isSetupCell(cell)).length
  if (!certification || retainedAfter.outputs.length !== publishedCellCount || retainedAfter.diagnostics.some((item) => item.level === 'error')) {
    const message = 'The cells ran, but their retained outputs could not be verified.'
    return {
      ...base,
      ok: false,
      report: { ...report, certified: false },
      summary,
      results,
      states: tracker.snapshot(),
      diagnostics: [
        ...extracted.diagnostics,
        ...retainedBefore.diagnostics,
        ...materializationDiagnostics,
        ...retainedAfter.diagnostics,
        errorDiagnostic('clean-run-uncertified', message),
      ],
      error: message,
    }
  }

  return {
    ok: true,
    summary,
    source: nextSource,
    cleanRunId,
    report,
    results,
    manifests: attemptManifests,
    states: tracker.snapshot(),
    retainedOutputs: retainedAfter.outputs,
    certification,
    diagnostics: [...extracted.diagnostics, ...materializationDiagnostics, ...retainedAfter.diagnostics],
  }
}
