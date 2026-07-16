export interface PublicationMetadata {
  title?: string
  authors: string[]
  authorDetails: PublicationAuthor[]
  body: string
}

export interface PublicationAuthor {
  name: string
  orcid?: string
  affiliations: string[]
}

export interface PublicationBylineAuthor extends PublicationAuthor {
  affiliationNumbers: number[]
}

export interface PublicationByline {
  authors: PublicationBylineAuthor[]
  affiliations: string[]
}

export function buildPublicationByline(authorDetails: PublicationAuthor[], fallbackNames: string[] = []): PublicationByline {
  const source: PublicationAuthor[] = authorDetails.length
    ? authorDetails
    : fallbackNames.map((name) => ({ name, affiliations: [] }))
  const affiliations: string[] = []
  const affiliationNumbers = new Map<string, number>()
  const authors = source.flatMap<PublicationBylineAuthor>((author) => {
    const name = author.name.trim()
    if (!name) return []
    const seenNumbers = new Set<number>()
    const numbers = author.affiliations.flatMap((value) => {
      const affiliation = value.trim()
      if (!affiliation) return []
      let number = affiliationNumbers.get(affiliation)
      if (!number) {
        affiliations.push(affiliation)
        number = affiliations.length
        affiliationNumbers.set(affiliation, number)
      }
      if (seenNumbers.has(number)) return []
      seenNumbers.add(number)
      return [number]
    })
    return [{
      name,
      ...(author.orcid?.trim() ? { orcid: normalizedOrcidValue(author.orcid) } : {}),
      affiliations: numbers.map((number) => affiliations[number - 1]),
      affiliationNumbers: numbers,
    }]
  })
  return { authors, affiliations }
}

interface SourceLine {
  raw: string
  content: string
  ending: string
  start: number
  end: number
}

interface PublicationFrontmatter {
  lines: SourceLine[]
  closingIndex: number
  ending: string
}

function sourceLines(source: string) {
  let offset = 0
  return (source.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) ?? [])
    .filter((raw) => raw.length > 0)
    .map<SourceLine>((raw) => {
      const ending = raw.match(/(?:\r\n|\n|\r)$/)?.[0] ?? ''
      const line = { raw, content: raw.slice(0, raw.length - ending.length), ending, start: offset, end: offset + raw.length }
      offset = line.end
      return line
    })
}

function publicationFrontmatter(source: string): PublicationFrontmatter | null {
  const lines = sourceLines(source)
  if (lines[0]?.content !== '---') return null
  const closingIndex = lines.slice(1).findIndex((line) => line.content === '---') + 1
  if (closingIndex < 1) return null
  return {
    lines,
    closingIndex,
    ending: lines[0].ending || (source.includes('\r\n') ? '\r\n' : source.includes('\r') ? '\r' : '\n'),
  }
}

function scalar(value: string) {
  const trimmed = value.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (typeof parsed === 'string') return parsed
    } catch {
      // Preserve the readable scalar even when its YAML quoting is malformed.
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replaceAll("''", "'")
  return trimmed
}

function splitYamlComment(value: string) {
  let quote: 'single' | 'double' | undefined
  let escaped = false
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (quote === 'double') {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quote = undefined
      continue
    }
    if (quote === 'single') {
      if (character === "'" && value[index + 1] === "'") index += 1
      else if (character === "'") quote = undefined
      continue
    }
    if (character === '"') quote = 'double'
    else if (character === "'") quote = 'single'
    else if (character === '#' && (index === 0 || /\s/.test(value[index - 1]))) {
      const content = value.slice(0, index).trimEnd()
      return { content, suffix: value.slice(content.length) }
    }
  }
  const content = value.trimEnd()
  return { content, suffix: value.slice(content.length) }
}

function inlineAuthorValues(value: string) {
  const authors: string[] = []
  let quote: 'single' | 'double' | undefined
  let escaped = false
  let start = 0
  for (let index = 0; index <= value.length; index += 1) {
    const character = value[index]
    if (quote === 'double') {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quote = undefined
      continue
    }
    if (quote === 'single') {
      if (character === "'" && value[index + 1] === "'") index += 1
      else if (character === "'") quote = undefined
      continue
    }
    if (character === '"') quote = 'double'
    else if (character === "'") quote = 'single'
    else if (character === ',' || index === value.length) {
      const author = scalar(value.slice(start, index))
      if (author) authors.push(author)
      start = index + 1
    }
  }
  return authors
}

