export interface PublicationMetadata {
  title?: string
  authors: string[]
  body: string
}

function scalar(value: string) {
  return value.trim().replace(/^(["'])(.*)\1$/, '$2')
}

function inlineAuthors(value: string) {
  const trimmed = value.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return [scalar(trimmed)]
  return trimmed
    .slice(1, -1)
    .split(',')
    .map(scalar)
    .filter(Boolean)
}

export function parsePublicationMetadata(source: string): PublicationMetadata {
  const match = source.match(/^---(?:\r\n|\n|\r)([\s\S]*?)(?:\r\n|\n|\r)---(?:\r\n|\n|\r|$)/)
  if (!match) return { body: source, authors: [] }

  const yaml = match[1]
  const lines = yaml.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')
  const title = lines
    .find((line) => /^title[ \t]*:/.test(line))
    ?.replace(/^title[ \t]*:[ \t]*/, '')
  const authorIndex = lines.findIndex((line) => /^author[ \t]*:/.test(line))
  const authors: string[] = []

  if (authorIndex >= 0) {
    const inline = lines[authorIndex].replace(/^author[ \t]*:[ \t]*/, '')
    if (inline.trim()) {
      authors.push(...inlineAuthors(inline))
    } else {
      let authorIndent: number | undefined
      for (const line of lines.slice(authorIndex + 1)) {
        if (/^[^\s#][^:]*:/.test(line)) break
        const item = line.match(/^(\s*)-\s*(?:name[ \t]*:[ \t]*)?(.+?)\s*$/)
        if (!item) continue
        const indent = item[1].length
        if (authorIndent === undefined) authorIndent = indent
        if (indent === authorIndent) authors.push(scalar(item[2]))
      }
    }
  }

  return {
    body: source.slice(match[0].length),
    title: title === undefined ? undefined : scalar(title),
    authors,
  }
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
