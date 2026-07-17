import type { JsonValue, NormalizedExecutionResult } from './kernelExecution'

export const PUBLISHED_VALUE_MIME = 'application/vnd.draftmatter.published-value+json'

export interface PublishedValueFormatting {
  digits?: number
}

export interface PublishedScalarRecord {
  version: 1
  name: string
  value: string | number | boolean
  unit?: string
  formatting: PublishedValueFormatting
}

export interface PublishedValueProvenance {
  cellId: string
  language: NormalizedExecutionResult['language']
  runHash: string
  codeHash: string
  environmentFingerprint: string
  sessionGeneration: number
  executionSequence: number
  retainedOutputHashes: string[]
}

export interface RetainedPublishedValue extends PublishedScalarRecord {
  rendered: string
  provenance: PublishedValueProvenance
}

export interface PublishedValueDiagnostic {
  code: string
  level: 'error' | 'warning'
  message: string
}

export interface ParsedPublishedValues {
  values: Record<string, RetainedPublishedValue>
  diagnostics: PublishedValueDiagnostic[]
}

export interface PublishedValuesFromExecution {
  records: PublishedScalarRecord[]
  diagnostics: PublishedValueDiagnostic[]
}

const nameSource = '[A-Za-z][A-Za-z0-9_.:-]{0,127}'
const namePattern = new RegExp(`^${nameSource}$`)
const markupPattern = new RegExp(`\\{\\{((?!dm:value:)${nameSource})\\}\\}`, 'g')

export function isPublishedValueName(value: string) {
  return namePattern.test(value) && !value.startsWith('dm:value:')
}

function diagnostic(code: string, message: string): PublishedValueDiagnostic {
  return { code, level: 'error', message }
}

function objectValue(value: JsonValue): Record<string, JsonValue> | undefined {
  return value && !Array.isArray(value) && typeof value === 'object' ? value : undefined
}

function scalarValue(value: JsonValue): PublishedScalarRecord['value'] | undefined {
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return undefined
}

function safeUnit(value: JsonValue) {
  if (typeof value !== 'string') return undefined
  const unit = value.replaceAll('\r', ' ').replaceAll('\n', ' ').trim()
  return unit ? unit.slice(0, 128) : undefined
}

function safeString(value: string) {
  return value.replaceAll('\r', ' ').replaceAll('\n', ' ').trim().slice(0, 2_000)
}

function readPayload(value: JsonValue): JsonValue | undefined {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as JsonValue
  } catch {
    return undefined
  }
}

function normalizeRecord(payload: JsonValue): { record?: PublishedScalarRecord; diagnostic?: PublishedValueDiagnostic } {
  const object = objectValue(payload)
  const name = object?.name
  if (!object || object.version !== 1 || typeof name !== 'string' || !isPublishedValueName(name)) {
    return { diagnostic: diagnostic('published-value-invalid-record', 'A kernel published an invalid DraftMatter value record. Names must start with a letter and use only letters, numbers, dots, colons, underscores, or hyphens.') }
  }
  const value = scalarValue(object.value)
  if (value === undefined) {
    return { diagnostic: diagnostic(`published-value-unsupported-${name}`, `Published value “${name}” is not a supported scalar. Publish a finite number, text, or a boolean.`) }
  }
  const rawFormatting = objectValue(object.formatting ?? null)
  const rawDigits = rawFormatting?.digits ?? object.digits
  const digits = typeof rawDigits === 'number' && Number.isInteger(rawDigits) && rawDigits >= 0 && rawDigits <= 15
    ? rawDigits
    : undefined
  if (rawDigits !== undefined && digits === undefined) {
    return { diagnostic: diagnostic(`published-value-format-${name}`, `Published value “${name}” has invalid digits. Use a whole number from 0 to 15.`) }
  }
  return {
    record: {
      version: 1,
      name,
      value: typeof value === 'string' ? safeString(value) : value,
      ...(safeUnit(object.unit) ? { unit: safeUnit(object.unit) } : {}),
      formatting: { ...(digits === undefined ? {} : { digits }) },
    },
  }
}

export function renderPublishedValue(record: Pick<PublishedScalarRecord, 'value' | 'unit' | 'formatting'>) {
  const value = typeof record.value === 'number' && record.formatting.digits !== undefined
    ? record.value.toFixed(record.formatting.digits)
    : String(record.value)
  return record.unit ? `${value} ${record.unit}` : value
}

