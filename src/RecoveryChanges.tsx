import { useMemo } from 'react'
import { compareRecoverySources } from './recoveryDiff'
import './recoveryChanges.css'

export function RecoveryChanges({ previousSource, currentSource }: { previousSource: string; currentSource: string }) {
  const comparison = useMemo(() => compareRecoverySources(previousSource, currentSource), [previousSource, currentSource])
  return <section className="recovery-changes" aria-label="Changes from selected version to current manuscript">
    <p className="recovery-changes-direction">Compared with your current manuscript. <span>− Removed from this version</span> <span>+ Added in the current manuscript</span></p>
    {!comparison.changed ? <p className="recovery-changes-empty">This version has the same source as your current manuscript.</p> : <>
      <p className="recovery-changes-count" role="status">{comparison.addedLines} added {comparison.addedLines === 1 ? 'line' : 'lines'} · {comparison.removedLines} removed {comparison.removedLines === 1 ? 'line' : 'lines'}{comparison.truncated ? ' in the compared portion' : ''}</p>
      {comparison.notices.length > 0 && <div className="recovery-changes-notices">{comparison.notices.map((notice) => <p key={notice}>{notice}</p>)}</div>}
      <div className="recovery-changes-lines" role="region" aria-label="Source differences" tabIndex={0}>
        {comparison.rows.map((row, index) => row.kind === 'omitted'
          ? <div className="recovery-changes-omitted" key={`omitted-${index}`}>{row.text}</div>
          : <div className={`recovery-changes-row ${row.kind}`} role="group" key={`${row.kind}-${row.oldLine}-${row.newLine}-${index}`} aria-label={`${row.kind === 'added' ? 'Added' : row.kind === 'removed' ? 'Removed' : 'Unchanged'} line ${row.newLine ?? row.oldLine}`}>
            <span className="recovery-changes-line-number" aria-hidden="true">{row.oldLine ?? ''}</span>
            <span className="recovery-changes-line-number" aria-hidden="true">{row.newLine ?? ''}</span>
            <span className="recovery-changes-sign" aria-hidden="true">{row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : ' '}</span>
            <pre>{row.segments ? row.segments.map((segment, part) => segment.changed
              ? row.kind === 'removed' ? <del key={part}>{segment.text}</del> : <ins key={part}>{segment.text}</ins>
              : <span key={part}>{segment.text}</span>) : row.text}{row.ending && <span className="recovery-changes-ending">{row.ending}</span>}</pre>
          </div>)}
      </div>
    </>}
  </section>
}
