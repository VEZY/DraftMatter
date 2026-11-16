import { useMemo } from 'react'
import { compareRecoverySources, type RecoveryDiffRow } from './recoveryDiff'
import './recoveryChanges.css'

type DisplayRow = { kind: 'source'; row: RecoveryDiffRow } | { kind: 'changed'; before: RecoveryDiffRow; after: RecoveryDiffRow }

/** Keep shared paragraph text once while retaining both exact source line numbers. */
function displayRows(rows: readonly RecoveryDiffRow[]): DisplayRow[] {
  const removed = new Map(rows.filter((row) => row.kind === 'removed').map((row) => [row.oldLine, row]))
  const paired = new Map<RecoveryDiffRow, RecoveryDiffRow>()
  const merged = new Set<RecoveryDiffRow>()
  for (const row of rows) {
    if (row.kind !== 'added' || !row.inlineSegments || row.pairedOldLine === undefined) continue
    const before = removed.get(row.pairedOldLine)
    if (!before || merged.has(before)) continue
    paired.set(row, before)
    merged.add(before)
  }
  return rows.flatMap((row): DisplayRow[] => {
    const before = paired.get(row)
    if (before) return [{ kind: 'changed', before, after: row }]
    return merged.has(row) ? [] : [{ kind: 'source', row }]
  })
}

export function RecoveryChanges({ previousSource, currentSource }: { previousSource: string; currentSource: string }) {
  const comparison = useMemo(() => compareRecoverySources(previousSource, currentSource), [previousSource, currentSource])
  const rows = useMemo(() => displayRows(comparison.rows), [comparison.rows])
  const hasWordChanges = rows.some((row) => row.kind === 'changed' && row.after.inlineSegments?.some((segment) => segment.kind !== 'equal'))
  return <section className="recovery-changes" aria-label="Changes from selected version to current manuscript">
    <p className="recovery-changes-direction">Compared with your current manuscript. <span>− Removed text</span> <span>+ Added text</span></p>
    {!comparison.changed ? <p className="recovery-changes-empty">This version has the same source as your current manuscript.</p> : <>
      <p className="recovery-changes-count" role="status">{hasWordChanges && <>Word changes highlighted · </>}{comparison.addedLines} added {comparison.addedLines === 1 ? 'line' : 'lines'} · {comparison.removedLines} removed {comparison.removedLines === 1 ? 'line' : 'lines'}{comparison.truncated ? ' in the compared portion' : ''}</p>
      {comparison.notices.length > 0 && <div className="recovery-changes-notices">{comparison.notices.map((notice) => <p key={notice}>{notice}</p>)}</div>}
      <div className="recovery-changes-lines" role="region" aria-label="Source differences" tabIndex={0}>
        {rows.map((display, index) => {
          if (display.kind === 'changed') {
            const { before, after } = display
            return <div className="recovery-changes-row changed" role="group" key={`changed-${before.oldLine}-${after.newLine}-${index}`} aria-label={`Changed line ${after.newLine}${before.oldLine !== after.newLine ? ` (previous line ${before.oldLine})` : ''}`}>
              <span className="recovery-changes-line-number" aria-hidden="true">{before.oldLine}</span>
              <span className="recovery-changes-line-number" aria-hidden="true">{after.newLine}</span>
              <span className="recovery-changes-sign" aria-hidden="true">±</span>
              <pre>{after.inlineSegments!.map((segment, part) => segment.kind === 'removed'
                ? <del key={part}>{segment.text}</del>
                : segment.kind === 'added' ? <ins key={part}>{segment.text}</ins> : <span key={part}>{segment.text}</span>)}{before.ending && after.ending && <span className="recovery-changes-ending" aria-label={`Line ending changed from ${before.ending} to ${after.ending}`}>{before.ending} → {after.ending}</span>}</pre>
            </div>
          }
          const { row } = display
          return row.kind === 'omitted'
          ? <div className="recovery-changes-omitted" key={`omitted-${index}`}>{row.text}</div>
          : <div className={`recovery-changes-row ${row.kind}${row.segments ? ' word-level' : ''}`} role="group" key={`${row.kind}-${row.oldLine}-${row.newLine}-${index}`} aria-label={`${row.kind === 'added' ? 'Added' : row.kind === 'removed' ? 'Removed' : 'Unchanged'} line ${row.newLine ?? row.oldLine}`}>
            <span className="recovery-changes-line-number" aria-hidden="true">{row.oldLine ?? ''}</span>
            <span className="recovery-changes-line-number" aria-hidden="true">{row.newLine ?? ''}</span>
            <span className="recovery-changes-sign" aria-hidden="true">{row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : ' '}</span>
            <pre>{row.segments ? row.segments.map((segment, part) => segment.changed
              ? row.kind === 'removed' ? <del key={part}>{segment.text}</del> : <ins key={part}>{segment.text}</ins>
              : <span key={part}>{segment.text}</span>) : row.text}{row.ending && <span className="recovery-changes-ending">{row.ending}</span>}</pre>
          </div>
        })}
      </div>
    </>}
  </section>
}