function inlineAuthors(value: string) {
  const trimmed = splitYamlComment(value).content.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return [scalar(trimmed)]
  return inlineAuthorValues(trimmed.slice(1, -1))
}

function normalizedOrcidValue(value: string) {
  return value.trim().replace(/^https?:\/\/(?:www\.)?orcid\.org\//i, '').toUpperCase()
}

export function normalizePublicationOrcid(value: string) {
  const normalized = normalizedOrcidValue(value)
  if (!normalized) return undefined
  if (!/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(normalized)) throw new Error('ORCID identifiers use the form 0000-0000-0000-0000.')
  const digits = normalized.replaceAll('-', '')
  let total = 0
  for (const digit of digits.slice(0, 15)) total = (total + Number(digit)) * 2
  const remainder = (12 - (total % 11)) % 11
  const checksum = remainder === 10 ? 'X' : String(remainder)
  if (digits.at(-1) !== checksum) throw new Error('The ORCID check digit is invalid.')
  return normalized
}

function authorDetailsFromBlock(lines: SourceLine[], start: number, end: number, itemIndent: number, name: string): PublicationAuthor {
  let orcid: string | undefined
  const affiliations: string[] = []
  const directIndent = itemIndent + 2
  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index]
    const field = line.content.match(new RegExp(`^\\s{${directIndent}}(orcid|affiliations?|affiliation)[ \\t]*:[ \\t]*(.*)$`, 'i'))
    if (!field) continue
    const key = field[1].toLowerCase()
    const value = splitYamlComment(field[2]).content.trim()
    if (key === 'orcid') {
      const candidate = scalar(value)
      orcid = candidate ? normalizedOrcidValue(candidate) : undefined
      continue
    }
    if (value) {
      const values = value.startsWith('[') && value.endsWith(']') ? inlineAuthorValues(value.slice(1, -1)) : [scalar(value)]
      affiliations.push(...values.filter(Boolean))
      continue
    }
    for (let nested = index + 1; nested < end; nested += 1) {
      const item = lines[nested].content.match(new RegExp(`^\\s{${directIndent + 2},}-[ \\t]+(.+?)\\s*$`))
      if (!item) {
        if (lines[nested].content.trim() && lines[nested].content.search(/\S/) <= directIndent) break
        continue
      }
      const affiliation = scalar(splitYamlComment(item[1]).content)
      if (affiliation) affiliations.push(affiliation)
    }
  }
  return { name, ...(orcid ? { orcid } : {}), affiliations }
}

function topLevelKey(line: SourceLine) {
  return /^[a-zA-Z_][\w-]*[ \t]*:/.test(line.content)
}

function normalizedAuthorEntries(authors: string[], sourceIndexes?: Array<number | undefined>) {
  if (authors.length > 100) throw new Error('A manuscript can contain at most 100 authors.')
  return authors.flatMap((author, index) => {
    if (/[\r\n]/.test(author)) throw new Error('Author names must stay on one line.')
    const name = author.trim()
    if (!name) return []
    if (name.length > 240) throw new Error('Author names cannot exceed 240 characters.')
    return [{ name, sourceIndex: sourceIndexes ? sourceIndexes[index] : index }]
  })
}

function quotedYaml(value: string) {
  return JSON.stringify(value)
}

function authorBlock(authors: string[], ending: string) {
  return `author:${ending}${authors.map((author) => `  - ${quotedYaml(author)}${ending}`).join('')}`
}

function updateAuthorItemName(raw: string, name: string) {
  const firstEnding = raw.match(/(?:\r\n|\n|\r)/)?.[0] ?? ''
  const firstEnd = firstEnding ? raw.indexOf(firstEnding) : raw.length
  const first = raw.slice(0, firstEnd)
  const rest = raw.slice(firstEnd + firstEnding.length)
  const match = first.match(/^([ \t]+-[ \t]+(?:(?:name)[ \t]*:[ \t]*)?)(.*)$/)
  if (!match) throw new Error('This manuscript uses author metadata that must be edited in the source inspector.')
  const value = splitYamlComment(match[2])
  if (!value.content.trim()) throw new Error('This manuscript uses structured author names that must be edited in the source inspector.')
  return `${match[1]}${quotedYaml(name)}${value.suffix}${firstEnding}${rest}`
}

