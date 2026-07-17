import type { ExecutionCellFreshness } from './executionFreshness'
import { parseRetainedPublishedValues, publishedValueNamesInMarkup } from './publishedValues'

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
  return undefined
}
