import { parseExecutionManifest, type ExecutionCellFreshness } from './executionFreshness'
import { extractExecutableCells, isSetupCell, type ExecutionLanguage } from './executionCells'
import { sha256 } from './kernelExecution'
import { normalizeProjectRelativePath } from './projectPaths'
import { parseRetainedPublishedValues, publishedValueNamesInMarkup } from './publishedValues'
import { parseRetainedOutputs } from './retainedOutputs'

export function publicationFreshnessProblem(source: string, cellStates: ExecutionCellFreshness[]) {
  const retained = parseRetainedPublishedValues(source)
  const names = publishedValueNamesInMarkup(source)
  const missing = names.filter((name) => !retained.values[name])
  if (missing.length) return `Run the values cell${missing.length === 1 ? '' : 's'} that publish ${missing.map((name) => `{{${name}}}`).join(', ')}.`
  const states = new Map(cellStates.map((state) => [state.cellId, state]))
  const stale = names.filter((name) => {
    const record = retained.values[name]
    return record && states.get(record.provenance.cellId)?.status !== 'current'
  })
  if (stale.length) return `Refresh the computed result${stale.length === 1 ? '' : 's'} for ${stale.map((name) => `{{${name}}}`).join(', ')} before publication.`
  const outputs = parseRetainedOutputs(source)
  if (outputs.diagnostics.some((diagnostic) => diagnostic.level === 'error')) return 'Repair the retained computation outputs before publication.'
  const staleOutputs = outputs.outputs.filter((output) => output.markdown.replace(/<!--[\s\S]*?-->/g, '').trim() && states.get(output.cellId)?.status !== 'current')
  if (staleOutputs.length) return 'Refresh the computed figures and tables before publication, or explicitly allow retained results.'
  return undefined
}

/**
 * Certifies the exact publication snapshot, independently of debounced UI state.
 * A status computed for older source bytes is not evidence for a newer export.
 */