/** Reads only the native Jupyter MIME contract emitted by DraftMatter's injected helpers. */
export function publishedValuesFromExecution(result: NormalizedExecutionResult): PublishedValuesFromExecution {
  const records: PublishedScalarRecord[] = []
  const diagnostics: PublishedValueDiagnostic[] = []
  const seen = new Set<string>()
  for (const bundle of result.mime) {
    if (!(PUBLISHED_VALUE_MIME in bundle.data)) continue
    const raw = readPayload(bundle.data[PUBLISHED_VALUE_MIME]!)
    const payloads = objectValue(raw ?? null)?.values
    const candidates = Array.isArray(payloads) ? payloads : [raw]
    for (const candidate of candidates) {
      const normalized = normalizeRecord(candidate ?? null)
      if (normalized.diagnostic) {
        diagnostics.push(normalized.diagnostic)
        continue
      }
      const record = normalized.record!
      if (seen.has(record.name)) {
        diagnostics.push(diagnostic(`published-value-duplicate-${record.name}`, `Published value “${record.name}” is produced more than once by cell ${result.cellId}. Rename one publication; DraftMatter will not choose a winner.`))
        continue
      }
      seen.add(record.name)
      records.push(record)
    }
  }
  return { records, diagnostics }
}

function retainedRecord(record: PublishedScalarRecord, result: NormalizedExecutionResult): RetainedPublishedValue {
  return {
    ...record,
    rendered: renderPublishedValue(record),
    provenance: {
      cellId: result.cellId,
      language: result.language,
      runHash: result.hashes.result,
      codeHash: result.hashes.code,
      environmentFingerprint: result.environment.fingerprint,
      sessionGeneration: result.provenance.sessionGeneration ?? 0,
      executionSequence: result.provenance.executionSequence ?? result.provenance.executionCount ?? 0,
      retainedOutputHashes: [result.hashes.result, ...result.artifacts.map((artifact) => artifact.hash)],
    },
  }
}

export function retainedPublishedValueDirectives(result: NormalizedExecutionResult) {
  const published = publishedValuesFromExecution(result)
  return {
    diagnostics: published.diagnostics,
    directives: published.records
      .map((record) => retainedRecord(record, result))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((record) => `<!-- dm-published-value data="${encodeURIComponent(JSON.stringify(record))}" -->`),
  }
}

export function parseRetainedPublishedValues(source: string): ParsedPublishedValues {
  const values: Record<string, RetainedPublishedValue> = {}
  const diagnostics: PublishedValueDiagnostic[] = []
  const duplicateNames = new Set<string>()
  const blockPattern = /<!--\s*dm-output:start\b[^>]*-->([\s\S]*?)<!--\s*dm-output:end\s*-->/gi
  for (const block of source.matchAll(blockPattern)) {
    for (const directive of block[1].matchAll(/<!--\s*dm-published-value\s+data="([^"]*)"\s*-->/gi)) {
      try {
        const decoded = JSON.parse(decodeURIComponent(directive[1])) as RetainedPublishedValue
        const normalized = normalizeRecord(decoded as unknown as JsonValue)
        if (normalized.diagnostic || !decoded.provenance || typeof decoded.provenance !== 'object') {
          diagnostics.push(normalized.diagnostic ?? diagnostic('published-value-invalid-provenance', 'A retained published value has invalid provenance and was ignored.'))
          continue
        }
        const record: RetainedPublishedValue = {
          ...normalized.record!,
          rendered: renderPublishedValue(normalized.record!),
          provenance: decoded.provenance,
        }
        if (values[record.name]) {
          duplicateNames.add(record.name)
          delete values[record.name]
        } else if (!duplicateNames.has(record.name)) {
          values[record.name] = record
        }
      } catch {
        diagnostics.push(diagnostic('published-value-invalid-encoding', 'A retained published value could not be decoded and was ignored.'))
      }
    }
  }
  for (const name of duplicateNames) diagnostics.push(diagnostic(
    `published-value-duplicate-${name}`,
    `Published value “${name}” is produced by more than one document cell. Rename one publication; DraftMatter will not choose a winner.`,
  ))
  return { values, diagnostics }
}

export function replacePublishedValueMarkup(source: string, values: Record<string, RetainedPublishedValue>, missing = 'value unavailable') {
  return source.replace(markupPattern, (_markup, name: string) => values[name]?.rendered ?? missing)
}

export function publishedValueMarkup(name: string) {
  if (!isPublishedValueName(name)) throw new Error('Published value names must start with a letter and use only letters, numbers, dots, colons, underscores, or hyphens.')
  return `{{${name}}}`
}
