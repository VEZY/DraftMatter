export interface ResolvedFootnote {
  label: string
  number: number
  content: string
  missing: boolean
}

export interface ResolvedFootnoteDocument {
  body: string
  numbers: Record<string, number>
  footnotes: ResolvedFootnote[]
}

const labelPattern = '[a-zA-Z0-9_.:-]+'
const definitionPattern = new RegExp(`^\\s*\\[\\^(${labelPattern})\\]:\\s*(.*)$`)
const referencePattern = new RegExp(`\\[\\^(${labelPattern})\\]`, 'g')

function lineOutsideFences(lines: string[]) {
  const outside: boolean[] = []
  let fence: { marker: string; length: number } | undefined
  for (const line of lines) {
    if (fence) {
      outside.push(false)
      if (new RegExp(`^\\s*${fence.marker}{${fence.length},}\\s*$`).test(line)) fence = undefined
      continue
    }
    const opener = line.match(/^\s*(`{3,}|~{3,})/)
    if (opener) {
      outside.push(false)
      fence = { marker: opener[1][0], length: opener[1].length }
      continue
    }
    outside.push(true)
  }
  return outside
}

export function resolveFootnotes(source: string): ResolvedFootnoteDocument {
  const lines = source.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')
  const definitions = new Map<string, string>()
  const removed = new Set<number>()
  const outsideFences = lineOutsideFences(lines)

  for (let index = 0; index < lines.length; index += 1) {
    if (!outsideFences[index]) continue
    const definition = lines[index].match(definitionPattern)
    if (!definition) continue
    const content = [definition[2]]
    removed.add(index)
    let cursor = index + 1
    while (cursor < lines.length && outsideFences[cursor] && /^\s{2,}\S/.test(lines[cursor])) {
      content.push(lines[cursor].trim())
      removed.add(cursor)
      cursor += 1
    }
    if (!definitions.has(definition[1])) {
      definitions.set(definition[1], content.filter(Boolean).join(' '))
    }
    index = cursor - 1
  }

  const bodyLines = lines.map((line, index) => removed.has(index) ? '' : line)
  const body = bodyLines.join('\n')
  const orderedLabels: string[] = []
  for (let index = 0; index < bodyLines.length; index += 1) {
    if (!outsideFences[index]) continue
    const searchable = bodyLines[index].replace(/`[^`\r\n]*`/g, '')
    for (const match of searchable.matchAll(referencePattern)) {
      if (!orderedLabels.includes(match[1])) orderedLabels.push(match[1])
    }
  }
  const numbers = Object.fromEntries(orderedLabels.map((label, index) => [label, index + 1]))
  const footnotes = orderedLabels.map((label, index) => ({
    label,
    number: index + 1,
    content: definitions.get(label) ?? `Missing footnote definition for “${label}”.`,
    missing: !definitions.has(label),
  }))
  return { body, numbers, footnotes }
}
