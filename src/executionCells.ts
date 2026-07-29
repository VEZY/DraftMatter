import type { Code, Root, RootContent } from 'mdast'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import type { DocumentDiagnostic } from './types'

export type ExecutionLanguage = 'python' | 'r' | 'julia'
export type ExecutionCellRole = 'setup' | 'figure' | 'table' | 'values' | 'ordinary'

export interface ExecutableCell {
  id: string
  language: ExecutionLanguage
  source: string
  sourceHash: string
  role: ExecutionCellRole
  attributes: Record<string, string | true>
  classes: string[]
  position: {
    startOffset: number
    endOffset: number
    startLine: number
    endLine: number
  }
}

export interface ExecutableCellResult {
  cells: ExecutableCell[]
  diagnostics: DocumentDiagnostic[]
}

interface SourceRange {
  start: number
  end: number
}

function sourceHash(value: string) {
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte)
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return `fnv1a:${hash.toString(16).padStart(16, '0')}`
}

function excludedDivRanges(source: string) {
  const ranges: SourceRange[] = []
  const stack: Array<{ length: number; start: number; excluded: boolean }> = []
  let offset = 0
  for (const line of source.split(/(?<=\n)/)) {
    const content = line.replace(/\r?\n$/, '')
    const match = content.match(/^\s*(:{3,})\s*(\{.*\})?\s*$/)
    if (match) {
      const attributes = match[2]
      if (attributes) {
        const parentExcluded = stack.some((entry) => entry.excluded)
        const rawFormat = /^\{\s*=[A-Za-z0-9_+-]+\s*\}$/.test(attributes)
        const excluded = parentExcluded
          || rawFormat
          || /(?:^|[\s{])\.(?:draftmatter-reviews|dm-proposal|dm-message|raw)(?:[\s}])/i.test(attributes)
        stack.push({ length: match[1].length, start: offset, excluded })
      } else {
        const opening = stack.at(-1)
        if (opening && match[1].length >= opening.length) {
          stack.pop()
          if (opening.excluded) ranges.push({ start: opening.start, end: offset + line.length })
        }
      }
    }
    offset += line.length
  }
  for (const opening of stack) if (opening.excluded) ranges.push({ start: opening.start, end: source.length })
  return ranges
}

function parseInfo(code: Code) {
  const rawLanguage = (code.lang ?? '').trim()
  const closedEngine = rawLanguage.match(/^\{(\.?)(python3?|r|julia)\}$/i)
  const rawInfo = [rawLanguage, code.meta].filter(Boolean).join(' ').trim()
  const bracedInfo = !closedEngine && rawInfo.startsWith('{') && rawInfo.endsWith('}')
  const info = closedEngine
    ? (code.meta ?? '')
    : bracedInfo
      ? rawInfo.slice(1, -1).trim()
      : rawInfo
  const tokens = info.match(/[#.][^\s}]+|[A-Za-z][\w-]*(?:=(?:"[^"]*"|'[^']*'|[^\s}]+))?/g) ?? []
  const languageToken = closedEngine ? `${closedEngine[1]}${closedEngine[2]}` : tokens.shift() ?? ''
  const languageName = languageToken.replace(/^\./, '').toLowerCase()
  const language = languageName === 'python' || languageName === 'python3'
    ? 'python' as const
    : languageName === 'r'
      ? 'r' as const
      : languageName === 'julia'
        ? 'julia' as const
        : undefined
  const classes: string[] = []
  const attributes: Record<string, string | true> = {}
  let explicitId: string | undefined
  for (const token of tokens) {
    if (token.startsWith('#')) explicitId = token.slice(1)
    else if (token.startsWith('.')) classes.push(token.slice(1))
    else {
      const [name, rawValue] = token.split(/=(.*)/s)
      attributes[name] = rawValue === undefined ? true : rawValue.replace(/^(?:"(.*)"|'(.*)')$/, '$1$2')
    }
  }
  const explicitlyDisabled = attributes.execute === 'false'
  const bracedEngine = (Boolean(closedEngine) || bracedInfo) && !languageToken.startsWith('.')
  return {
    language,
    classes,
    attributes,
    explicitId,
    executable: !explicitlyDisabled && (bracedEngine || classes.includes('execute') || attributes.execute === true || attributes.execute === 'true'),
  }
}

function codeNodes(tree: Root) {
  const nodes: Code[] = []
  const visit = (node: Root | RootContent) => {
    if (node.type === 'code') nodes.push(node)
    if ('children' in node) for (const child of node.children) visit(child as RootContent)
  }
  visit(tree)
  return nodes
}

function safeExplicitId(value?: string) {
  return value && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(value) ? value : undefined
}

function cellRole(attributes: Record<string, string | true>): ExecutionCellRole {
  const explicit = attributes.role
  if (explicit === 'setup' || explicit === 'figure' || explicit === 'table' || explicit === 'values') return explicit
  const output = attributes.output
  return output === 'figure' || output === 'table' || output === 'values' ? output : 'ordinary'
}

export function isSetupCell(cell: Pick<ExecutableCell, 'role'>) {
  return cell.role === 'setup'
}

export function isPanelManagedCell(cell: Pick<ExecutableCell, 'role'>) {
  return cell.role === 'setup' || cell.role === 'values'
}

export function extractExecutableCells(source: string): ExecutableCellResult {
  const tree = unified().use(remarkParse).parse(source) as Root
  const excluded = excludedDivRanges(source)
  const diagnostics: DocumentDiagnostic[] = []
  const ids = new Map<string, number>()
  const cells = codeNodes(tree).flatMap<ExecutableCell>((node) => {
    const startOffset = node.position?.start.offset
    const endOffset = node.position?.end.offset
    if (startOffset === undefined || endOffset === undefined || excluded.some((range) => startOffset >= range.start && startOffset < range.end)) return []
    const info = parseInfo(node)
    if (!info.language || !info.executable) return []
    const normalizedSource = node.value.replace(/\r\n?/g, '\n')
    if (info.explicitId && !safeExplicitId(info.explicitId)) diagnostics.push({
      code: `execution-cell-id-invalid-${node.position?.start.line ?? startOffset}`,
      level: 'error',
      message: `Executable cell at line ${node.position?.start.line ?? '?'} has an unsafe explicit id and received a generated id.`,
    })
    const baseId = safeExplicitId(info.explicitId) ?? `cell-${info.language}-${sourceHash(`${info.language}\u0000${normalizedSource}`).slice(-12)}`
    const occurrence = (ids.get(baseId.toLowerCase()) ?? 0) + 1
    ids.set(baseId.toLowerCase(), occurrence)
    const id = occurrence === 1 ? baseId : `${baseId}-${occurrence}`
    if (occurrence > 1) diagnostics.push({
      code: `execution-cell-id-duplicate-${baseId.toLowerCase()}`,
      level: 'error',
      message: `Executable cell id ${baseId} is duplicated; ${id} is used in memory until the source is corrected.`,
    })
    return [{
      id,
      language: info.language,
      source: normalizedSource,
      sourceHash: sourceHash(normalizedSource),
      role: cellRole(info.attributes),
      attributes: info.attributes,
      classes: info.classes,
      position: {
        startOffset,
        endOffset,
        startLine: node.position!.start.line,
        endLine: node.position!.end.line,
      },
    }]
  })
  return { cells, diagnostics }
}