export function parsePublicationMetadata(source: string): PublicationMetadata {
  const frontmatter = publicationFrontmatter(source)
  if (!frontmatter) return { body: source, authors: [], authorDetails: [] }
  const lines = frontmatter.lines.slice(1, frontmatter.closingIndex)
  const title = lines
    .find((line) => /^title[ \t]*:/.test(line.content))
    ?.content.replace(/^title[ \t]*:[ \t]*/, '')
  const authorIndex = lines.findIndex((line) => /^author[ \t]*:/.test(line.content))
  const authors: string[] = []
  const authorDetails: PublicationAuthor[] = []

  if (authorIndex >= 0) {
    const inline = lines[authorIndex].content.replace(/^author[ \t]*:[ \t]*/, '')
    if (inline.trim()) {
      authors.push(...inlineAuthors(inline))
      authorDetails.push(...authors.map((name) => ({ name, affiliations: [] })))
    } else {
      let authorIndent: number | undefined
      const authorLines = lines.slice(authorIndex + 1)
      for (let index = 0; index < authorLines.length; index += 1) {
        const line = authorLines[index]
        if (topLevelKey(line)) break
        const item = line.content.match(/^(\s*)-\s*(?:name[ \t]*:[ \t]*)?(.+?)\s*$/)
        if (!item) continue
        const indent = item[1].length
        if (authorIndent === undefined) authorIndent = indent
        if (indent === authorIndent) {
          const author = scalar(splitYamlComment(item[2]).content)
          if (author) {
            const next = authorLines.findIndex((candidate, candidateIndex) => candidateIndex > index && (topLevelKey(candidate) || new RegExp(`^\\s{${indent}}-[ \\t]+`).test(candidate.content)))
            const end = next < 0 ? authorLines.length : next
            authors.push(author)
            authorDetails.push(authorDetailsFromBlock(authorLines, index, end, indent, author))
          }
        }
      }
    }
  }

  return {
    body: source.slice(frontmatter.lines[frontmatter.closingIndex].end),
    title: title === undefined ? undefined : scalar(splitYamlComment(title).content),
    authors,
    authorDetails,
  }
}

function normalizedPublicationAuthors(authors: PublicationAuthor[]) {
  if (authors.length > 100) throw new Error('A manuscript can contain at most 100 authors.')
  return authors.flatMap((author) => {
    const name = author.name.trim()
    if (!name) return []
    if (/\r|\n/.test(name) || name.length > 240) throw new Error('Author names must stay on one line and cannot exceed 240 characters.')
    const affiliations = author.affiliations.map((value) => value.trim()).filter(Boolean)
    if (affiliations.some((value) => /\r|\n/.test(value) || value.length > 300)) throw new Error('Each affiliation must stay on one line and cannot exceed 300 characters.')
    return [{ name, orcid: normalizePublicationOrcid(author.orcid ?? ''), affiliations }]
  })
}

function canonicalAuthorBlock(authors: PublicationAuthor[], ending: string) {
  const items = authors.map((author) => {
    const orcid = author.orcid ? `    orcid: ${quotedYaml(author.orcid)}${ending}` : ''
    const affiliations = author.affiliations.length
      ? `    affiliations:${ending}${author.affiliations.map((value) => `      - ${quotedYaml(value)}${ending}`).join('')}`
      : ''
    return `  - name: ${quotedYaml(author.name)}${ending}${orcid}${affiliations}`
  }).join('')
  return `author:${ending}${items}`
}

function enrichAuthorItem(raw: string, author: PublicationAuthor, ending: string) {
  const lines = sourceLines(raw)
  const first = lines[0]
  const match = first?.content.match(/^(\s*)-[ \t]+(?:(?:name)[ \t]*:[ \t]*)?(.*)$/)
  if (!first || !match) throw new Error('This manuscript uses author metadata that must be edited in the source inspector.')
  const itemIndent = match[1].length
  const directIndent = itemIndent + 2
  const value = splitYamlComment(match[2])
  const firstLine = `${match[1]}- name: ${quotedYaml(author.name)}${value.suffix}${first.ending || ending}`
  const kept: string[] = []
  let skipping = false
  for (const line of lines.slice(1)) {
    const indentation = line.content.search(/\S/)
    const directField = indentation === directIndent && /^\s*(?:orcid|affiliations?|affiliation)[ \t]*:/i.test(line.content)
    if (directField) {
      skipping = true
      continue
    }
    if (skipping && line.content.trim() && indentation <= directIndent) skipping = false
    if (!skipping) kept.push(line.raw)
  }
  const metadata = `${author.orcid ? `${' '.repeat(directIndent)}orcid: ${quotedYaml(author.orcid)}${ending}` : ''}${author.affiliations.length ? `${' '.repeat(directIndent)}affiliations:${ending}${author.affiliations.map((affiliation) => `${' '.repeat(directIndent + 2)}- ${quotedYaml(affiliation)}${ending}`).join('')}` : ''}`
  return `${firstLine}${metadata}${kept.join('')}`
}

