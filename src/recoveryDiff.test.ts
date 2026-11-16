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

  it('highlights only scattered edited words in a long paragraph rather than treating its whole source line as changed', () => {
    const words = Array.from({ length: 2_500 }, (_, index) => `observation${index}`)
    const previous = words.join(' ')
    words[40] = 'revised40'
    words[1_300] = 'revised1300'
    words[2_400] = 'revised2400'
    const current = words.join(' ')
    const diff = compareRecoverySources(previous, current)
    const removed = diff.rows.find((row) => row.kind === 'removed')!
    const added = diff.rows.find((row) => row.kind === 'added')!
    expect(removed.segments?.filter((segment) => segment.changed).map((segment) => segment.text)).toEqual(['observation40', 'observation1300', 'observation2400'])
    expect(added.segments?.filter((segment) => segment.changed).map((segment) => segment.text)).toEqual(['revised40', 'revised1300', 'revised2400'])
    expect(added.pairedOldLine).toBe(removed.oldLine)
    expect(added.inlineSegments?.filter((segment) => segment.kind !== 'added').map((segment) => segment.text).join('')).toBe(previous)
    expect(added.inlineSegments?.filter((segment) => segment.kind !== 'removed').map((segment) => segment.text).join('')).toBe(current)
    expect(diff.notices).toEqual([])
  })

  it('keeps long repeated prose neutral around distant edits, additions and removals', () => {
    const common = 'Plant models compare repeated observations and measured responses. '
    const previous = `${common.repeat(20)}A stable interpretation. ${common.repeat(20)}The measured result was 12 units. ${common.repeat(20)}`
    const current = previous.replace('stable', 'revised').replace('measured result was 12', 'reproducible result was 18')
    const diff = compareRecoverySources(previous, current)
    const added = diff.rows.find((row) => row.kind === 'added')!
    const before = added.inlineSegments!.filter((segment) => segment.kind !== 'added').map((segment) => segment.text).join('')
    const after = added.inlineSegments!.filter((segment) => segment.kind !== 'removed').map((segment) => segment.text).join('')
    expect(before).toBe(previous)
    expect(after).toBe(current)
    expect(added.inlineSegments!.filter((segment) => segment.kind === 'removed').map((segment) => segment.text)).toEqual(['stable', 'measured', '12'])
    expect(added.inlineSegments!.filter((segment) => segment.kind === 'added').map((segment) => segment.text)).toEqual(['revised', 'reproducible', '18'])
  })

  it('preserves exact Unicode, whitespace and punctuation with small changes in long text', () => {
    const context = 'Les observations écophysiologiques restent reproductibles. '.repeat(60)
    const previous = `${context}Café αβ: 12 µmol; plante 🪴. ${context}A\tB  C.`
    const current = `${context}Café αβ: 18 µmol—plante 🌱! ${context}A B C.`
    const diff = compareRecoverySources(previous, current)
    const inline = diff.rows.find((row) => row.kind === 'added')!.inlineSegments!
    expect(inline).toBeDefined()
    expect(inline.filter((segment) => segment.kind !== 'added').map((segment) => segment.text).join('')).toBe(previous)
    expect(inline.filter((segment) => segment.kind !== 'removed').map((segment) => segment.text).join('')).toBe(current)
    expect(inline.filter((segment) => segment.kind === 'equal').map((segment) => segment.text).join('')).toContain('observations écophysiologiques')
  })

  it('handles pure word insertions or deletions without disabling emphasis for long paragraphs', () => {
    const source = `${'Common unchanged prose. '.repeat(160)}A measured response.`
    for (const [previous, current, kind] of [
      [source, source.replace('A measured', 'A newly measured'), 'added'],
      [source.replace('A measured', 'A newly measured'), source, 'removed'],
    ] as const) {
      const diff = compareRecoverySources(previous, current)
      const inline = diff.rows.find((row) => row.kind === 'added')!.inlineSegments!
      expect(inline.filter((segment) => segment.kind !== 'added').map((segment) => segment.text).join('')).toBe(previous)
      expect(inline.filter((segment) => segment.kind !== 'removed').map((segment) => segment.text).join('')).toBe(current)
      expect(inline.filter((segment) => segment.kind === kind).map((segment) => segment.text).join('').trim()).toBe('newly')
      expect(inline.filter((segment) => segment.kind !== kind && segment.kind !== 'equal')).toEqual([])
    }
  })

  it('reconstructs both sides of sparse long-paragraph edits including repeated words and insertion/deletion shifts', () => {
    let state = 37
    const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state }
    for (let sample = 0; sample < 80; sample++) {
      const oldWords = Array.from({ length: 350 }, (_, index) => index % 7 ? `token${index}` : 'repeated')
      const newWords = [...oldWords]
      for (let edit = 0; edit < 4; edit++) newWords.splice(next() % newWords.length, next() % 3, `change${sample}_${edit}`)
      const previous = oldWords.join(sample % 2 ? '  ' : ' '), current = newWords.join(sample % 2 ? '  ' : ' ')
      const diff = compareRecoverySources(previous, current)
      const inline = diff.rows.find((row) => row.kind === 'added')!.inlineSegments!
      expect(inline).toBeDefined()
      expect(inline.filter((segment) => segment.kind !== 'added').map((segment) => segment.text).join('')).toBe(previous)
      expect(inline.filter((segment) => segment.kind !== 'removed').map((segment) => segment.text).join('')).toBe(current)
    }
  })

  it('falls back explicitly for a long extensive rewrite instead of allocating a quadratic word matrix', () => {
    const previous = Array.from({ length: 3_000 }, (_, index) => `original${index}`).join(' ')
    const current = Array.from({ length: 3_000 }, (_, index) => `replacement${index}`).join(' ')
    const diff = compareRecoverySources(previous, current)
    expect(diff.rows.find((row) => row.kind === 'removed')?.segments).toBeUndefined()
    expect(diff.rows.find((row) => row.kind === 'added')?.inlineSegments).toBeUndefined()
    expect(diff.notices.join(' ')).toContain('word-level comparison reached its work limit')
    expect(reconstructed(diff.rows, 'oldLine')).toEqual([previous])
    expect(reconstructed(diff.rows, 'newLine')).toEqual([current])
  })

  it('pairs an edited paragraph with its matching text rather than an unrelated line inserted before it', () => {
    const previous = 'Measured leaf area increased by 12 percent under the same climate conditions.\n'
    const current = 'A new introductory observation.\nMeasured leaf area increased by 18 percent under the same climate conditions.\n'
    const diff = compareRecoverySources(previous, current)
    const intro = diff.rows.find((row) => row.newLine === 1)!
    const edited = diff.rows.find((row) => row.newLine === 2)!
    expect(intro.inlineSegments).toBeUndefined()
    expect(edited.pairedOldLine).toBe(1)
    expect(edited.inlineSegments?.filter((segment) => segment.kind === 'removed')).toEqual([{ kind: 'removed', text: '12' }])
    expect(edited.inlineSegments?.filter((segment) => segment.kind === 'added')).toEqual([{ kind: 'added', text: '18' }])
  })

  it('does not overflow function argument limits near the source character bound', () => {
    const previous = '.'.repeat(180_000)
    const current = `:${'.'.repeat(179_998)};`
    const diff = compareRecoverySources(previous, current)
    const inline = diff.rows.find((row) => row.kind === 'added')!.inlineSegments!
    expect(inline).toBeDefined()
    expect(inline.filter((segment) => segment.kind !== 'added').map((segment) => segment.text).join('')).toBe(previous)
    expect(inline.filter((segment) => segment.kind !== 'removed').map((segment) => segment.text).join('')).toBe(current)
    expect(diff.truncated).toBe(false)
  })
})
