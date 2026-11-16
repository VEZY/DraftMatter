import { describe, expect, it } from 'vitest'
import { compareRecoverySources, RECOVERY_DIFF_LIMITS } from './recoveryDiff'

function reconstructed(rows: ReturnType<typeof compareRecoverySources>['rows'], side: 'oldLine' | 'newLine') {
  return rows.filter((row) => row[side] !== undefined).map((row) => row.text)
}

describe('read-only recovery source comparisons', () => {
  it('does not manufacture changes for identical sources', () => {
    expect(compareRecoverySources('# Paper\n\nA result.\n', '# Paper\n\nA result.\n')).toMatchObject({ changed: false, rows: [], addedLines: 0, removedLines: 0, truncated: false })
  })

  it('compares selected source to current source with stable line numbers and word emphasis', () => {
    const previous = '# Results\n\nLeaf area increased by 12%.\n\nShared conclusion.\n'
    const current = '# Results\n\nLeaf area increased by 18%.\nAn added observation.\n\nShared conclusion.\n'
    const diff = compareRecoverySources(previous, current)
    expect(diff).toMatchObject({ changed: true, addedLines: 2, removedLines: 1, strategy: 'lines', truncated: false })
    expect(diff.rows.find((row) => row.kind === 'removed')).toMatchObject({ oldLine: 3, text: 'Leaf area increased by 12%.' })
    expect(diff.rows.filter((row) => row.kind === 'added').map((row) => row.newLine)).toEqual([3, 4])
    expect(diff.rows.find((row) => row.kind === 'removed')?.segments?.filter((segment) => segment.changed)).toEqual([{ text: '12', changed: true }])
    expect(diff.rows.find((row) => row.kind === 'added')?.segments?.filter((segment) => segment.changed)).toEqual([{ text: '18', changed: true }])
    expect(reconstructed(diff.rows, 'oldLine')).toEqual(previous.trimEnd().split('\n'))
    expect(reconstructed(diff.rows, 'newLine')).toEqual(current.trimEnd().split('\n'))
  })

  it('handles insertion, deletion, empty lines and an empty document without dropping the first row', () => {
    expect(compareRecoverySources('', '\nNew paragraph\n')).toMatchObject({ addedLines: 2, removedLines: 0 })
    expect(compareRecoverySources('\nOld paragraph\n', '')).toMatchObject({ removedLines: 2, addedLines: 0 })
    const diff = compareRecoverySources('A\n\nB', '\nA\nB\n')
    expect(reconstructed(diff.rows, 'oldLine')).toEqual(['A', '', 'B'])
    expect(reconstructed(diff.rows, 'newLine')).toEqual(['', 'A', 'B'])
  })

  it('shows CRLF, CR, LF and missing-newline differences even when line text is identical', () => {
    for (const [previous, current, ending] of [
      ['Same text\r\n', 'Same text\n', 'CRLF'],
      ['Same text\r', 'Same text\n', 'CR'],
      ['Same text', 'Same text\n', 'No newline'],
    ]) {
      const diff = compareRecoverySources(previous, current)
      expect(diff).toMatchObject({ changed: true, addedLines: 1, removedLines: 1 })
      expect(diff.rows.find((row) => row.kind === 'removed')?.ending).toBe(ending)
      expect(diff.rows.find((row) => row.kind === 'added')?.ending).toBe('LF')
    }
    const leading = compareRecoverySources('\r\nA', '\rB')
    expect(reconstructed(leading.rows, 'oldLine')).toEqual(['', 'A'])
    expect(reconstructed(leading.rows, 'newLine')).toEqual(['', 'B'])
  })

  it('locates a small change late in a large manuscript instead of truncating before it', () => {
    const unchanged = 'An unchanged paragraph.\n'.repeat(30_000)
    const diff = compareRecoverySources(`${unchanged}Result 12.\nConclusion.\n`, `${unchanged}Result 18.\nConclusion.\n`)
    expect(diff).toMatchObject({ addedLines: 1, removedLines: 1, truncated: false })
    expect(diff.rows.find((row) => row.kind === 'removed')).toMatchObject({ oldLine: 30_001, text: 'Result 12.' })
    expect(diff.notices.join(' ')).toContain('unchanged lines before')
    expect(diff.rows).toHaveLength(5)
  })

  it('bounds broad comparisons and clearly reports a non-minimal or truncated preview', () => {
    const previous = Array.from({ length: 9_000 }, (_, index) => `Original paragraph ${index}.`).join('\n')
    const current = Array.from({ length: 9_000 }, (_, index) => `Replacement paragraph ${index}.`).join('\n')
    const diff = compareRecoverySources(previous, current)
    expect(diff.strategy).toBe('blocks')
    expect(diff.truncated).toBe(true)
    expect(diff.rows.length).toBeLessThanOrEqual(RECOVERY_DIFF_LIMITS.rows)
    expect(diff.addedLines).toBeLessThanOrEqual(RECOVERY_DIFF_LIMITS.lines)
    expect(diff.removedLines).toBeLessThanOrEqual(RECOVERY_DIFF_LIMITS.lines)
    expect(diff.notices.join(' ')).toContain('Some changes may not be shown')
    expect(diff.notices.join(' ')).toContain('rather than a minimal line diff')
  })

  it('preserves source tokens across a deterministic mix of small edited line sequences', () => {
    let state = 17
    const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state }
    const endings = ['\n', '\r\n', '\r']
    for (let sample = 0; sample < 200; sample++) {
      const oldLines = Array.from({ length: 1 + next() % 3 }, () => ['α', 'A', 'B', '', '<script>', '🪴'][next() % 6])
      const newLines = [...oldLines]
      newLines.splice(next() % (newLines.length + 1), next() % 2, `Change ${sample}`)
      const ending = endings[next() % endings.length]
      const oldSource = oldLines.join(ending), newSource = newLines.join(ending)
      const texts = (source: string) => {
        if (!source) return []
        const lines = source.split(/\r\n|\r|\n/)
        if (source.endsWith('\n') || source.endsWith('\r')) lines.pop()
        return lines
      }
      const diff = compareRecoverySources(oldSource, newSource)
      if (!diff.changed) continue
      expect(reconstructed(diff.rows, 'oldLine')).toEqual(texts(oldSource))
      expect(reconstructed(diff.rows, 'newLine')).toEqual(texts(newSource))
    }
  })

  it('keeps every displayed row tied to the exact original line across mixed line endings and distant edits', () => {
    const endings = ['\n', '\r\n', '\r']
    for (let sample = 0; sample < 100; sample++) {
      const oldLines = Array.from({ length: 10 }, (_, index) => index % 3 ? `Paragraph ${index}` : '')
      const newLines = [...oldLines]
      newLines.splice(sample % 11, sample % 2, `New paragraph ${sample}`)
      const oldSource = oldLines.join(endings[sample % endings.length])
      const newSource = newLines.join(endings[(sample + 1) % endings.length])
      const diff = compareRecoverySources(oldSource, newSource)
      for (const row of diff.rows) {
        if (row.oldLine !== undefined) expect(row.text).toBe(oldLines[row.oldLine - 1])
        if (row.newLine !== undefined) expect(row.text).toBe(newLines[row.newLine - 1])
      }
    }
  })
})
