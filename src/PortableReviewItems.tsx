import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon'
import { parseReviewMarkup } from './reviewMarkup'
import {
  appendReviewThreadMessage,
  createReviewChange,
  createReviewThread,
  decideReviewChange,
  decideReviewChanges,
  ensureReviewAuthor,
  rebaseReviewChange,
  setReviewThreadStatus,
} from './reviewOperations'
import { buildReviewQueue, navigateReviewQueue, type ReviewQueueItem } from './reviewQueue'
import { placePortableReviewAtQuote, placePortableReviewCandidate, reanchorPortableReviews } from './reviewReanchor'
import { DEFAULT_USER_SETTINGS, type LocalAuthorIdentity } from './userSettings'
import { ReviewTimestamp } from './ReviewTimestamp'
import { reviewProposalText } from './reviewPresentation'

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'A'
}

function statusLabel(status: string) {
  return status === 'needs-rebase' ? 'Needs rebase' : `${status.slice(0, 1).toUpperCase()}${status.slice(1)}`
}

function uniqueQuote(source: string, quote: string) {
  const document = parseReviewMarkup(source)
  const manuscript = source.slice(0, document.sectionStart ?? source.length)
  const matches: number[] = []
  let offset = manuscript.indexOf(quote)
  while (offset >= 0) {
    matches.push(offset)
    offset = manuscript.indexOf(quote, offset + Math.max(1, quote.length))
  }
  return matches
}

