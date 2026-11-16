export type RecoveryDiffKind = 'equal' | 'removed' | 'added' | 'omitted'
export interface RecoveryDiffSegment { text: string; changed: boolean }
export interface RecoveryInlineDiffSegment { kind: 'equal' | 'removed' | 'added'; text: string }
export interface RecoveryDiffRow {
  kind: RecoveryDiffKind
  text: string
  oldLine?: number
  newLine?: number
  segments?: RecoveryDiffSegment[]
  inlineSegments?: RecoveryInlineDiffSegment[]
  pairedOldLine?: number
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

export const RECOVERY_DIFF_LIMITS = { characters: 200_000, lines: 4_000, cells: 300_000, rows: 500, wordCells: 10_000, wordSteps: 500_000, wordEdits: 256 } as const
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

interface WordBudget { remaining: number }
interface WordPath {
  x: number
  y: number
  startX: number
  startY: number
  previous?: WordPath
  kind?: 'removed' | 'added'
}

/** Small-edit Myers search: work follows edit distance rather than paragraph area. */
function wordOperations(before: readonly string[], after: readonly string[], budget: WordBudget): Operation[] | undefined {
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++
  let oldEnd = before.length, newEnd = after.length
  while (oldEnd > prefix && newEnd > prefix && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd-- }
  const oldSize = oldEnd - prefix, newSize = newEnd - prefix
  const result: Operation[] = Array.from({ length: prefix }, (_, index) => ({ kind: 'equal', old: index, next: index }))
  if (!oldSize || !newSize) {
    for (let old = prefix; old < oldEnd; old++) result.push({ kind: 'removed', old })
    for (let next = prefix; next < newEnd; next++) result.push({ kind: 'added', next })
  } else if (oldSize * newSize <= RECOVERY_DIFF_LIMITS.wordCells && oldSize * newSize <= budget.remaining) {
    budget.remaining -= oldSize * newSize
    result.push(...operations(before.slice(prefix, oldEnd), after.slice(prefix, newEnd), RECOVERY_DIFF_LIMITS.wordCells).operations.map((operation) => ({
      kind: operation.kind,
      ...(operation.old !== undefined ? { old: operation.old + prefix } : {}),
      ...(operation.next !== undefined ? { next: operation.next + prefix } : {}),
    })))
  } else {
    let frontier = new Map<number, WordPath>([[0, { x: 0, y: 0, startX: 0, startY: 0 }]])
    let completed: WordPath | undefined
    for (let distance = 1; distance <= Math.min(oldSize + newSize, RECOVERY_DIFF_LIMITS.wordEdits) && !completed; distance++) {
      const nextFrontier = new Map<number, WordPath>()
      for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
        if (--budget.remaining < 0) return undefined
        const deletion = frontier.get(diagonal - 1), insertion = frontier.get(diagonal + 1)
        const canDelete = deletion !== undefined && deletion.x < oldSize
        const canInsert = insertion !== undefined && insertion.y < newSize
        if (!canDelete && !canInsert) continue
        const remove = canDelete && (!canInsert || deletion.x + 1 >= insertion!.x)
        const previous = remove ? deletion! : insertion!
        let x = previous.x + (remove ? 1 : 0), y = previous.y + (remove ? 0 : 1)
        const startX = x, startY = y
        while (x < oldSize && y < newSize && before[prefix + x] === after[prefix + y]) {
          if (--budget.remaining < 0) return undefined
          x++; y++
        }
        const path: WordPath = { x, y, startX, startY, previous, kind: remove ? 'removed' : 'added' }
        nextFrontier.set(diagonal, path)
        if (x === oldSize && y === newSize) { completed = path; break }
      }
      frontier = nextFrontier
    }
    if (!completed) return undefined
    const reversed: Operation[] = []
    for (let path: WordPath | undefined = completed; path?.previous; path = path.previous) {
      for (let x = path.x, y = path.y; x > path.startX && y > path.startY;) {
        reversed.push({ kind: 'equal', old: prefix + --x, next: prefix + --y })
      }
      reversed.push(path.kind === 'removed'
        ? { kind: 'removed', old: prefix + path.startX - 1 }
        : { kind: 'added', next: prefix + path.startY - 1 })
    }
    for (let index = reversed.length - 1; index >= 0; index--) result.push(reversed[index])
  }
  for (let old = oldEnd, next = newEnd; old < before.length; old++, next++) result.push({ kind: 'equal', old, next })
  // Both sides reconstruct identically either way, but old → new is clearer for replacements.
  const ordered: Operation[] = []
  for (let index = 0; index < result.length;) {
    if (result[index].kind === 'equal') { ordered.push(result[index++]); continue }
    let end = index + 1
    while (end < result.length && result[end].kind !== 'equal') end++
    for (let part = index; part < end; part++) if (result[part].kind === 'removed') ordered.push(result[part])
    for (let part = index; part < end; part++) if (result[part].kind === 'added') ordered.push(result[part])
    index = end
  }
  return ordered
}