export async function publicationFreshnessSnapshotProblem(source: string, cellStates: ExecutionCellFreshness[]): Promise<string | undefined> {
  const snapshot = structuredClone(cellStates)
  const problem = publicationFreshnessProblem(source, snapshot)
  if (problem) return problem
  const values = parseRetainedPublishedValues(source)
  const names = publishedValueNamesInMarkup(source)
  const outputs = parseRetainedOutputs(source).outputs.filter((output) => output.markdown.replace(/<!--[\s\S]*?-->/g, '').trim())
  const extracted = extractExecutableCells(source)
  if (extracted.cells.some((cell) => (cell.role === 'figure' || cell.role === 'table') && !outputs.some((output) => output.cellId === cell.id))) {
    return 'Run the cells that produce computed figures and tables before publication; their retained outputs are missing.'
  }
  const publishedCellIds = new Set([...names.map((name) => values.values[name].provenance.cellId), ...outputs.map((output) => output.cellId)])
  if (publishedCellIds.size === 0) return undefined

  if (extracted.diagnostics.some((diagnostic) => diagnostic.level === 'error')) return 'Repair the executable cell definitions before publishing computed results.'
  const byId = new Map(extracted.cells.map((cell) => [cell.id, cell]))
  const states = new Map(snapshot.map((state) => [state.cellId, state]))
  const manifests = new Map(snapshot.flatMap((state) => {
    if (!state.lastSuccessful) return []
    const parsed = parseExecutionManifest(JSON.stringify(state.lastSuccessful))
    const manifest = parsed.manifest
    return manifest?.status === 'succeeded' && manifest.cellId === state.cellId && manifest.language === state.language ? [[state.cellId, manifest] as const] : []
  }))
  for (const id of publishedCellIds) {
    const cell = byId.get(id)
    if (!cell || !manifests.has(id) || states.get(id)?.language !== cell.language) {
      return 'Run the cells that produce these computed results before publication; their executable source or execution manifests are missing or invalid.'
    }
  }
  const codeHashes = new Map(await Promise.all(extracted.cells.map(async (cell) => [cell.id, await sha256(cell.source)] as const)))
  const staleFrom = new Map<ExecutionLanguage, number>()
  const invalidate = (language: ExecutionLanguage, index: number) => staleFrom.set(language, Math.min(staleFrom.get(language) ?? Number.POSITIVE_INFINITY, index))
  for (const language of ['python', 'r', 'julia'] as const) {
    const cells = extracted.cells.filter((cell) => cell.language === language)
    const previous = snapshot.filter((state) => state.language === language)
    // A removed cell could have been a setup cell. The previous UI states do not
    // retain roles, so its language cannot be certified until it is reconciled/run.
    if (previous.some((state) => !cells.some((cell) => cell.id === state.cellId))) invalidate(language, 0)
    const length = Math.max(cells.length, previous.length)
    for (let index = 0; index < length; index += 1) {
      const cell = cells[index]
      if (cell?.id !== previous[index]?.cellId) {
        invalidate(language, cell && isSetupCell(cell) ? 0 : index)
        break
      }
    }
    for (const [index, cell] of cells.entries()) {
      const state = states.get(cell.id)
      const manifest = manifests.get(cell.id)
      if (state?.status !== 'current' || !manifest || manifest.language !== language || manifest.codeHash !== codeHashes.get(cell.id)) {
        invalidate(language, isSetupCell(cell) || state?.status === 'environment-changed' ? 0 : index)
      }
    }
    for (const [index, cell] of cells.entries()) {
      if (publishedCellIds.has(cell.id) && index >= (staleFrom.get(language) ?? Number.POSITIVE_INFINITY)) {
        return 'Refresh the computed results before publication: the manuscript code or its same-language dependencies changed or could not be verified.'
      }
    }
    // Setup runs first even when its source block is written after a figure.
    // A rerun of an upstream cell invalidates a downstream result independently
    // of code hashes; the two must refer to the same kernel and environment.
    const executionOrder = [...cells.filter(isSetupCell), ...cells.filter((cell) => !isSetupCell(cell))]
    for (const [index, cell] of executionOrder.entries()) {
      if (!publishedCellIds.has(cell.id)) continue
      const result = manifests.get(cell.id)!
      if (executionOrder.slice(0, index).some((dependency) => {
        const executed = manifests.get(dependency.id)
        return !executed || executed.environmentFingerprint !== result.environmentFingerprint
          || executed.sessionGeneration !== result.sessionGeneration || executed.executionSequence >= result.executionSequence
      })) {
        return 'Refresh the computed results before publication: their dependencies were rerun or belong to a different kernel session or environment.'
      }
    }
  }
  for (const name of names) {
    const provenance = values.values[name].provenance
    const manifest = manifests.get(provenance.cellId)!
    if (provenance.language !== manifest.language || provenance.codeHash !== manifest.codeHash
      || provenance.runHash !== manifest.resultHash || provenance.environmentFingerprint !== manifest.environmentFingerprint
      || provenance.sessionGeneration !== manifest.sessionGeneration || provenance.executionSequence !== manifest.executionSequence) {
      return 'Refresh the computed values before publication: their retained provenance does not match the last successful run.'
    }
  }
  if (outputs.some((output) => output.runHash !== manifests.get(output.cellId)!.resultHash)) {
    return 'Refresh the computed figures and tables before publication: their retained provenance does not match the last successful run.'
  }
  return undefined
}


/** Checks the exact bytes about to be exported, without relying on the file polling interval. */
export async function publicationAssetFreshnessProblem(
  assets: Array<{ path: string; bytes: Uint8Array }>,
  cellStates: ExecutionCellFreshness[],
): Promise<string | undefined> {
  const snapshot = structuredClone(cellStates)
  const published = assets.map((asset) => ({ path: asset.path, bytes: Uint8Array.from(asset.bytes) }))
  for (const asset of published) {
    const path = normalizeProjectRelativePath(asset.path)
    if (!path) return 'Repair the publication asset paths before exporting computed figures.'
    const evidence = snapshot.flatMap((state) => (state.lastSuccessful?.artifacts ?? [])
      .filter((artifact) => normalizeProjectRelativePath(artifact.path) === path).map((artifact) => ({ state, artifact })))
    if (evidence.length === 0) continue // Manual figures have no execution provenance.
    if (evidence.some(({ state }) => {
      const manifest = parseExecutionManifest(JSON.stringify(state.lastSuccessful)).manifest
      return state.status !== 'current' || !manifest || manifest.status !== 'succeeded'
        || manifest.cellId !== state.cellId || manifest.language !== state.language
    })) return 'Refresh the computed figures before publication; their execution evidence is missing, stale, or invalid.'
    const digest = await crypto.subtle.digest('SHA-256', asset.bytes)
    const hash = `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
    if (evidence.some(({ artifact }) => artifact.bytes !== asset.bytes.byteLength || artifact.hash !== hash)) {
      return 'Refresh the computed figures before publication; a generated asset changed on disk after its last successful run.'
    }
  }
  return undefined
}
