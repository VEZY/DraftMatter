import type * as Y from 'yjs'

// Keeping original and proposed wording in distinct runs makes independent
// offline accepts idempotent and preserves the original character identities.
const original = 'dm-original:'
const proposed = 'dm-proposed:'
const legacyInsertionMarker = 'legacy-insertion'
type Attributes = Record<string, unknown>
export function hasReviewTextAttributes(attributes?: Attributes) {
  return Object.keys(attributes ?? {}).some((key) => key.startsWith(original) || key.startsWith(proposed))
}

interface Run { raw: number; visible: number; value: string; attributes: Attributes; shown: boolean }

export class ReviewText {
  readonly source: string
  readonly represented = new Set<string>()
  readonly overlappingAcceptances: Set<string>
  private readonly overlappingRuns = new Map<string, string>()
  private readonly runs: Run[] = []

  constructor(private readonly text: Y.Text, isAccepted: (changeId: string) => boolean, selectedRuns: Map<string, string>, overlapping: Set<string>) {
    this.overlappingAcceptances = overlapping
    const delta: { insert: string; attributes?: Attributes }[] = text.toDelta()
    const winners = new Map<string, string>()
    for (const part of delta) {
      const acceptedOriginals: string[] = []
      for (const [key, token] of Object.entries(part.attributes ?? {})) {
        if (key.startsWith(original)) {
          const id = key.slice(original.length)
          this.represented.add(id)
          if (isAccepted(id)) acceptedOriginals.push(id)
        }
        if (!key.startsWith(proposed) || typeof token !== 'string') continue
        this.represented.add(key.slice(proposed.length))
        if (token === legacyInsertionMarker) continue
        if (!winners.has(key) || token < winners.get(key)!) winners.set(key, token)
      }
      if (acceptedOriginals.length > 1) acceptedOriginals.forEach((id) => overlapping.add(id))
    }
    for (const id of overlapping) {
      const choice = selectedRuns.get(id) ?? winners.get(proposed + id)
      if (choice) this.overlappingRuns.set(id, choice)
    }
    const selected = (id: string) => !overlapping.has(id) && isAccepted(id)
    let raw = 0
    let source = ''
    for (const part of delta) {
      const attributes = part.attributes ?? {}
      const shown = Object.entries(attributes).every(([key, value]) =>
        key.startsWith(original) ? !selected(key.slice(original.length)) :
        key.startsWith(proposed) ? selected(key.slice(proposed.length)) && (selectedRuns.get(key.slice(proposed.length)) ?? winners.get(key)) === value : true)
      this.runs.push({ raw, visible: source.length, value: part.insert, attributes, shown })
      if (shown) source += part.insert
      raw += part.insert.length
    }
    this.source = source
  }

  visibleWording(changeId: string) {
    if (this.overlappingAcceptances.has(changeId)) {
      const token = this.overlappingRuns.get(changeId)
      return token ? this.runs.filter((run) => run.attributes[proposed + changeId] === token).map((run) => run.value).join('') : ''
    }
    return this.runs.filter((run) => run.shown && (original + changeId in run.attributes || proposed + changeId in run.attributes))
      .map((run) => run.value).join('')
  }

  rawOffset(index: number) {
    const run = this.runs.find((run) => run.shown && index < run.visible + run.value.length)
    return run ? run.raw + index - run.visible : this.text.length
  }

  visibleOffset(raw: number) {
    const run = this.runs.find((run) => raw < run.raw + run.value.length)
    return run ? run.visible + (run.shown ? raw - run.raw : 0) : this.source.length
  }

  private ranges(start: number, end: number) {
    return this.runs.flatMap((run) => {
      if (!run.shown) return []
      const from = Math.max(start, run.visible) - run.visible
      const to = Math.min(end, run.visible + run.value.length) - run.visible
      return to > from ? [{ raw: run.raw + from, count: to - from, attributes: run.attributes }] : []
    })
  }

  edit(start: number, end: number, replacement: string) {
    const raw = this.rawOffset(start)
    const ranges = this.ranges(start, end)
    const within = this.runs.find((run) => run.shown && start > run.visible && start < run.visible + run.value.length)
    const attributes = ranges.length === 1 ? ranges[0].attributes : within?.attributes ?? {}
    for (const range of ranges.reverse()) this.text.delete(range.raw, range.count)
    if (replacement) this.text.insert(raw, replacement, attributes)
  }

  reconcile(next: string) {
    const previous = this.source
    if (previous === next) return
    const shared = Math.min(previous.length, next.length)
    let prefix = 0, suffix = 0
    while (prefix < shared && previous[prefix] === next[prefix]) prefix++
    while (suffix < shared - prefix && previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++
    this.edit(prefix, previous.length - suffix, next.slice(prefix, next.length - suffix))
  }

  accept(changeId: string, token: string, start: number, end: number, replacement: string) {
    const ranges = this.ranges(start, end)
    for (const range of ranges) this.text.format(range.raw, range.count, { [original + changeId]: true })
    if (replacement) {
      const attributes = { ...(ranges.length === 1 ? ranges[0].attributes : {}) }
      delete attributes[original + changeId]
      this.text.insert(this.rawOffset(end), replacement, { ...attributes, [proposed + changeId]: token })
    }
  }

  markLegacyInsertion(changeId: string, position: number) {
    // Older immutable decisions did not carry the materialized flag. Keep a
    // hidden run so deleting every inserted character cannot revive the text.
    this.text.insert(this.rawOffset(position), '\u2060', { [proposed + changeId]: legacyInsertionMarker })
  }
}
