export interface PublicationMetadata {
  title?: string
  authors: string[]
  body: string
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
  if (!frontmatter) return { body: source, authors: [] }
  const lines = frontmatter.lines.slice(1, frontmatter.closingIndex)
  const title = lines
    .find((line) => /^title[ \t]*:/.test(line.content))
    ?.content.replace(/^title[ \t]*:[ \t]*/, '')
  const authorIndex = lines.findIndex((line) => /^author[ \t]*:/.test(line.content))
  const authors: string[] = []

  if (authorIndex >= 0) {
    const inline = lines[authorIndex].content.replace(/^author[ \t]*:[ \t]*/, '')
    if (inline.trim()) {
      authors.push(...inlineAuthors(inline))
    } else {
      let authorIndent: number | undefined
      for (const line of lines.slice(authorIndex + 1)) {
        if (topLevelKey(line)) break
        const item = line.content.match(/^(\s*)-\s*(?:name[ \t]*:[ \t]*)?(.+?)\s*$/)
        if (!item) continue
        const indent = item[1].length
        if (authorIndent === undefined) authorIndent = indent
        if (indent === authorIndent) {
          const author = scalar(splitYamlComment(item[2]).content)
          if (author) authors.push(author)
        }
      }
    }
  }

  return {
    body: source.slice(frontmatter.lines[frontmatter.closingIndex].end),
    title: title === undefined ? undefined : scalar(splitYamlComment(title).content),
    authors,
  }
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
