import { embeddedExecutionImageFromHtml } from './outputRenderer'
import { parseTableCaptionLine } from './tableSyntax'

export interface RetainedOutputPresentation {
  kind: 'image' | 'table' | 'markdown'
  label?: string
  caption?: string
  alt?: string
  sourceAttributes?: string
  unnumbered: boolean
}

export function isExplicitlyUnnumbered(sourceAttributes: unknown) {
  return /(?:^|\s)\.unnumbered(?:\s|$)/.test(String(sourceAttributes ?? ''))
}

function retainedOutputBody(markdown: string) {
  return markdown
    .replace(/^\s*<!-- dm-output:start[^>]*-->\s*/m, '')
    .replace(/\s*<!-- dm-output:end -->\s*$/m, '')
    .replace(/^\s*<!-- dm-published-value\b[^>]*-->\s*$/gm, '')
    .trim()
}

function imagePresentation(body: string): RetainedOutputPresentation | undefined {
  const image = body.match(/!\[([^\]]*)\]\((?:<[^>\r\n]+>|[^)\r\n]+)\)\s*(?:\{([^}\r\n]+)\})?/)
  if (!image) return undefined
  const sourceAttributes = image[2]?.trim()
  const after = body.slice((image.index ?? 0) + image[0].length).trim()
  const conventional = after.match(/^:\s*(.+)$/m)?.[1]?.trim()
  const legacy = conventional ? undefined : after.match(/^\*([^*\r\n]+)\*$/m)?.[1]?.trim()
  return {
    kind: 'image',
    alt: image[1].trim() || undefined,
    label: sourceAttributes?.match(/(?:^|\s)#([a-zA-Z][\w.:-]*)/)?.[1],
    caption: conventional || legacy || undefined,
    sourceAttributes,
    unnumbered: isExplicitlyUnnumbered(sourceAttributes),
  }
}

function tablePresentation(body: string): RetainedOutputPresentation | undefined {
  const lines = body.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')
  const separator = lines.findIndex((line) => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line))
  if (separator < 1) return undefined
  let index = separator + 1
  while (index < lines.length && lines[index].includes('|') && lines[index].trim()) index += 1
  while (index < lines.length && !lines[index].trim()) index += 1
  const caption = parseTableCaptionLine(lines[index] ?? '')
  return {
    kind: 'table',
    label: caption?.label ?? undefined,
    caption: caption?.captionMarkdown || undefined,
    sourceAttributes: caption?.sourceAttributes ?? undefined,
    unnumbered: isExplicitlyUnnumbered(caption?.sourceAttributes),
  }
}

export function retainedOutputPresentation(markdown: string, declaredKind?: unknown): RetainedOutputPresentation {
  const body = retainedOutputBody(markdown)
  const image = imagePresentation(body)
  if (image) return image
  if (embeddedExecutionImageFromHtml(body)) return { kind: 'image', unnumbered: false }
  const table = tablePresentation(body)
  if (table) return table
  return { kind: declaredKind === 'table' ? 'table' : declaredKind === 'image' ? 'image' : 'markdown', unnumbered: false }
}