export function PortableReviewItems({
  source,
  excludeIds = [],
  authorId,
  activeId: controlledActiveId,
  navigationItems,
  localAuthor = DEFAULT_USER_SETTINGS.author,
  onActiveIdChange,
  onNavigateToItem,
  selectedTarget,
  onApply,
}: {
  source: string
  excludeIds?: string[]
  authorId?: string
  activeId?: string
  navigationItems?: ReviewQueueItem[]
  localAuthor?: LocalAuthorIdentity
  onActiveIdChange?: (id: string | undefined) => void
  onNavigateToItem?: (item: ReviewQueueItem) => void
  selectedTarget?: { quote: string; occurrence: number } | null
  onApply: (source: string, message: string) => void
}) {
  const document = useMemo(() => parseReviewMarkup(source), [source])
  const reanchorResult = useMemo(() => reanchorPortableReviews(source), [source])
  const recoveryByAnchor = useMemo(() => new Map(reanchorResult.items.map((item) => [item.anchorId, item])), [reanchorResult])
  const queue = useMemo(() => {
    const excluded = new Set(excludeIds)
    return buildReviewQueue(document, authorId ? { authorIds: [authorId] } : {}).filter((item) => !excluded.has(item.id))
  }, [authorId, document, excludeIds])
  const batchableChangeIds = useMemo(() => queue
    .filter((item) => item.kind === 'change' && (item.status === 'open' || item.status === 'needs-rebase'))
    .map((item) => item.id), [queue])
  const [internalActiveId, setInternalActiveId] = useState<string>()
  const [selectedChangeIds, setSelectedChangeIds] = useState<string[]>([])
  const activeId = onActiveIdChange ? controlledActiveId : internalActiveId
  const setActiveId = useCallback((id: string | undefined) => {
    if (onActiveIdChange) onActiveIdChange(id)
    else setInternalActiveId(id)
  }, [onActiveIdChange])
  const navigableQueue = navigationItems ?? queue
  const activate = (id: string) => {
    setActiveId(id)
    const item = navigableQueue.find((candidate) => candidate.id === id)
    if (item) onNavigateToItem?.(item)
  }
  const [reply, setReply] = useState('')
  const [problem, setProblem] = useState('')
  const [compose, setCompose] = useState<'comment' | 'suggestion' | null>(null)
  const [commentAnchorMode, setCommentAnchorMode] = useState<'range' | 'point-before' | 'point-after'>('range')
  const [quote, setQuote] = useState('')
  const [selectedOccurrence, setSelectedOccurrence] = useState<number>()
  const [body, setBody] = useState('')
  const [placementAnchorId, setPlacementAnchorId] = useState<string>()
  const [placementQuote, setPlacementQuote] = useState('')
  const [rebaseChangeId, setRebaseChangeId] = useState<string>()
  const [rebaseQuote, setRebaseQuote] = useState('')
  const [rebaseProposal, setRebaseProposal] = useState('')
  const composerRef = useRef<HTMLDivElement>(null)
  const autoRecoveredSourceRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (reanchorResult.recovered === 0 || reanchorResult.source === source || autoRecoveredSourceRef.current === reanchorResult.source) return
    autoRecoveredSourceRef.current = reanchorResult.source
    onApply(
      reanchorResult.source,
      `${reanchorResult.recovered} review location${reanchorResult.recovered === 1 ? '' : 's'} recovered${reanchorResult.unresolved ? ` · ${reanchorResult.unresolved} still need manual placement` : ''}`,
    )
  }, [onApply, reanchorResult, source])

  useEffect(() => {
    if (!navigableQueue.some((item) => item.id === activeId)) setActiveId(navigableQueue[0]?.id)
  }, [activeId, navigableQueue, setActiveId])

  useEffect(() => {
    const available = new Set(batchableChangeIds)
    setSelectedChangeIds((current) => {
      const retained = current.filter((id) => available.has(id))
      return retained.length === current.length && retained.every((id, index) => id === current[index]) ? current : retained
    })
  }, [batchableChangeIds])

  useEffect(() => {
    if (compose && typeof composerRef.current?.scrollIntoView === 'function') composerRef.current.scrollIntoView({ block: 'nearest' })
  }, [compose])

  const authors = new Map(document.authors.map((author) => [author.id, author.name]))
  const apply = (nextSource: string, message: string) => {
    setProblem('')
    setReply('')
    onApply(nextSource, message)
  }
  const fail = (error: unknown) => setProblem(error instanceof Error ? error.message : String(error))

  const decide = (changeId: string, action: 'accepted' | 'rejected') => {
    try {
      const withAuthor = ensureReviewAuthor(document, localAuthor).document
      const result = decideReviewChange(withAuthor, { changeId, action, authorId: localAuthor.id })
      apply(result.document.source, action === 'accepted'
        ? `Suggestion accepted${result.rebasedChangeIds.length ? ` · ${result.rebasedChangeIds.length} overlapping alternative${result.rebasedChangeIds.length === 1 ? '' : 's'} need rebase` : ''}`
        : 'Suggestion rejected · accepted text unchanged')
    } catch (error) {
      fail(error)
    }
  }

  const toggleBatchSelection = (changeId: string) => {
    setSelectedChangeIds((current) => current.includes(changeId)
      ? current.filter((id) => id !== changeId)
      : [...current, changeId])
  }

  const decideBatch = (action: 'accepted' | 'rejected') => {
    try {
      const withAuthor = ensureReviewAuthor(document, localAuthor).document
      const result = decideReviewChanges(withAuthor, {
        changeIds: selectedChangeIds,
        action,
        authorId: localAuthor.id,
      })
      setSelectedChangeIds([])
      apply(
        result.document.source,
        `${result.decidedChangeIds.length} suggestion${result.decidedChangeIds.length === 1 ? '' : 's'} ${action} atomically${result.rebasedChangeIds.length ? ` · ${result.rebasedChangeIds.length} overlapping alternative${result.rebasedChangeIds.length === 1 ? '' : 's'} need rebase` : ''}`,
      )
    } catch (error) {
      fail(error)
    }
  }

  const sendReply = (threadId: string) => {
    if (!reply.trim()) return
    try {
      const withAuthor = ensureReviewAuthor(document, localAuthor).document
      const result = appendReviewThreadMessage(withAuthor, threadId, { authorId: localAuthor.id, message: reply.trim() })
      apply(result.document.source, 'Reply added to the portable review thread')
    } catch (error) {
      fail(error)
    }
  }

  const changeThreadStatus = (threadId: string, status: 'open' | 'resolved' | 'deleted') => {
    try {
      const result = setReviewThreadStatus(document, threadId, status)
      apply(result.document.source, status === 'open' ? 'Comment thread reopened' : status === 'resolved' ? 'Comment thread resolved' : 'Comment thread removed from the active queue')
    } catch (error) {
      fail(error)
    }
  }

  const rebase = (changeId: string) => {
    const change = document.changes.find((candidate) => candidate.id === changeId)
    if (!change) return
    if (!rebaseQuote.trim() || (change.changeKind !== 'delete' && !rebaseProposal.trim())) {
      setProblem('Select exact text in the accepted manuscript and enter the revised proposal.')
      return
    }
    try {
      const result = rebaseReviewChange(document, {
        changeId,
        quote: rebaseQuote,
        proposal: change.changeKind === 'delete' ? undefined : rebaseProposal,
        rationale: change.rationale,
        author: localAuthor,
      })
      setRebaseChangeId(undefined)
      setRebaseQuote('')
      setRebaseProposal('')
      apply(result.document.source, `Suggestion rebased onto the accepted manuscript · ${result.appliedChangeIds.length} accepted decision${result.appliedChangeIds.length === 1 ? '' : 's'} folded into the portable base`)
    } catch (error) {
      fail(error)
    }
  }

  const create = () => {
    const selected = quote.trim()
    if (!selected || !body.trim()) {
      setProblem('Enter an exact manuscript quote and a comment or replacement.')
      return
    }
    const matches = uniqueQuote(source, selected)
    const selectedMatch = selectedTarget?.quote === selected && selectedOccurrence !== undefined ? matches[selectedOccurrence] : undefined
    if (selectedMatch === undefined && matches.length !== 1) {
      setProblem(matches.length === 0 ? 'That quote was not found in the manuscript.' : 'That quote occurs more than once; use a longer selection.')
      return
    }
    const matchedStart = selectedMatch ?? matches[0]
    const point = commentAnchorMode === 'point-after' ? matchedStart + selected.length : matchedStart
    const start = compose === 'comment' && commentAnchorMode !== 'range' ? point : matchedStart
    const end = compose === 'comment' && commentAnchorMode !== 'range' ? point : matchedStart + selected.length
    try {
      const result = compose === 'comment'
        ? createReviewThread(source, { start, end, author: localAuthor, message: body.trim() })
        : createReviewChange(source, { start, end, author: localAuthor, kind: 'replace', proposal: body })
      setCompose(null)
      setCommentAnchorMode('range')
      setQuote('')
      setBody('')
      apply(result.document.source, compose === 'comment' ? 'Portable comment created' : 'Portable suggestion created')
    } catch (error) {
      fail(error)
    }
  }

  const placeCandidate = (anchorId: string, start: number, end: number) => {
    try {
      const result = placePortableReviewCandidate(source, anchorId, { start, end }, new Date().toISOString())
      setPlacementAnchorId(undefined)
      setPlacementQuote('')
      apply(result.source, 'Review location placed from the matching text candidates')
    } catch (error) {
      fail(error)
    }
  }

  const placeAtQuote = (anchorId: string) => {
    try {
      const result = placePortableReviewAtQuote(source, anchorId, placementQuote, undefined, new Date().toISOString())
      setPlacementAnchorId(undefined)
      setPlacementQuote('')
      apply(result.source, 'Review location placed on the selected manuscript text')
    } catch (error) {
      fail(error)
    }
  }

  const navigate = (direction: 'next' | 'previous') => {
    const next = navigateReviewQueue(navigableQueue, activeId, direction)
    if (next) activate(next.id)
    const target = next ? globalThis.document.getElementById(`review-item-${next.id}`) : null
    if (typeof target?.scrollIntoView === 'function') target.scrollIntoView({ block: 'nearest' })
  }

  const activePosition = navigableQueue.findIndex((item) => item.id === activeId)
  const allVisibleSelected = batchableChangeIds.length > 0 && batchableChangeIds.every((id) => selectedChangeIds.includes(id))
  const selectedChanges = document.changes.filter((change) => selectedChangeIds.includes(change.id))
  const canAcceptSelection = selectedChanges.length > 0 && selectedChanges.every((change) => change.status === 'open')
  const filteredAuthorName = authorId ? document.authors.find((author) => author.id === authorId)?.name : undefined

  return (
    <>
      {problem && <div className="portable-review-problem" role="alert">{problem}</div>}
      {batchableChangeIds.length > 0 && (
        <div className="portable-review-bulk" role="group" aria-label="Batch suggestion decisions">
          <span><strong>Batch decisions</strong><small>{filteredAuthorName ? `${filteredAuthorName}'s visible suggestions` : 'Visible open suggestions'}</small></span>
          <button onClick={() => setSelectedChangeIds(allVisibleSelected ? [] : batchableChangeIds)}>{allVisibleSelected ? 'Clear selection' : `Select all ${batchableChangeIds.length}`}</button>
          <small>{selectedChangeIds.length} selected</small>
          {selectedChangeIds.length > 0 && <div><button className="accept" onClick={() => decideBatch('accepted')} disabled={!canAcceptSelection} title={canAcceptSelection ? undefined : 'Needs-rebase alternatives can be rejected or rebased, but not accepted directly.'}><Icon name="check" size={14} /> Accept selected</button><button className="reject" onClick={() => decideBatch('rejected')}><Icon name="x" size={14} /> Reject selected</button></div>}
        </div>
      )}
      {queue.map((item) => {
        const active = item.id === activeId
        if (item.kind === 'change' || item.kind === 'unplaced-change') {
          const change = document.changes.find((candidate) => candidate.id === item.id)!
          const recovery = recoveryByAnchor.get(item.anchorId)
          return (
            <div className={`conflict-card portable-review-card ${active ? 'active' : ''} ${selectedChangeIds.includes(item.id) ? 'batch-selected' : ''}`} id={`review-item-${item.id}`} key={item.id}>
              <div className="conflict-heading"><Icon name="branch" size={16} /><span>{item.conflictId ? 'Overlapping suggestion' : item.kind === 'unplaced-change' ? 'Unplaced suggestion' : 'Suggestion'}</span>{batchableChangeIds.includes(item.id) && <label className="review-batch-toggle" onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={selectedChangeIds.includes(item.id)} onChange={() => toggleBatchSelection(item.id)} aria-label={`Select suggestion by ${item.authorName}`} /><span>Select</span></label>}<small>{item.anchorId}</small></div>
              <button className={`proposal-option ${active ? 'selected' : ''}`} onClick={() => activate(item.id)}>
                <span className="avatar avatar-blue avatar-small">{initials(item.authorName)}</span>
                <span className="proposal-author"><strong>{item.authorName}</strong><small><ReviewTimestamp value={change.updatedAt ?? change.createdAt} verb={change.updatedAt ? 'Updated' : 'Created'} fallback={item.kind === 'unplaced-change' ? 'Location needs attention' : item.excerpt} detail={item.kind === 'unplaced-change' ? 'Location needs attention' : item.excerpt} /></small></span>
                <span className={`status-pill status-${item.status}`}>{statusLabel(item.status)}</span>
                <span className="proposal-copy"><del>{change.anchorContext?.quote || item.excerpt}</del>{change.proposal !== undefined && <ins>{reviewProposalText(change.proposal)}</ins>}</span>
              </button>
              {change.rationale && <div className="proposal-rationale">“{change.rationale}”</div>}
              {active && change.status === 'open' && item.kind !== 'unplaced-change' && (
                <div className="review-actions"><button className="accept" onClick={() => decide(item.id, 'accepted')}><Icon name="check" size={15} /> Accept</button><button className="reject" onClick={() => decide(item.id, 'rejected')}><Icon name="x" size={15} /> Reject</button></div>
              )}
              {active && change.status === 'needs-rebase' && (
                <>
                  <div className="review-actions"><button className="accept" onClick={() => { setRebaseChangeId(item.id); setRebaseQuote(selectedTarget?.quote ?? ''); setRebaseProposal(change.proposal ?? '') }}><Icon name="branch" size={15} /> Rebase suggestion</button><button className="reject" onClick={() => decide(item.id, 'rejected')}><Icon name="x" size={15} /> Reject alternative</button></div>
                  {rebaseChangeId === item.id && (
                    <div className="review-rebase-form" role="group" aria-label="Rebase suggestion">
                      <p>Anchor the revised proposal to text in the accepted manuscript. Accepted decisions are folded into the portable base once; their audit records remain.</p>
                      <label><span>Text in accepted manuscript</span><input value={rebaseQuote} onChange={(event) => setRebaseQuote(event.target.value)} placeholder="Select text in Final preview or paste it here" /></label>
                      {change.changeKind !== 'delete' && <label><span>Revised proposal</span><textarea value={rebaseProposal} onChange={(event) => setRebaseProposal(event.target.value)} rows={3} /></label>}
                      <div><button onClick={() => setRebaseChangeId(undefined)}>Cancel</button><button className="primary-button" onClick={() => rebase(item.id)}>Create rebased proposal</button></div>
                    </div>
                  )}
                </>
              )}
              {active && item.kind === 'unplaced-change' && recovery && (
                <div className="unplaced-review-placement">
                  <p>{recovery.reason}</p>
                  {recovery.candidates.map((match, index) => <div className="unplaced-review-candidate" key={`${match.start}-${match.end}`}><span>{match.excerpt}</span><button onClick={() => placeCandidate(item.anchorId, match.start, match.end)}>Place here {index + 1}</button></div>)}
                  <button className="unplaced-review-manual" onClick={() => { setPlacementAnchorId(item.anchorId); setPlacementQuote(selectedTarget?.quote ?? '') }}>Choose different text</button>
                  {placementAnchorId === item.anchorId && <div className="unplaced-review-form"><label><span>Exact manuscript text</span><input value={placementQuote} onChange={(event) => setPlacementQuote(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') placeAtQuote(item.anchorId) }} /></label><button onClick={() => placeAtQuote(item.anchorId)}>Place review</button></div>}
                </div>
              )}
            </div>
          )
        }

        const thread = document.threads.find((candidate) => candidate.id === item.id)!
        const recovery = recoveryByAnchor.get(item.anchorId)
        return (
          <div className={`comment-card portable-review-card ${active ? 'active' : ''} ${thread.status === 'resolved' ? 'resolved' : ''}`} id={`review-item-${item.id}`} key={item.id} onClick={() => activate(item.id)}>
            <div className="comment-author"><span className="avatar avatar-clay avatar-small">{initials(item.authorName)}</span><span><strong>{item.authorName}</strong><small><ReviewTimestamp value={thread.updatedAt ?? thread.createdAt} verb={thread.updatedAt ? 'Updated' : 'Created'} fallback={item.kind === 'unplaced-thread' ? 'Location needs attention' : statusLabel(thread.status)} detail={item.kind === 'unplaced-thread' ? 'Location needs attention' : statusLabel(thread.status)} /></small></span></div>
            <div className="comment-quote">“{thread.anchorContext?.quote || item.excerpt}”</div>
            {thread.messageRecords.map((message, index) => index === 0
              ? <p key={`${item.id}-${index}`}>{message.content}</p>
              : <div className="reply-message" key={`${item.id}-${index}`}><span className="avatar avatar-sage avatar-small">{initials(authors.get(message.authorId ?? '') ?? message.authorId ?? 'A')}</span><p><strong>{authors.get(message.authorId ?? '') ?? message.authorId ?? 'Author'}</strong>{message.content}</p></div>)}
            {active && thread.status === 'open' && item.kind !== 'unplaced-thread' && (
              <div className="reply-box"><input value={reply} onChange={(event) => setReply(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') sendReply(item.id) }} placeholder="Reply…" aria-label={`Reply to ${item.authorName}`} /><button onClick={() => sendReply(item.id)} disabled={!reply.trim()} aria-label="Send reply"><Icon name="arrowRight" size={15} /></button></div>
            )}
            {active && item.kind !== 'unplaced-thread' && <div className="portable-thread-actions"><button className="resolve-button" onClick={() => changeThreadStatus(item.id, thread.status === 'resolved' ? 'open' : 'resolved')}><Icon name="check" size={14} /> {thread.status === 'resolved' ? 'Reopen thread' : 'Resolve thread'}</button><button className="portable-delete-thread" onClick={() => changeThreadStatus(item.id, 'deleted')}><Icon name="x" size={13} /> Remove</button></div>}
            {active && item.kind === 'unplaced-thread' && recovery && (
              <div className="unplaced-review-placement">
                <p>{recovery.reason}</p>
                {recovery.candidates.map((match, index) => <div className="unplaced-review-candidate" key={`${match.start}-${match.end}`}><span>{match.excerpt}</span><button onClick={() => placeCandidate(item.anchorId, match.start, match.end)}>Place here {index + 1}</button></div>)}
                <button className="unplaced-review-manual" onClick={() => { setPlacementAnchorId(item.anchorId); setPlacementQuote(selectedTarget?.quote ?? '') }}>Choose different text</button>
                {placementAnchorId === item.anchorId && <div className="unplaced-review-form"><label><span>Exact manuscript text</span><input value={placementQuote} onChange={(event) => setPlacementQuote(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') placeAtQuote(item.anchorId) }} /></label><button onClick={() => placeAtQuote(item.anchorId)}>Place review</button></div>}
              </div>
            )}
          </div>
        )
      })}

      {compose && (
        <div className="portable-review-composer" ref={composerRef} role="group" aria-label={compose === 'comment' ? 'New comment' : 'New suggestion'}>
          <strong>{compose === 'comment' ? 'New comment' : 'Suggest replacement'}</strong>
          {compose === 'comment' && <label><span>Attach to</span><select value={commentAnchorMode} onChange={(event) => setCommentAnchorMode(event.target.value as typeof commentAnchorMode)}><option value="range">Selected text</option><option value="point-before">Point before nearby text</option><option value="point-after">Point after nearby text</option></select></label>}
          <label><span>{compose === 'comment' && commentAnchorMode !== 'range' ? 'Exact nearby manuscript text' : 'Exact manuscript text'}</span><input value={quote} onChange={(event) => { setQuote(event.target.value); setSelectedOccurrence(undefined) }} placeholder={compose === 'comment' && commentAnchorMode !== 'range' ? 'Select text beside the comment point' : 'Paste the selected text'} /></label>
          {compose === 'comment' && commentAnchorMode !== 'range' && <small className="portable-point-note">The comment is attached between characters; nearby text keeps that point recoverable after external edits.</small>}
          <label><span>{compose === 'comment' ? 'Comment' : 'Replacement'}</span><textarea value={body} onChange={(event) => setBody(event.target.value)} rows={3} /></label>
          <div><button onClick={() => { setCompose(null); setCommentAnchorMode('range') }}>Cancel</button><button className="primary-button" onClick={create}>Add</button></div>
        </div>
      )}

      <div className="review-panel-footer portable-review-footer">
        <button onClick={() => { setCompose('comment'); setCommentAnchorMode('range'); setProblem(''); setQuote(selectedTarget?.quote ?? ''); setSelectedOccurrence(selectedTarget?.occurrence) }}><Icon name="message" size={15} /> New comment</button>
        <button onClick={() => { setCompose('suggestion'); setProblem(''); setQuote(selectedTarget?.quote ?? ''); setSelectedOccurrence(selectedTarget?.occurrence) }}><Icon name="spark" size={15} /> Suggest edit</button>
        <span>{navigableQueue.length ? `${Math.max(1, activePosition + 1)} of ${navigableQueue.length}` : 'No review items'}</span>
        <button onClick={() => navigate('previous')} disabled={navigableQueue.length < 2} aria-label="Previous review item">↑</button>
        <button onClick={() => navigate('next')} disabled={navigableQueue.length < 2} aria-label="Next review item">↓</button>
      </div>
    </>
  )
}