export function updatePublicationAuthorDetails(
  source: string,
  authors: PublicationAuthor[],
  sourceIndexes?: Array<number | undefined>,
) {
  const normalized = normalizedPublicationAuthors(authors)
  const previous = parsePublicationMetadata(source).authorDetails
  const rich = [...normalized, ...previous].some((author) => Boolean(author.orcid || author.affiliations.length))
  const renamed = updatePublicationAuthors(source, normalized.map((author) => author.name), sourceIndexes)
  if (!rich || !normalized.length) return renamed
  const frontmatter = publicationFrontmatter(renamed)
  if (!frontmatter) return renamed
  const lines = frontmatter.lines.slice(1, frontmatter.closingIndex)
  const authorOffset = lines.findIndex((line) => /^author[ \t]*:/.test(line.content))
  if (authorOffset < 0) return renamed
  const authorLineIndex = authorOffset + 1
  const authorLine = frontmatter.lines[authorLineIndex]
  const fieldEndIndex = frontmatter.lines.findIndex((line, index) => index > authorLineIndex && index < frontmatter.closingIndex && topLevelKey(line))
  const fieldEnd = frontmatter.lines[fieldEndIndex < 0 ? frontmatter.closingIndex : fieldEndIndex].start
  const inline = splitYamlComment(authorLine.content.replace(/^author[ \t]*:[ \t]*/, '')).content.trim()
  if (inline) {
    const suffix = splitYamlComment(authorLine.content.replace(/^author[ \t]*:[ \t]*/, '')).suffix
    const replacement = `${canonicalAuthorBlock(normalized, frontmatter.ending).replace(/^author:/, `author:${suffix}`)}`
    return `${renamed.slice(0, authorLine.start)}${replacement}${renamed.slice(fieldEnd)}`
  }
  const fieldLines = frontmatter.lines.slice(authorLineIndex + 1, fieldEndIndex < 0 ? frontmatter.closingIndex : fieldEndIndex)
  const candidates = fieldLines.flatMap((line) => {
    const match = line.content.match(/^(\s*)-[ \t]+(?:(?:name)[ \t]*:[ \t]*)?(.*)$/)
    return match ? [{ line, indent: match[1].length }] : []
  })
  const itemIndent = candidates.length ? Math.min(...candidates.map((candidate) => candidate.indent)) : 2
  const starts = candidates.filter((candidate) => candidate.indent === itemIndent)
  const preambleEnd = starts[0]?.line.start ?? fieldEnd
  const preamble = renamed.slice(authorLine.end, preambleEnd)
  const blocks = starts.map((item, index) => renamed.slice(item.line.start, starts[index + 1]?.line.start ?? fieldEnd))
  const enriched = normalized.map((author, index) => enrichAuthorItem(blocks[index] ?? `  - name: ${quotedYaml(author.name)}${frontmatter.ending}`, author, frontmatter.ending)).join('')
  return `${renamed.slice(0, authorLine.start)}${authorLine.raw}${preamble}${enriched}${renamed.slice(fieldEnd)}`
}

/**
 * Updates only the supported author field while retaining every unrelated
 * frontmatter byte. Existing mapped-author subfields remain attached to the
 * same author when their displayed name changes.
 */
