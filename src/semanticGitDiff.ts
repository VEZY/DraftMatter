export interface SemanticDiffHunk {
  heading: string
  removed: string[]
  added: string[]
}

export interface SemanticGitDiff {
  addedLines: number
  removedLines: number
  reviewLines: number
  hunks: SemanticDiffHunk[]
}

const reviewSyntax = /\.dm-anchor|\.draftmatter-reviews|\.dm-(?:author|change|thread|decision)\b|data-anchor=/

function renderProseLine(line: string) {
  return line
    .replace(/\[\]\{[^}\r\n]*\.dm-anchor\b[^}\r\n]*\}/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s*(?:[-*+] |\d+[.)]\s+)/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(?:\*\*|__|~~|`)(.*?)(?:\*\*|__|~~|`)/g, '$1')
    .trim()
}

function appendUnique(lines: string[], value: string) {
  if (value && lines.at(-1) !== value) lines.push(value)
}

export function summarizeSemanticGitDiff(diff: string): SemanticGitDiff {
  const hunks: SemanticDiffHunk[] = []
  let active: SemanticDiffHunk | undefined
  let addedLines = 0
  let removedLines = 0
  let reviewLines = 0

  for (const line of diff.split(/\r\n|\n|\r/)) {
    if (line.startsWith('@@')) {
      active = { heading: line, removed: [], added: [] }
      hunks.push(active)
      continue
    }
    if (!active || line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) {
      addedLines += 1
      if (reviewSyntax.test(line)) reviewLines += 1
      else appendUnique(active.added, renderProseLine(line.slice(1)))
    } else if (line.startsWith('-')) {
      removedLines += 1
      if (reviewSyntax.test(line)) reviewLines += 1
      else appendUnique(active.removed, renderProseLine(line.slice(1)))
    }
  }

  return {
    addedLines,
    removedLines,
    reviewLines,
    hunks: hunks.filter((hunk) => hunk.added.length > 0 || hunk.removed.length > 0),
  }
}
