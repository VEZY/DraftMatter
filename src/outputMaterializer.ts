import type { ExecutableCell } from './executionCells'
import { extractExecutableCells, isSetupCell } from './executionCells'
import type { JsonValue, MimeOutput, NormalizedExecutionResult } from './kernelExecution'
import { retainedPublishedValueDirectives } from './publishedValues'
import { executionImageFromMimeBundle, executionTableFromMimeBundle, sanitizeExecutionHtml } from './outputRenderer'
import { retainedOutputPresentation } from './numberedObjects'
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
  const table = executionTableFromMimeBundle(bundle)
  if (!table) return undefined
  return [
    `| ${table.columns.map(markdownValue).join(' | ')} |`,
    `| ${table.columns.map(() => '---').join(' | ')} |`,
    ...table.rows.map((row) => `| ${row.map(markdownValue).join(' | ')} |`),
  ].join('\n')
}

function mimeImageMarkdown(bundle: MimeOutput, result: NormalizedExecutionResult, presentation: OutputPresentation) {
  const image = executionImageFromMimeBundle(bundle)
  if (!image) return undefined
  const alt = escapeAlt(presentation.alt ?? presentation.caption ?? image.alt ?? `Generated output ${result.cellId}`)
  const label = presentation.label ? `{#${presentation.label}}` : ''
  const caption = presentation.caption ? `\n: ${escapeReserved(presentation.caption)}` : ''
  return `![${alt}](${image.source})${label}${caption}`
}

function presentedTableMarkdown(markdown: string, presentation: OutputPresentation) {
  if (!presentation.caption) return markdown
  const attributes = presentation.label ? ` {#${presentation.label}}` : ''
  return `${markdown}\n: ${escapeReserved(presentation.caption)}${attributes}`
}

function mimeMarkdown(result: NormalizedExecutionResult, presentation: OutputPresentation) {
  const hasImageArtifact = result.artifacts.some((artifact) => artifact.mediaType?.startsWith('image/'))
  for (const bundle of result.mime) {
    const image = mimeImageMarkdown(bundle, result, presentation)
    if (image) {
      if (!hasImageArtifact) return image
      continue
    }
    const table = tableMarkdown(bundle)
    if (table) return presentedTableMarkdown(table, presentation)
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
      const caption = index === 0 && presentation.caption ? `\n: ${escapeReserved(presentation.caption)}` : ''
      return `![${alt}](${markdownPath(artifact.path)})${label}${caption}`
    }
    const title = artifact.mediaType === 'text/csv' ? 'Generated table data' : 'Generated artifact'
    return `[${title}: ${artifact.path}](${markdownPath(artifact.path)})${label}`
  })
}

function generatedBlock(request: MaterializeOutputRequest) {
  const presentation = request.presentation ?? {}
  const pieces = artifactMarkdown(request.result, presentation)
  const mime = mimeMarkdown(request.result, presentation)
  if (mime) pieces.push(mime)
  if (pieces.length === 0) {
    const stdout = request.result.streams
      .filter((stream) => stream.name === 'stdout')
      .sort((left, right) => left.sequence - right.sequence)
      .map((stream) => stream.text)
      .join('')
    if (stdout.trim()) pieces.push(textFence(stdout))
  }
  const published = retainedPublishedValueDirectives(request.result)
  if (pieces.length === 0 && published.directives.length === 0) return { diagnostics: published.diagnostics }
  return { diagnostics: published.diagnostics, block: [
    `<!-- dm-output:start cell="${request.cellId}" run="${request.result.hashes.result}" -->`,
    [...published.directives, ...pieces].join('\n\n'),
    '<!-- dm-output:end -->',
  ].join('\n') }
}

function normalizedOutputPresentation(cell: ExecutableCell, presentation: OutputPresentation | undefined): OutputPresentation {
  const kind = cell.attributes.output === 'table' ? 'table' : cell.attributes.output === 'figure' ? 'figure' : undefined
  if (!kind) return presentation ?? {}
  const prefix = kind === 'table' ? 'tbl-' : 'fig-'
  const cellReference = typeof cell.attributes.reference === 'string' ? cell.attributes.reference : undefined
  const rawLabel = (presentation?.label || cellReference)?.trim().replace(/^#/, '')
  const safeLabel = rawLabel?.replace(/[^A-Za-z0-9_.:-]+/g, '-').replace(/^[^A-Za-z]+/, '')
  const label = safeLabel
    ? safeLabel.startsWith(prefix) ? safeLabel : `${prefix}${safeLabel}`
    : undefined
  const caption = presentation?.caption?.trim() || (kind === 'table' && label ? 'Generated table.' : undefined)
  return { ...presentation, label, caption }
}

function mergePresentation(previous: OutputPresentation, requested: OutputPresentation | undefined) {
  const next = { ...previous }
  for (const [key, value] of Object.entries(requested ?? {})) {
    if (value !== undefined) next[key as keyof OutputPresentation] = value
  }
  return next
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
  if (isSetupCell(cell)) return { ok: true, source: request.source, diagnostics: [] }
  const produced = new Set(request.result.artifacts.map((artifact) => artifact.path))
  const missing = declaredArtifacts(cell).filter((path) => !produced.has(path))
  if (missing.length) {
    return { ...diagnostic('output-artifact-missing', `Declared artifact${missing.length === 1 ? '' : 's'} missing from the successful run: ${missing.join(', ')}.`), source: request.source }
  }
  const existing = outputNodesFor(request.source, request.cellId)
  const previous = existing[0]
    ? retainedOutputPresentation(existing[0].raw, cell.attributes.output)
    : undefined
  const generated = generatedBlock({
    ...request,
    presentation: normalizedOutputPresentation(cell, mergePresentation({
      label: previous?.label,
      caption: previous?.caption,
      alt: previous?.alt,
    }, request.presentation)),
  })
  if (generated.diagnostics.length) {
    return { ok: false, source: request.source, diagnostics: generated.diagnostics }
  }
  const block = generated.block
  if (!block) return { ...diagnostic('output-empty', 'The successful run has no portable artifact, published value, or MIME output to materialize.'), source: request.source }
  const ending = lineEnding(request.source)
  const replacement = normalizeEnding(block, ending)
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
