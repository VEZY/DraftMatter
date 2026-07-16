import { parseReviewMarkup } from './reviewMarkup'

export interface PortableSectionRequest {
  title: string
  level?: number
  label?: string
}

function lineEnding(source: string) {
  return source.includes('\r\n') ? '\r\n' : source.includes('\r') ? '\r' : '\n'
}

function sectionLabelExists(source: string, label: string) {
  return [...source.matchAll(/\{([^}\r\n]*)\}/g)]
    .some((attributes) => attributes[1].split(/\s+/).includes(`#${label}`))
}

/** Insert an ordinary heading before the reserved review-data section. */
export function insertPortableSection(source: string, request: PortableSectionRequest) {
  const title = request.title.trim()
  if (!title) throw new Error('A section heading cannot be empty.')
  if (/[\r\n]/.test(title)) throw new Error('A section heading must stay on one line.')
  if (title.length > 500) throw new Error('A section heading cannot exceed 500 characters.')

  const level = request.level ?? 2
  if (!Number.isInteger(level) || level < 1 || level > 6) throw new Error('Heading levels must be between 1 and 6.')
  const label = request.label?.trim().replace(/^#/, '') || undefined
  if (label && !/^sec-[a-zA-Z0-9](?:[a-zA-Z0-9_.:-]*[a-zA-Z0-9])?$/.test(label)) {
    throw new Error('Section labels use the portable sec-… form, for example sec-methods.')
  }
  if (label && sectionLabelExists(source, label)) throw new Error(`Section label ${label} is already used in this manuscript.`)

  const ending = lineEnding(source)
  const reviewStart = parseReviewMarkup(source).sectionStart ?? source.length
  const manuscript = source.slice(0, reviewStart)
  const review = source.slice(reviewStart)
  const spacer = manuscript.length === 0
    ? ''
    : manuscript.endsWith(`${ending}${ending}`) ? '' : manuscript.endsWith(ending) ? ending : `${ending}${ending}`
  const heading = `${'#'.repeat(level)} ${title}${label ? ` {#${label}}` : ''}`

  return `${manuscript}${spacer}${heading}${ending}${ending}${review}`
}
