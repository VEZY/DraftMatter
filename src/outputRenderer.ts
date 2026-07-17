import type {
  ExecutionArtifact,
  ExecutionError,
  ExecutionStream,
  JsonValue,
  MimeOutput,
  NormalizedExecutionResult,
} from './kernelExecution'

export type RenderedExecutionOutput =
  | { kind: 'stream'; stream: ExecutionStream }
  | { kind: 'error'; error: ExecutionError }
  | { kind: 'image'; mediaType: string; source: string; alt: string; artifactPath?: string }
  | { kind: 'html'; sourceDocument: string; sandbox: '' }
  | { kind: 'markdown'; source: string }
  | { kind: 'text'; source: string }
  | { kind: 'table'; columns: string[]; rows: JsonValue[][] }
  | { kind: 'artifact'; artifact: ExecutionArtifact }

const blockedElement = /<(script|iframe|frame|frameset|object|embed|base|meta|link|form|input|button|textarea|select|option)\b[^>]*>[\s\S]*?<\/\1\s*>|<(script|iframe|frame|frameset|object|embed|base|meta|link|form|input|button|textarea|select|option)\b[^>]*\/?\s*>/gi
const dangerousAttribute = /\s(?:on[a-z0-9_-]+|srcdoc)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi
const urlAttribute = /\s(href|src|xlink:href|action|formaction)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi
const styleAttribute = /\sstyle\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi

function safeUrl(attribute: string, value: string) {
  const normalized = value.trim().toLowerCase()
  if (attribute === 'href' && normalized.startsWith('#')) return true
  if (attribute === 'src' && /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(value)) return true
  return false
}

export function sanitizeExecutionHtml(source: string) {
  let sanitized = source
  let previous = ''
  while (sanitized !== previous) {
    previous = sanitized
    sanitized = sanitized.replace(blockedElement, '')
  }
  sanitized = sanitized
    .replace(dangerousAttribute, '')
    .replace(urlAttribute, (match, attribute: string, _quoted: string, double: string, single: string, bare: string) => {
      const value = double ?? single ?? bare ?? ''
      return safeUrl(attribute.toLowerCase(), value) ? match : ''
    })
    .replace(styleAttribute, (match, _quoted: string, double: string, single: string, bare: string) => {
      const value = double ?? single ?? bare ?? ''
      return /(?:url\s*\(|@import|expression\s*\(|behavior\s*:|-moz-binding)/i.test(value) ? '' : match
    })
  return sanitized
}

export function isolatedHtmlDocument(source: string) {
  const sanitized = sanitizeExecutionHtml(source)
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><style>html{color:#26312c;background:#fff;font:14px/1.5 system-ui,sans-serif}body{margin:12px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #dfe5e1;padding:6px 8px;text-align:left}th{background:#f7f9f8}</style></head><body>${sanitized}</body></html>`
}

function stringValue(value: JsonValue | undefined) {
  return typeof value === 'string' ? value : undefined
}

function metadataText(bundle: MimeOutput, key: string, fallback: string) {
  return stringValue(bundle.metadata[key]) ?? fallback
}

function sanitizedSvgData(source: string) {
  const sanitized = sanitizeExecutionHtml(source).replace(/<foreignObject\b[^>]*>[\s\S]*?<\/foreignObject\s*>/gi, '')
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sanitized)}`
}

function tableFromValue(value: JsonValue | undefined): Extract<RenderedExecutionOutput, { kind: 'table' }> | undefined {
  if (Array.isArray(value) && value.length > 0 && value.every((row) => row !== null && typeof row === 'object' && !Array.isArray(row))) {
    const objects = value as Array<Record<string, JsonValue>>
    const columns = [...new Set(objects.flatMap((row) => Object.keys(row)))]
    return { kind: 'table', columns, rows: objects.map((row) => columns.map((column) => row[column] ?? null)) }
  }
  if (!value || Array.isArray(value) || typeof value !== 'object') return undefined
  const resource = value as Record<string, JsonValue>
  const data = resource.data
  const schema = resource.schema
  if (!Array.isArray(data) || !schema || Array.isArray(schema) || typeof schema !== 'object') return undefined
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
  return { kind: 'table', columns, rows }
}

function renderMime(bundle: MimeOutput): RenderedExecutionOutput | undefined {
  const svg = stringValue(bundle.data['image/svg+xml'])
  if (svg) return { kind: 'image', mediaType: 'image/svg+xml', source: sanitizedSvgData(svg), alt: metadataText(bundle, 'alt', 'Generated SVG output') }
  for (const mediaType of ['image/png', 'image/jpeg'] as const) {
    const encoded = stringValue(bundle.data[mediaType])
    if (encoded) return { kind: 'image', mediaType, source: `data:${mediaType};base64,${encoded.replace(/\s+/g, '')}`, alt: metadataText(bundle, 'alt', 'Generated image output') }
  }
  const dataResource = tableFromValue(bundle.data['application/vnd.dataresource+json'])
  if (dataResource) return dataResource
  const jsonTable = tableFromValue(bundle.data['application/json'])
  if (jsonTable) return jsonTable
  const html = stringValue(bundle.data['text/html'])
  if (html) return { kind: 'html', sourceDocument: isolatedHtmlDocument(html), sandbox: '' }
  const markdown = stringValue(bundle.data['text/markdown'])
  if (markdown) return { kind: 'markdown', source: markdown }
  const text = stringValue(bundle.data['text/plain'])
  if (text !== undefined) return { kind: 'text', source: text }
  const json = bundle.data['application/json']
  if (json !== undefined) return { kind: 'text', source: JSON.stringify(json, null, 2) }
  return undefined
}

function artifactOutput(artifact: ExecutionArtifact): RenderedExecutionOutput {
  if (artifact.mediaType?.startsWith('image/')) {
    return {
      kind: 'image',
      mediaType: artifact.mediaType,
      source: artifact.path,
      alt: `Generated artifact ${artifact.path}`,
      artifactPath: artifact.path,
    }
  }
  return { kind: 'artifact', artifact }
}

export function renderExecutionOutputs(result: NormalizedExecutionResult) {
  const outputs: RenderedExecutionOutput[] = [
    ...[...result.streams].sort((left, right) => left.sequence - right.sequence).map((stream) => ({ kind: 'stream' as const, stream })),
    ...result.mime.flatMap((bundle) => {
      const rendered = renderMime(bundle)
      return rendered ? [rendered] : []
    }),
    ...result.artifacts.map(artifactOutput),
    ...result.errors.map((error) => ({ kind: 'error' as const, error })),
  ]
  return outputs
}
