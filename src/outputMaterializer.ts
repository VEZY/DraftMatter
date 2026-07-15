import type { ExecutableCell } from './executionCells'
import { extractExecutableCells } from './executionCells'
import type { JsonValue, MimeOutput, NormalizedExecutionResult } from './executionProvider'
import { sanitizeExecutionHtml } from './outputRenderer'
import { parseLosslessPortableSource } from './portableSource'
import type { DocumentDiagnostic } from './types'

export interface OutputPresentation {
  label?: string
  caption?: string
  alt?: string
}

export interface MaterializeOutputRequest {
  source: string
  cellId: string
  result: NormalizedExecutionResult
  presentation?: OutputPresentation
}

export type MaterializeOutputResult =
  | { ok: true; source: string; diagnostics: DocumentDiagnostic[] }
  | { ok: false; source: string; diagnostics: DocumentDiagnostic[] }

function diagnostic(code: string, message: string): MaterializeOutputResult {
  return { ok: false, source: '', diagnostics: [{ code, level: 'error', message }] }
}

function lineEnding(source: string) {
  return source.includes('\r\n') ? '\r\n' : source.includes('\r') ? '\r' : '\n'
}

function escapeAlt(value: string) {
  return escapeReserved(value).replaceAll('\\', '\\\\').replaceAll(']', '\\]').replaceAll('[', '\\[').replaceAll('\r', ' ').replaceAll('\n', ' ')
}

function markdownPath(value: string) {
  return `<${escapeReserved(value).replaceAll('>', '%3E').replaceAll('<', '%3C')}>`
}

function escapeReserved(value: string) {
  return value.replace(/<!--\s*dm-output:/gi, '&lt;!-- dm-output:')
}

function textFence(value: string) {
  const longest = Math.max(0, ...[...value.matchAll(/~+/g)].map((match) => match[0].length))
  const fence = '~'.repeat(Math.max(3, longest + 1))
  return `${fence}text\n${escapeReserved(value).replace(/\n$/, '')}\n${fence}`
}

function cellById(source: string, cellId: string) {
  return extractExecutableCells(source).cells.find((cell) => cell.id === cellId)
}

function declaredArtifacts(cell: ExecutableCell) {
  const value = cell.attributes.produces
  return typeof value === 'string'
    ? value.split(',').map((path) => path.trim()).filter(Boolean)
    : []
}

function markdownValue(value: JsonValue) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return escapeReserved(text).replaceAll('|', '\\|').replaceAll('\r', ' ').replaceAll('\n', '<br>')
}

function tableMarkdown(bundle: MimeOutput) {
  const resource = bundle.data['application/vnd.dataresource+json']
  if (!resource || Array.isArray(resource) || typeof resource !== 'object') return undefined
  const object = resource as Record<string, JsonValue>
  const schema = object.schema
  const data = object.data
  if (!schema || Array.isArray(schema) || typeof schema !== 'object' || !Array.isArray(data)) return undefined
  const fields = (schema as Record<string, JsonValue>).fields
  if (!Array.isArray(fields)) return undefined
  const columns = fields.flatMap((field) => {
    if (!field || Array.isArray(field) || typeof field !== 'object') return []
    const name = (field as Record<string, JsonValue>).name
    return typeof name === 'string' ? [name] : []
  })
  if (columns.length === 0) return undefined
  const rows = data.map((row) => {
    if (Array.isArray(row)) return columns.map((_, index) => row[index] ?? null)
    if (row && typeof row === 'object') return columns.map((column) => (row as Record<string, JsonValue>)[column] ?? null)
    return columns.map(() => null)
  })
  return [
    `| ${columns.map(markdownValue).join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(markdownValue).join(' | ')} |`),
  ].join('\n')
}

function mimeMarkdown(result: NormalizedExecutionResult) {
  for (const bundle of result.mime) {
    const table = tableMarkdown(bundle)
    if (table) return table
    const markdown = bundle.data['text/markdown']
    if (typeof markdown === 'string') return escapeReserved(markdown).trim()
    const html = bundle.data['text/html']
    if (typeof html === 'string') return escapeReserved(sanitizeExecutionHtml(html)).trim()
    const text = bundle.data['text/plain']
    if (typeof text === 'string') return textFence(text)
  }
  return undefined
}

