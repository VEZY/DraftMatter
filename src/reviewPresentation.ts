import { parseStructuredManuscript } from './structuredManuscript'

function readableFallback(source: string) {
  return source
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gm, '')
    .replace(/[*_`~$]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Produces a quiet rendered label for portable proposal source. */
export function reviewProposalText(proposal: string) {
  const source = proposal.trim()
  if (!source) return ''
  try {
    const document = parseStructuredManuscript(source).document
    const rendered = document.textBetween(0, document.content.size, ' ', ' ').replace(/\s+/g, ' ').trim()
    return rendered || readableFallback(source)
  } catch {
    return readableFallback(source)
  }
}
