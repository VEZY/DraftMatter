import { parseStructuredManuscript } from './structuredManuscript'
import { parsePublicationMetadata } from './publicationMetadata'

const WORD_PATTERN = /[\p{L}\p{N}]+(?:[’'\-][\p{L}\p{N}]+)*/gu
const READING_WORDS_PER_MINUTE = 220
const NON_PROSE_NODES = new Set(['code_cell', 'output_block', 'raw_block'])

export interface ManuscriptMetrics {
  words: number
  headings: number
  readingMinutes: number
}

export function countWords(text: string) {
  return text.match(WORD_PATTERN)?.length ?? 0
}

export function readingMinutesForWords(words: number) {
  return words > 0 ? Math.max(1, Math.ceil(words / READING_WORDS_PER_MINUTE)) : 0
}

/** Derive reader-facing metrics from semantic manuscript content, excluding code, outputs, raw syntax, and review records. */
export function measurePortableManuscript(source: string): ManuscriptMetrics {
  const parsed = parseStructuredManuscript(source)
  const prose: string[] = []
  let headings = 0
  let hasDocumentHeading = false

  parsed.document.descendants((node) => {
    const name = node.type.name
    if (name === 'heading') {
      headings += 1
      if (Number(node.attrs.level) === 1) hasDocumentHeading = true
    }
    if (NON_PROSE_NODES.has(name)) return false
    if (node.isText && node.text) prose.push(node.text)
    if (name === 'footnote_definition' && node.attrs.contentMarkdown) prose.push(String(node.attrs.contentMarkdown))
    if (name === 'citation' && node.attrs.rendered) prose.push(String(node.attrs.rendered))
    if (name === 'cross_reference') prose.push(String(node.attrs.rendered || node.attrs.target || ''))
    return true
  })
  if (!hasDocumentHeading) {
    const title = parsePublicationMetadata(source).title
    if (title) prose.unshift(title)
  }

  const words = countWords(prose.join(' '))
  return { words, headings, readingMinutes: readingMinutesForWords(words) }
}
