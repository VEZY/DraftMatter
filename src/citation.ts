import type { CitationItem, DraftState } from './types'

const CITEKEY = /^[a-zA-Z0-9_:.+-]+$/
const LOCATOR = /^(?:p{1,2}\.?|chap(?:ter)?\.?|sec(?:tion)?\.?|fig(?:ure)?\.?|tbl\.?|table|eq\.?|equation|line(?:s)?|§|\d)\s*/i

function compactItem(item: CitationItem): CitationItem {
  const prefix = item.prefix?.trim()
  const suffix = item.suffix?.trim()
  const locator = item.locator?.trim()
  return {
    citekey: item.citekey.trim(),
    ...(prefix ? { prefix } : {}),
    ...(suffix ? { suffix } : {}),
    ...(locator ? { locator } : {}),
    ...(item.suppressAuthor ? { suppressAuthor: true } : {}),
  }
}

export function normalizeCitationItems(value: unknown, fallbackKeys: string[] = []): CitationItem[] {
  if (Array.isArray(value)) {
    const normalized = value.flatMap<CitationItem>((candidate) => {
      if (!candidate || typeof candidate !== 'object') return []
      const item = candidate as Partial<CitationItem>
      if (typeof item.citekey !== 'string' || !CITEKEY.test(item.citekey.trim())) return []
      return [compactItem({
        citekey: item.citekey,
        prefix: typeof item.prefix === 'string' ? item.prefix : undefined,
        suffix: typeof item.suffix === 'string' ? item.suffix : undefined,
        locator: typeof item.locator === 'string' ? item.locator : undefined,
        suppressAuthor: item.suppressAuthor === true,
      })]
    })
    if (normalized.length) return normalized
  }
  return fallbackKeys.filter((key) => CITEKEY.test(key)).map((citekey) => ({ citekey }))
}

export function citationItemsForDraft(draft: Pick<DraftState, 'citationItems' | 'citationKeys'>): CitationItem[] {
  const items = normalizeCitationItems(draft.citationItems)
  const keys = normalizeCitationItems(undefined, draft.citationKeys)
  if (keys.length && (
    items.length !== keys.length
    || items.some((item, index) => item.citekey !== keys[index].citekey)
  )) return keys
  return items.length ? items : keys
}

export function citationKeys(items: CitationItem[]) {
  return items.map((item) => item.citekey)
}

export function parseCitationCluster(source: string): CitationItem[] {
  const content = source.trim().replace(/^\[/, '').replace(/\]$/, '')
  return content.split(';').flatMap<CitationItem>((segment) => {
    const match = segment.trim().match(/^(.*?)(-?)@([a-zA-Z0-9_:.+-]+)([\s\S]*)$/)
    if (!match) return []
    const tail = match[4].trim().replace(/^,\s*/, '')
    const tailParts = tail ? tail.split(/,\s*/).map((part) => part.trim()).filter(Boolean) : []
    const locator = tailParts[0] && LOCATOR.test(tailParts[0]) ? tailParts.shift() : undefined
    return [compactItem({
      citekey: match[3],
      prefix: match[1],
      locator,
      suffix: tailParts.join(', '),
      suppressAuthor: match[2] === '-',
    })]
  })
}

export function serializeCitationCluster(items: CitationItem[]) {
  const normalized = normalizeCitationItems(items)
  const body = normalized.map((item) => {
    const prefix = item.prefix ? `${item.prefix} ` : ''
    const cite = `${item.suppressAuthor ? '-' : ''}@${item.citekey}`
    const tail = [item.locator, item.suffix].filter(Boolean).join(', ')
    return `${prefix}${cite}${tail ? `, ${tail}` : ''}`
  }).join('; ')
  return `[${body}]`
}

export function sameCitationItems(left: CitationItem[], right: CitationItem[]) {
  const normalizedLeft = normalizeCitationItems(left)
  const normalizedRight = normalizeCitationItems(right)
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((item, index) => JSON.stringify(item) === JSON.stringify(normalizedRight[index]))
}
