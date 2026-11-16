export type RecoveryDiffKind = 'equal' | 'removed' | 'added' | 'omitted'
export interface RecoveryDiffSegment { text: string; changed: boolean }
export interface RecoveryDiffRow {
  kind: RecoveryDiffKind
  text: string
  oldLine?: number
  newLine?: number
  segments?: RecoveryDiffSegment[]
  ending?: 'LF' | 'CRLF' | 'CR' | 'No newline'
}
export interface RecoveryDiff {
  changed: boolean
  rows: RecoveryDiffRow[]
  addedLines: number
  removedLines: number
  strategy: 'lines' | 'blocks'
  truncated: boolean
  notices: string[]
}

export const RECOVERY_DIFF_LIMITS = { characters: 200_000, lines: 4_000, cells: 300_000, rows: 500, wordCells: 10_000 } as const
interface SourceLine { raw: string; text: string; ending: RecoveryDiffRow['ending'] }
interface Operation { kind: 'equal' | 'removed' | 'added'; old?: number; next?: number }

function lineStart(text: string, position: number) {
  if (position <= 0) return 0
  let start = Math.max(text.lastIndexOf('\n', position - 1), text.lastIndexOf('\r', position - 1)) + 1
  // A common character prefix can stop between CR and LF. Keep the whole line.
  if (start && text[start - 1] === '\r' && text[start] === '\n') {
    start = start <= 1 ? 0 : Math.max(text.lastIndexOf('\n', start - 2), text.lastIndexOf('\r', start - 2)) + 1
  }
  return start
}
function previousLine(text: string, position: number) {
  let end = position
  if (text[end - 1] === '\n') { end--; if (text[end - 1] === '\r') end-- }
  else if (text[end - 1] === '\r') end--
  if (end <= 0) return 0
  return Math.max(text.lastIndexOf('\n', end - 1), text.lastIndexOf('\r', end - 1)) + 1
}
function nextLine(text: string, position: number) {
  let end = position
  while (end < text.length && text[end] !== '\n' && text[end] !== '\r') end++
  if (text[end] === '\r' && text[end + 1] === '\n') return end + 2
  return end < text.length ? end + 1 : end
}
function lineNumber(text: string, position: number) {
  let line = 1
  for (let index = 0; index < position; index++) {
    if (text[index] === '\r') { line++; if (text[index + 1] === '\n') index++ }
    else if (text[index] === '\n') line++
  }
  return line
}
function sourceLines(text: string, start: number, end: number) {
  const lines: SourceLine[] = []
  const limit = Math.min(end, start + RECOVERY_DIFF_LIMITS.characters)
  let position = start
  while (position < limit && lines.length < RECOVERY_DIFF_LIMITS.lines) {
    const stop = Math.min(nextLine(text, position), limit)
    const raw = text.slice(position, stop)
    const ending = raw.endsWith('\r\n') ? 'CRLF' : raw.endsWith('\n') ? 'LF' : raw.endsWith('\r') ? 'CR' : 'No newline'
    lines.push({ raw, text: raw.replace(/(?:\r\n|\n|\r)$/, ''), ending })
    position = stop
  }
  return { lines, truncated: position < end }
}

/** Bounded LCS; broad changes fall back to explicit removed/added blocks. */
function operations(before: readonly string[], after: readonly string[], cellLimit: number): { operations: Operation[]; coarse: boolean } {
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++
  let oldEnd = before.length, newEnd = after.length
  while (oldEnd > prefix && newEnd > prefix && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd-- }
  const result: Operation[] = Array.from({ length: prefix }, (_, index) => ({ kind: 'equal', old: index, next: index }))
  const oldSize = oldEnd - prefix, newSize = newEnd - prefix
  const coarse = oldSize * newSize > cellLimit
  if (coarse || !oldSize || !newSize) {
    for (let index = prefix; index < oldEnd; index++) result.push({ kind: 'removed', old: index })
    for (let index = prefix; index < newEnd; index++) result.push({ kind: 'added', next: index })
  } else {
    const width = newSize + 1
    const matrix = new Uint16Array((oldSize + 1) * width)
    for (let old = oldSize - 1; old >= 0; old--) {
      for (let next = newSize - 1; next >= 0; next--) {
        matrix[old * width + next] = before[old + prefix] === after[next + prefix]
          ? matrix[(old + 1) * width + next + 1] + 1
          : Math.max(matrix[(old + 1) * width + next], matrix[old * width + next + 1])
      }
    }
    let old = 0, next = 0
    while (old < oldSize || next < newSize) {
      if (old < oldSize && next < newSize && before[old + prefix] === after[next + prefix]) {
        result.push({ kind: 'equal', old: old++ + prefix, next: next++ + prefix })
      } else if (old < oldSize && (next === newSize || matrix[(old + 1) * width + next] >= matrix[old * width + next + 1])) {
        result.push({ kind: 'removed', old: old++ + prefix })
      } else result.push({ kind: 'added', next: next++ + prefix })
    }
  }
  for (let old = oldEnd, next = newEnd; old < before.length; old++, next++) result.push({ kind: 'equal', old, next })
  return { operations: result, coarse }
}