function wordSegments(before: string, after: string, budget: WordBudget) {
  const tokenize = (value: string) => value.match(/\s+|[\p{L}\p{M}\p{N}_]+|[^\s]/gu) ?? []
  const oldWords = tokenize(before), newWords = tokenize(after)
  const changes = wordOperations(oldWords, newWords, budget)
  if (!changes) return undefined
  const oldSegments: RecoveryDiffSegment[] = [], newSegments: RecoveryDiffSegment[] = []
  const inline: RecoveryInlineDiffSegment[] = []
  const append = (segments: RecoveryDiffSegment[], text: string, changed: boolean) => {
    if (segments.at(-1)?.changed === changed) segments[segments.length - 1].text += text
    else segments.push({ text, changed })
  }
  for (const change of changes) {
    if (change.old !== undefined) append(oldSegments, oldWords[change.old], change.kind !== 'equal')
    if (change.next !== undefined) append(newSegments, newWords[change.next], change.kind !== 'equal')
    const text = change.kind === 'added' ? newWords[change.next!] : oldWords[change.old!]
    if (inline.at(-1)?.kind === change.kind) inline[inline.length - 1].text += text
    else inline.push({ kind: change.kind, text })
  }
  return { before: oldSegments, after: newSegments, inline }
}

/** Bounded, order-preserving pairing avoids treating a newly inserted line as an old paragraph. */
function pairedLines(removed: readonly RecoveryDiffRow[], added: readonly RecoveryDiffRow[], budget: WordBudget): Array<[number, number]> {
  if (removed.length === 1 && added.length === 1) return [[0, 0]]
  const fingerprints = new Map<string, { words: Map<string, number>; count: number }>()
  const fingerprint = (text: string) => {
    let value = fingerprints.get(text)
    if (!value) {
      const words = new Map<string, number>()
      const tokens = text.match(/[\p{L}\p{M}\p{N}_]+/gu) ?? []
      for (const token of tokens) words.set(token, (words.get(token) ?? 0) + 1)
      value = { words, count: tokens.length }; fingerprints.set(text, value)
    }
    return value
  }
  const similarity = (before: string, after: string) => {
    if (before === after) return 1
    if (budget.remaining <= 0) return 0
    const old = fingerprint(before), next = fingerprint(after)
    const [small, large] = old.words.size < next.words.size ? [old.words, next.words] : [next.words, old.words]
    let shared = 0
    for (const [word, count] of small) {
      if (--budget.remaining < 0) return 0
      shared += Math.min(count, large.get(word) ?? 0)
    }
    return old.count + next.count ? 2 * shared / (old.count + next.count) : 0
  }
  const candidates: Array<{ old: number; next: number; score: number }> = []
  const allCandidates = removed.length * added.length <= 64
  for (let old = 0; old < removed.length; old++) {
    for (let next = allCandidates ? 0 : old; next < (allCandidates ? added.length : Math.min(added.length, old + 1)); next++) {
      const score = similarity(removed[old].text, added[next].text)
      if (score >= 0.35) candidates.push({ old, next, score })
    }
  }
  candidates.sort((left, right) => right.score - left.score || Math.abs(left.old - left.next) - Math.abs(right.old - right.next) || left.old - right.old || left.next - right.next)
  const pairs: Array<[number, number]> = []
  for (const candidate of candidates) {
    if (pairs.some(([old, next]) => old === candidate.old || next === candidate.next || (old - candidate.old) * (next - candidate.next) < 0)) continue
    pairs.push([candidate.old, candidate.next])
  }
  return pairs.sort((left, right) => left[0] - right[0])
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
  const wordBudget: WordBudget = { remaining: RECOVERY_DIFF_LIMITS.wordSteps }
  let wordFallback = false
  // Pair neighboring removed/added blocks only for inline emphasis, never for identity.
  for (let index = 0; index < rows.length;) {
    if (rows[index].kind !== 'removed') { index++; continue }
    const removedStart = index
    while (index < rows.length && rows[index].kind === 'removed') index++
    const addedStart = index
    while (index < rows.length && rows[index].kind === 'added') index++
    for (const [old, next] of pairedLines(rows.slice(removedStart, addedStart), rows.slice(addedStart, index), wordBudget)) {
      const before = rows[removedStart + old], after = rows[addedStart + next]
      const emphasis = wordSegments(before.text, after.text, wordBudget)
      if (emphasis) {
        before.segments = emphasis.before; after.segments = emphasis.after
        after.inlineSegments = emphasis.inline; after.pairedOldLine = before.oldLine
      } else wordFallback = true
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
  if (wordFallback || wordBudget.remaining < 0) notices.push('Some extensively rewritten text is shown as whole removed and added lines because word-level comparison reached its work limit.')
  if (truncated) notices.push('Comparison preview limited to 200,000 characters and 4,000 lines per version, with at most 500 displayed rows. Some changes may not be shown.')
  return {
    changed: true, rows: compact.slice(0, RECOVERY_DIFF_LIMITS.rows),
    addedLines: rows.filter((row) => row.kind === 'added').length,
    removedLines: rows.filter((row) => row.kind === 'removed').length,
    strategy: compared.coarse ? 'blocks' : 'lines', truncated, notices,
  }
}
