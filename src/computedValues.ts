import type { JsonValue, NormalizedExecutionResult } from './executionProvider'

export const COMPUTED_VALUE_MIME = 'application/vnd.draftmatter.values+json'
export const COMPUTED_VALUE_PROTOCOL = 'DRAFTMATTER_VALUE'

export interface RetainedComputedValue {
  key: string
  value: string
  cellId: string
  runHash?: string
}

export interface ParsedComputedValues {
  values: Record<string, RetainedComputedValue>
  diagnostics: Array<{ code: string; level: 'warning'; message: string }>
}

const keySource = '[A-Za-z][A-Za-z0-9_.:-]{0,127}'
const keyPattern = new RegExp(`^${keySource}$`)
const markupPattern = new RegExp(`\\{\\{dm:value:(${keySource})\\}\\}`, 'g')
const protocolPattern = new RegExp(`^${COMPUTED_VALUE_PROTOCOL}\\s+(${keySource})=(.*)$`)

export function isComputedValueKey(value: string) {
  return keyPattern.test(value)
}

function scalarValue(value: JsonValue): string | undefined {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

function safeDisplayValue(value: string) {
  return value.replaceAll('\r', ' ').replaceAll('\n', ' ').trim().slice(0, 2_000)
}

export function computedValuesFromExecution(result: NormalizedExecutionResult) {
  const values: Record<string, string> = {}
  for (const bundle of result.mime) {
    const payload = bundle.data[COMPUTED_VALUE_MIME]
    if (!payload || Array.isArray(payload) || typeof payload !== 'object') continue
    for (const [key, raw] of Object.entries(payload)) {
      const value = scalarValue(raw)
      if (isComputedValueKey(key) && value !== undefined) values[key] = safeDisplayValue(value)
    }
  }
  for (const stream of result.streams.filter((candidate) => candidate.name === 'stdout').sort((left, right) => left.sequence - right.sequence)) {
    for (const line of stream.text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')) {
      const match = line.match(protocolPattern)
      if (match) values[match[1]] = safeDisplayValue(match[2])
    }
  }
  return values
}

export function stripComputedValueProtocol(value: string) {
  const ending = value.endsWith('\n') ? '\n' : ''
  const lines = value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')
  if (ending) lines.pop()
  return `${lines.filter((line) => !protocolPattern.test(line)).join('\n')}${ending}`
}

export function retainedComputedValueDirectives(values: Record<string, string>) {
  return Object.entries(values)
    .filter(([key]) => isComputedValueKey(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `<!-- dm-value key="${key}" value="${encodeURIComponent(safeDisplayValue(value))}" -->`)
}

export function parseRetainedComputedValues(source: string): ParsedComputedValues {
  const values: Record<string, RetainedComputedValue> = {}
  const diagnostics: ParsedComputedValues['diagnostics'] = []
  const blockPattern = /<!--\s*dm-output:start\b([^>]*)-->([\s\S]*?)<!--\s*dm-output:end\s*-->/gi
  for (const block of source.matchAll(blockPattern)) {
    const attributes = block[1]
    const body = block[2]
    const cellId = attributes.match(/\bcell="([^"]+)"/)?.[1] ?? ''
    const runHash = attributes.match(/\brun="([^"]+)"/)?.[1]
    if (!cellId) continue
    for (const directive of body.matchAll(/<!--\s*dm-value\s+key="([^"]+)"\s+value="([^"]*)"\s*-->/gi)) {
      const key = directive[1]
      if (!isComputedValueKey(key)) {
        diagnostics.push({ code: `computed-value-key-${key}`, level: 'warning', message: `Computed value “${key}” has an invalid name and was ignored.` })
        continue
      }
      try {
        values[key] = { key, value: decodeURIComponent(directive[2]), cellId, ...(runHash ? { runHash } : {}) }
      } catch {
        diagnostics.push({ code: `computed-value-encoding-${key}`, level: 'warning', message: `Computed value “${key}” could not be decoded and was ignored.` })
      }
    }
  }
  return { values, diagnostics }
}

export function replaceComputedValueMarkup(source: string, values: Record<string, RetainedComputedValue>, missing = 'value unavailable') {
  return source.replace(markupPattern, (_markup, key: string) => values[key]?.value ?? missing)
}

export function computedValueMarkup(key: string) {
  if (!isComputedValueKey(key)) throw new Error('Computed value names must start with a letter and use only letters, numbers, dots, colons, underscores, or hyphens.')
  return `{{dm:value:${key}}}`
}