function wordSegments(before: string, after: string) {
  if (before.length > 2_000 || after.length > 2_000) return undefined
  const tokenize = (value: string) => value.match(/\s+|[\p{L}\p{M}\p{N}_]+|[^\s]/gu) ?? []
  const oldWords = tokenize(before), newWords = tokenize(after)
  if (oldWords.length * newWords.length > RECOVERY_DIFF_LIMITS.wordCells) return undefined
  const changes = operations(oldWords, newWords, RECOVERY_DIFF_LIMITS.wordCells).operations
  const oldSegments: RecoveryDiffSegment[] = [], newSegments: RecoveryDiffSegment[] = []
  const append = (segments: RecoveryDiffSegment[], text: string, changed: boolean) => {
    if (segments.at(-1)?.changed === changed) segments[segments.length - 1].text += text
    else segments.push({ text, changed })
  }
  for (const change of changes) {
    if (change.old !== undefined) append(oldSegments, oldWords[change.old], change.kind !== 'equal')
    if (change.next !== undefined) append(newSegments, newWords[change.next], change.kind !== 'equal')
  }
  return { before: oldSegments, after: newSegments }
}

function compactContext(rows: RecoveryDiffRow[]) {
  const result: RecoveryDiffRow[] = []
  for (let index = 0; index < rows.length;) {
    if (rows[index].kind !== 'equal') { result.push(rows[index++]); continue }
    let end = index + 1
    while (end < rows.length && rows[end].kind === 'equal') end++
    if (end - index <= 6) result.push(...rows.slice(index, end))
    else {
      result.push(...rows.slice(index, index + 2))
      result.push({ kind: 'omitted', text: `${end - index - 4} unchanged lines omitted` })
      result.push(...rows.slice(end - 2, end))
    }
    index = end
  }
  return result
}

/** Compare selected source to current source. Output is a bounded, escaped-text preview. */
export function compareRecoverySources(previousSource: string, currentSource: string): RecoveryDiff {
  const empty: RecoveryDiff = { changed: previousSource !== currentSource, rows: [], addedLines: 0, removedLines: 0, strategy: 'lines', truncated: false, notices: [] }
  if (!empty.changed) return empty
  let prefix = 0
  while (prefix < previousSource.length && prefix < currentSource.length && previousSource[prefix] === currentSource[prefix]) prefix++
  let oldEnd = previousSource.length, newEnd = currentSource.length
  while (oldEnd > prefix && newEnd > prefix && previousSource[oldEnd - 1] === currentSource[newEnd - 1]) { oldEnd--; newEnd-- }
  let start = Math.min(lineStart(previousSource, prefix), lineStart(currentSource, prefix))
  for (let context = 0; context < 2 && start; context++) start = previousLine(previousSource, start)
  oldEnd = nextLine(previousSource, oldEnd)
  newEnd = nextLine(currentSource, newEnd)
  for (let context = 0; context < 2; context++) { oldEnd = nextLine(previousSource, oldEnd); newEnd = nextLine(currentSource, newEnd) }
  const oldWindow = sourceLines(previousSource, start, oldEnd), newWindow = sourceLines(currentSource, start, newEnd)
  const oldLines = oldWindow.lines, newLines = newWindow.lines
  const compared = operations(oldLines.map((line) => line.raw), newLines.map((line) => line.raw), RECOVERY_DIFF_LIMITS.cells)
  const oldBase = lineNumber(previousSource, start), newBase = lineNumber(currentSource, start)
  const rows: RecoveryDiffRow[] = compared.operations.map((change) => ({
    kind: change.kind,
    text: (change.old !== undefined ? oldLines[change.old] : newLines[change.next!]).text,
    ...(change.old !== undefined ? { oldLine: oldBase + change.old } : {}),
    ...(change.next !== undefined ? { newLine: newBase + change.next } : {}),
  }))
  // Pair neighboring removed/added blocks only for inline emphasis, never for identity.
  for (let index = 0; index < rows.length;) {
    if (rows[index].kind !== 'removed') { index++; continue }
    const removedStart = index
    while (index < rows.length && rows[index].kind === 'removed') index++
    const addedStart = index
    while (index < rows.length && rows[index].kind === 'added') index++
    for (let offset = 0; offset < Math.min(addedStart - removedStart, index - addedStart); offset++) {
      const before = rows[removedStart + offset], after = rows[addedStart + offset]
      const emphasis = wordSegments(before.text, after.text)
      if (emphasis) { before.segments = emphasis.before; after.segments = emphasis.after }
      const oldEnding = oldLines[before.oldLine! - oldBase].ending, newEnding = newLines[after.newLine! - newBase].ending
      if (oldEnding !== newEnding) { before.ending = oldEnding; after.ending = newEnding }
    }
  }
  const compact = compactContext(rows)
  const truncated = oldWindow.truncated || newWindow.truncated || compact.length > RECOVERY_DIFF_LIMITS.rows
  const notices: string[] = []
  if (start > 0) notices.push(`${oldBase - 1} unchanged lines before this region are omitted.`)
  if (oldEnd < previousSource.length || newEnd < currentSource.length) notices.push('Unchanged text after this region is omitted.')
  if (compared.coarse) notices.push('This large changed region is shown as removed and added blocks, rather than a minimal line diff.')
  if (truncated) notices.push('Comparison preview limited to 200,000 characters and 4,000 lines per version, with at most 500 displayed rows. Some changes may not be shown.')
  return {
    changed: true, rows: compact.slice(0, RECOVERY_DIFF_LIMITS.rows),
    addedLines: rows.filter((row) => row.kind === 'added').length,
    removedLines: rows.filter((row) => row.kind === 'removed').length,
    strategy: compared.coarse ? 'blocks' : 'lines', truncated, notices,
  }
}