export function updatePublicationAuthors(source: string, authors: string[], sourceIndexes?: Array<number | undefined>) {
  const nextAuthors = normalizedAuthorEntries(authors, sourceIndexes)
  const names = nextAuthors.map((author) => author.name)
  const frontmatter = publicationFrontmatter(source)
  if (!frontmatter) {
    if (!nextAuthors.length) return source
    const ending = source.includes('\r\n') ? '\r\n' : source.includes('\r') ? '\r' : '\n'
    return `---${ending}${authorBlock(names, ending)}---${ending}${source ? ending : ''}${source}`
  }

  const yamlLines = frontmatter.lines.slice(1, frontmatter.closingIndex)
  const authorOffset = yamlLines.findIndex((line) => /^author[ \t]*:/.test(line.content))
  if (authorOffset < 0) {
    if (!nextAuthors.length) return source
    const insertion = frontmatter.lines[frontmatter.closingIndex].start
    const block = authorBlock(names, frontmatter.ending)
    return `${source.slice(0, insertion)}${block}${source.slice(insertion)}`
  }

  const authorLineIndex = authorOffset + 1
  const authorLine = frontmatter.lines[authorLineIndex]
  const fieldEndIndex = frontmatter.lines.findIndex((line, index) => index > authorLineIndex && index < frontmatter.closingIndex && topLevelKey(line))
  const fieldEnd = frontmatter.lines[fieldEndIndex < 0 ? frontmatter.closingIndex : fieldEndIndex].start
  if (!nextAuthors.length) return `${source.slice(0, authorLine.start)}${source.slice(fieldEnd)}`

  const inlineMatch = authorLine.content.match(/^(author[ \t]*:[ \t]*)(.*)$/)!
  if (splitYamlComment(inlineMatch[2]).content.trim()) {
    const value = splitYamlComment(inlineMatch[2])
    const replacement = `${inlineMatch[1]}[${names.map(quotedYaml).join(', ')}]${value.suffix}${authorLine.ending}`
    return `${source.slice(0, authorLine.start)}${replacement}${source.slice(authorLine.end)}`
  }

  const fieldLines = frontmatter.lines.slice(authorLineIndex + 1, fieldEndIndex < 0 ? frontmatter.closingIndex : fieldEndIndex)
  const candidates = fieldLines.flatMap((line) => {
    const match = line.content.match(/^([ \t]+)-[ \t]+(?:(?:name)[ \t]*:[ \t]*)?(.*)$/)
    return match ? [{ line, match, indent: match[1].length }] : []
  })
  const itemIndent = candidates.length ? Math.min(...candidates.map((candidate) => candidate.indent)) : undefined
  const starts = itemIndent === undefined ? [] : candidates.filter((candidate) => candidate.indent === itemIndent)
  const meaningfulUnknown = fieldLines.some((line) => line.content.trim() && !line.content.trimStart().startsWith('#') && !starts.some((item) => item.line.start === line.start) && (itemIndent === undefined || line.content.search(/\S/) <= itemIndent))
  if (!starts.length && meaningfulUnknown) throw new Error('This manuscript uses author metadata that must be edited in the source inspector.')

  const preambleEnd = starts[0]?.line.start ?? fieldEnd
  const preamble = source.slice(authorLine.end, preambleEnd)
  const existing = starts.map((item, index) => ({
    raw: source.slice(item.line.start, starts[index + 1]?.line.start ?? fieldEnd),
    mapped: /-[ \t]+name[ \t]*:/.test(item.line.content),
  }))
  const blocks = nextAuthors.map((author) => {
    const retained = author.sourceIndex === undefined ? undefined : existing[author.sourceIndex]
    if (retained) return updateAuthorItemName(retained.raw, author.name)
    const indent = ' '.repeat(itemIndent ?? 2)
    const mapped = existing[0]?.mapped ?? false
    return `${indent}- ${mapped ? 'name: ' : ''}${quotedYaml(author.name)}${frontmatter.ending}`
  })
  const replacement = `${authorLine.raw}${preamble}${blocks.join('')}`
  return `${source.slice(0, authorLine.start)}${replacement}${source.slice(fieldEnd)}`
}

export function removeDuplicateLeadingTitle(body: string, title?: string) {
  if (!title) return body
  const normalizedTitle = title.trim().replaceAll(/[`*_]/g, '').replaceAll(/\s+/g, ' ').toLocaleLowerCase()
  return body.replace(
    /^(\s*)#\s+(.+?)(?:\s+\{#[a-zA-Z][\w.:-]*[^}]*\})?\s*(\r?\n|$)/,
    (match, leading: string, heading: string, newline: string) => {
      const normalizedHeading = heading.trim().replaceAll(/[`*_]/g, '').replaceAll(/\s+/g, ' ').toLocaleLowerCase()
      return normalizedHeading === normalizedTitle ? leading + newline : match
    },
  )
}