function artifactMarkdown(result: NormalizedExecutionResult, presentation: OutputPresentation) {
  return result.artifacts.map((artifact, index) => {
    const label = index === 0 && presentation.label ? `{#${presentation.label}}` : ''
    if (artifact.mediaType?.startsWith('image/')) {
      const alt = escapeAlt(index === 0 ? presentation.alt ?? presentation.caption ?? `Generated output ${result.cellId}` : `Generated artifact ${artifact.path}`)
      const caption = index === 0 && presentation.caption ? `\n\n*${escapeReserved(presentation.caption)}*` : ''
      return `![${alt}](${markdownPath(artifact.path)})${label}${caption}`
    }
    const title = artifact.mediaType === 'text/csv' ? 'Generated table data' : 'Generated artifact'
    return `[${title}: ${artifact.path}](${markdownPath(artifact.path)})${label}`
  })
}

function generatedBlock(request: MaterializeOutputRequest) {
  const presentation = request.presentation ?? {}
  const pieces = artifactMarkdown(request.result, presentation)
  const mime = mimeMarkdown(request.result)
  if (mime) pieces.push(mime)
  if (pieces.length === 0) return undefined
  return [
    `<!-- dm-output:start cell="${request.cellId}" run="${request.result.hashes.result}" -->`,
    pieces.join('\n\n'),
    '<!-- dm-output:end -->',
  ].join('\n')
}

function normalizeEnding(value: string, ending: string) {
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').replaceAll('\n', ending)
}

function outputNodesFor(source: string, cellId: string) {
  return parseLosslessPortableSource(source).semanticNodes.filter(
    (node) => node.kind === 'output' && node.attributes.cell === cellId,
  )
}

export function materializeExecutionOutput(request: MaterializeOutputRequest): MaterializeOutputResult {
  if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(request.cellId)) {
    return { ...diagnostic('output-cell-id-invalid', 'Output materialization requires a safe executable cell ID.'), source: request.source }
  }
  if (request.result.cellId !== request.cellId || request.result.status !== 'succeeded') {
    return { ...diagnostic('output-run-ineligible', 'Only a successful result from the same cell can be materialized.'), source: request.source }
  }
  const cell = cellById(request.source, request.cellId)
  if (!cell) return { ...diagnostic('output-cell-missing', `Executable cell ${request.cellId} was not found in the portable source.`), source: request.source }
  const produced = new Set(request.result.artifacts.map((artifact) => artifact.path))
  const missing = declaredArtifacts(cell).filter((path) => !produced.has(path))
  if (missing.length) {
    return { ...diagnostic('output-artifact-missing', `Declared artifact${missing.length === 1 ? '' : 's'} missing from the successful run: ${missing.join(', ')}.`), source: request.source }
  }
  const block = generatedBlock(request)
  if (!block) return { ...diagnostic('output-empty', 'The successful run has no portable artifact or MIME output to materialize.'), source: request.source }
  const ending = lineEnding(request.source)
  const replacement = normalizeEnding(block, ending)
  const existing = outputNodesFor(request.source, request.cellId)
  if (existing.length > 1) {
    return { ...diagnostic('output-block-duplicate', `More than one generated output block targets ${request.cellId}.`), source: request.source }
  }
  if (existing[0]) {
    if (!existing[0].raw.includes('<!-- dm-output:end -->')) {
      return { ...diagnostic('output-block-unclosed', `The generated output block for ${request.cellId} is not closed.`), source: request.source }
    }
    const terminal = existing[0].raw.endsWith('\r\n') ? '\r\n' : /[\r\n]$/.test(existing[0].raw) ? existing[0].raw.at(-1)! : ''
    return {
      ok: true,
      source: `${request.source.slice(0, existing[0].start)}${replacement}${terminal}${request.source.slice(existing[0].end)}`,
      diagnostics: [],
    }
  }
  let insertion = cell.position.endOffset
  if (request.source.slice(insertion).startsWith('\r\n')) insertion += 2
  else if (/^[\r\n]/.test(request.source.slice(insertion))) insertion += 1
  const before = request.source.slice(0, insertion)
  const after = request.source.slice(insertion)
  const separatorBefore = before.endsWith(ending) ? ending : `${ending}${ending}`
  const separatorAfter = after.startsWith(ending) || after.length === 0 ? ending : `${ending}${ending}`
  return {
    ok: true,
    source: `${before}${separatorBefore}${replacement}${separatorAfter}${after}`,
    diagnostics: [],
  }
}
