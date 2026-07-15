export type TableAlignment = 'left' | 'center' | 'right' | null

export interface ParsedTableCaption {
  captionMarkdown: string
  label: string | null
  sourceAttributes: string | null
}

export function pipeTableCells(value: string) {
  return value.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
}

export function pipeTableAlignments(value: string): TableAlignment[] {
  return pipeTableCells(value).map((cell) => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    if (left) return 'left'
    return null
  })
}

export function parseTableCaptionLine(value: string): ParsedTableCaption | null {
  const captionLine = value.match(/^:\s*(.+)$/)
  if (!captionLine) return null
  const attributeCandidate = captionLine[1].match(/^(.*?)(?:\s+\{([^}\r\n]+)\})$/)
  const attributed = attributeCandidate && /(?:^|\s)(?:#[a-zA-Z]|\.[a-zA-Z]|[a-zA-Z][\w-]*=)/.test(attributeCandidate[2])
    ? attributeCandidate
    : null
  const sourceAttributes = attributed?.[2] ?? null
  return {
    captionMarkdown: (attributed?.[1] ?? captionLine[1]).trim(),
    label: sourceAttributes?.match(/(?:^|\s)#([a-zA-Z][\w.:-]*)/)?.[1] ?? null,
    sourceAttributes,
  }
}
