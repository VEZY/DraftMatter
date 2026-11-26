import { Fragment } from 'prosemirror-model'
import { inlineReviewTargetRange, parseInlineReviewWording } from './structuredManuscript'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon'
import type { StructuredReviewSelection } from './StructuredManuscriptEditor'
import { parseReviewMarkup } from './reviewMarkup'
import {
  appendReviewThreadMessage,
  createReviewChange,
  createReviewThread,
  createReviewThreadOnProposal,
  ensureReviewAuthor,
  materializeResolvedSuggestions,
  rebaseReviewChange,
  setReviewThreadStatus,
} from './reviewOperations'
import { buildReviewQueue, navigateReviewQueue, type ReviewQueueItem } from './reviewQueue'
import { placePortableReviewAtQuote, placePortableReviewCandidate, reanchorPortableReviews } from './reviewReanchor'
import { DEFAULT_USER_SETTINGS, type LocalAuthorIdentity } from './userSettings'
import { ReviewTimestamp } from './ReviewTimestamp'
import { reviewProposalText } from './reviewPresentation'
import {
  decidePortableSuggestion,
  portableReviewDecisionConflicts,
  resolvePortableReviewDecisionConflict,
  type CollaborativeReviewBinding,
} from './sharedEditor/collaborativeReview'
import type { TransactionalReviewAction } from './sharedEditor/reviewDecisions'

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'A'
}

function statusLabel(status: string) {
  if (status === 'needs-rebase') return 'Needs rebase'
  if (status === 'decision-conflict') return 'Decision conflict'
  return `${status.slice(0, 1).toUpperCase()}${status.slice(1)}`
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
  openCommentRequest = 0,
  onComposeChange,
  composerAnchorTop,
  showFooter = true,
  collaborativeReview,
  onDecide,
  onApply,
  canComment = true,
  canSuggest = true,
  canDecide = true,
}: {
  source: string
  excludeIds?: string[]
  authorId?: string
  activeId?: string
  navigationItems?: ReviewQueueItem[]
  localAuthor?: LocalAuthorIdentity
  onActiveIdChange?: (id: string | undefined) => void
  onNavigateToItem?: (item: ReviewQueueItem) => void
  selectedTarget?: StructuredReviewSelection | null
  openCommentRequest?: number
  onComposeChange?: (open: boolean) => void
  composerAnchorTop?: number
  showFooter?: boolean
  collaborativeReview?: CollaborativeReviewBinding | null
  onDecide?: (changeId: string, action: 'accepted' | 'rejected') => void
  onApply: (source: string, message: string) => void
  canComment?: boolean
  canSuggest?: boolean
  canDecide?: boolean
}) {
  const document = useMemo(() => parseReviewMarkup(source), [source])
  const reanchorResult = useMemo(() => reanchorPortableReviews(source), [source])
  const recoveryByAnchor = useMemo(() => new Map(reanchorResult.items.map((item) => [item.anchorId, item])), [reanchorResult])
  const decisionConflicts = useMemo(
    () => collaborativeReview?.conflicts() ?? portableReviewDecisionConflicts(source),
    [collaborativeReview, source],
  )
  const decisionConflictByChange = useMemo(
    () => new Map(decisionConflicts.map((conflict) => [conflict.changeId, conflict])),
    [decisionConflicts],
  )
  const queue = useMemo(() => {
    const excluded = new Set(excludeIds)
    return buildReviewQueue(document, authorId ? { authorIds: [authorId] } : {}).filter((item) => !excluded.has(item.id))
  }, [authorId, document, excludeIds])
  const [internalActiveId, setInternalActiveId] = useState<string>()
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
  const [commentTarget, setCommentTarget] = useState<StructuredReviewSelection | null>(null)
  const [collapsedThreadIds, setCollapsedThreadIds] = useState<string[]>([])
  const [expandedResolvedThreadIds, setExpandedResolvedThreadIds] = useState<string[]>([])
  const [replyingThreadId, setReplyingThreadId] = useState<string>()
  const [quote, setQuote] = useState('')
  const [selectedOccurrence, setSelectedOccurrence] = useState<number>()
  const [body, setBody] = useState('')
  const [placementAnchorId, setPlacementAnchorId] = useState<string>()
  const [placementQuote, setPlacementQuote] = useState('')
  const [rebaseChangeId, setRebaseChangeId] = useState<string>()
  const [rebaseQuote, setRebaseQuote] = useState('')
  const [rebaseProposal, setRebaseProposal] = useState('')
  const composerRef = useRef<HTMLDivElement>(null)
  const rebaseRef = useRef<HTMLDivElement>(null)
  const autoRecoveredSourceRef = useRef<string | undefined>(undefined)
  const handledCommentRequestRef = useRef(0)
  const reportedComposeOpenRef = useRef(false)
  const onComposeChangeRef = useRef(onComposeChange)
  onComposeChangeRef.current = onComposeChange

  useEffect(() => {
    const open = compose !== null
    if (reportedComposeOpenRef.current === open) return
    reportedComposeOpenRef.current = open
    onComposeChangeRef.current?.(open)
  }, [compose])

  useEffect(() => {
    if (!canDecide || reanchorResult.recovered === 0 || reanchorResult.source === source || autoRecoveredSourceRef.current === reanchorResult.source) return
    autoRecoveredSourceRef.current = reanchorResult.source
    onApply(
      reanchorResult.source,
      `${reanchorResult.recovered} review location${reanchorResult.recovered === 1 ? '' : 's'} recovered${reanchorResult.unresolved ? ` · ${reanchorResult.unresolved} still need manual placement` : ''}`,
    )
  }, [canDecide, onApply, reanchorResult, source])

  useEffect(() => {
    if ((compose === 'comment' && !canComment) || (compose === 'suggestion' && !canSuggest)) setCompose(null)
    if (!canComment) { setReply(''); setReplyingThreadId(undefined) }
    if (!canDecide) {
      setPlacementAnchorId(undefined)
      setRebaseChangeId(undefined)
    }
  }, [canComment, canDecide, canSuggest, compose])

  useEffect(() => {
    if (!navigableQueue.some((item) => item.id === activeId)) setActiveId(navigableQueue[0]?.id)
  }, [activeId, navigableQueue, setActiveId])

  useEffect(() => {
    const resolved = new Set(document.threads.filter((thread) => thread.status === 'resolved').map((thread) => thread.id))
    setExpandedResolvedThreadIds((current) => {
      const retained = current.filter((id) => resolved.has(id))
      return retained.length === current.length ? current : retained
    })
  }, [document.threads])

  useEffect(() => {
    if (compose === 'suggestion' && typeof composerRef.current?.scrollIntoView === 'function') composerRef.current.scrollIntoView({ block: 'nearest' })
    if (compose === 'comment') composerRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true })
  }, [compose, openCommentRequest])

  useEffect(() => {
    if (rebaseChangeId && typeof rebaseRef.current?.scrollIntoView === 'function') rebaseRef.current.scrollIntoView({ block: 'center' })
  }, [rebaseChangeId])

  useEffect(() => {
    if (!openCommentRequest || handledCommentRequestRef.current === openCommentRequest || !canComment || !selectedTarget?.quote) return
    handledCommentRequestRef.current = openCommentRequest
    setCompose('comment')
    setProblem('')
    setCommentTarget({ ...selectedTarget })
    setBody('')
  }, [canComment, openCommentRequest, selectedTarget])

  const authors = new Map(document.authors.map((author) => [author.id, author.name]))
  const apply = (nextSource: string, message: string) => {
    setProblem('')
    setReply('')
    setReplyingThreadId(undefined)
    onApply(nextSource, message)
  }
  const fail = (error: unknown) => setProblem(error instanceof Error ? error.message : String(error))

  const decide = (changeId: string, action: 'accepted' | 'rejected') => {
    if (!canDecide) return
    if (onDecide) return onDecide(changeId, action)
    try {
      const result = decidePortableSuggestion(document, changeId, action, localAuthor, collaborativeReview)
      apply(result.source, result.message)
    } catch (error) {
      fail(error)
    }
  }

  const resolveDecisionConflict = (changeId: string, action: TransactionalReviewAction) => {
    if (!canDecide) return
    const conflict = decisionConflictByChange.get(changeId)
    if (!conflict) {
      setProblem('The concurrent decision set changed. Refresh before resolving it.')
      return
    }
    try {
      const request = { changeId, action, author: localAuthor, resolves: conflict.decisionIds }
      const result = collaborativeReview
        ? collaborativeReview.resolveConflict(request)
        : resolvePortableReviewDecisionConflict(source, request)
      const outcome = action === 'accepted' ? 'accepted' : action === 'rejected' ? 'rejected' : 'marked for rebase'
      apply(
        materializeResolvedSuggestions(parseReviewMarkup(result.source)),
        `Concurrent decisions resolved · suggestion ${outcome}${result.rebasedChangeIds.length ? ` · ${result.rebasedChangeIds.length} overlapping alternative${result.rebasedChangeIds.length === 1 ? '' : 's'} need rebase` : ''}`,
      )
    } catch (error) {
      fail(error)
    }
  }

  const sendReply = (threadId: string) => {
    if (!canComment || !reply.trim()) return
    try {
      const withAuthor = ensureReviewAuthor(document, localAuthor).document
      const result = appendReviewThreadMessage(withAuthor, threadId, { authorId: localAuthor.id, message: reply.trim() })
      apply(result.document.source, 'Reply added to the portable review thread')
    } catch (error) {
      fail(error)
    }
  }

  const changeThreadStatus = (threadId: string, status: 'open' | 'resolved' | 'deleted') => {
    if (!canDecide) return
    try {
      const result = setReviewThreadStatus(document, threadId, status)
      setCollapsedThreadIds((current) => current.filter((id) => id !== threadId))
      setExpandedResolvedThreadIds((current) => current.filter((id) => id !== threadId))
      apply(result.document.source, status === 'open' ? 'Comment thread reopened' : status === 'resolved' ? 'Comment thread resolved' : 'Comment thread removed from the active queue')
    } catch (error) {
      fail(error)
    }
  }

  const rebase = (changeId: string) => {
    if (!canDecide) return
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
      apply(result.document.source, 'Revised suggestion ready for review')
    } catch (error) {
      fail(error)
    }
  }

  const create = () => {
    if ((compose === 'comment' && !canComment) || (compose === 'suggestion' && !canSuggest) || !compose) return
    const selected = compose === 'comment' ? commentTarget?.quote ?? '' : quote.trim()
    if (!selected || !body.trim()) {
      setProblem(compose === 'comment' ? 'Select manuscript text and write a comment.' : 'Enter an exact manuscript quote and a replacement.')
      return
    }
    try {
      const target = compose === 'comment' ? commentTarget?.proposalTarget : undefined
      let nextSource: string
      if (target) {
        const change = document.changes.find(candidate => candidate.id === target.changeId)
        const content = change?.proposal === undefined ? undefined : Fragment.fromArray(parseInlineReviewWording(change.proposal, change.id))
        if (!content || !inlineReviewTargetRange(content, target)) {
          throw Error('The suggested text changed. Select it again before adding the comment.')
        }
        nextSource = createReviewThreadOnProposal(source, target, localAuthor, body.trim()).document.source
      } else {
        const matches = uniqueQuote(source, selected)
        const occurrence = compose === 'comment' ? commentTarget?.occurrence : selectedTarget?.quote === selected ? selectedOccurrence : undefined
        const selectedMatch = occurrence !== undefined ? matches[occurrence] : undefined
        if (compose === 'comment' && selectedMatch === undefined) throw Error('The selected text has changed. Select it again before adding the comment.')
        if (selectedMatch === undefined && matches.length !== 1) {
          throw Error(matches.length === 0 ? 'That quote was not found in the manuscript.' : 'That quote occurs more than once; use a longer selection.')
        }
        const start = selectedMatch ?? matches[0]
        const end = start + selected.length
        nextSource = (compose === 'comment'
          ? createReviewThread(source, { start, end, author: localAuthor, message: body.trim() })
          : createReviewChange(source, { start, end, author: localAuthor, kind: 'replace', proposal: body })).document.source
      }
      setCompose(null)
      setCommentTarget(null)
      setQuote('')
      setBody('')
      apply(nextSource, compose === 'comment' ? 'Portable comment created' : 'Portable suggestion created')
    } catch (error) {
      fail(error)
    }
  }

  const placeCandidate = (anchorId: string, start: number, end: number) => {
    if (!canDecide) return
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
    if (!canDecide) return
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

  return (
    <>
      {problem && <div className="portable-review-problem" role="alert">{problem}</div>}
      {queue.map((item) => {
        const active = item.id === activeId
        if (item.kind === 'change' || item.kind === 'unplaced-change') {
          const change = document.changes.find((candidate) => candidate.id === item.id)!
          const locationDetail = item.kind === 'unplaced-change' ? 'Location needs attention'
            : change.changeKind === 'insert' ? undefined : item.excerpt
          const hasAlternative = item.conflictId && document.changes.some((candidate) =>
            candidate.id !== change.id && candidate.anchorId === change.anchorId && candidate.status === 'open')
          let label = item.kind === 'unplaced-change' ? 'Unplaced suggestion' : 'Suggestion'
          if (item.conflictId) label = hasAlternative ? 'Alternative suggestion' : 'Overlapping suggestion'
          const recovery = recoveryByAnchor.get(item.anchorId)
          const decisionConflict = decisionConflictByChange.get(item.id)
          const overlappingAcceptance = active && canDecide && change.status === 'decision-conflict' && !decisionConflict
            ? collaborativeReview?.overlappingAcceptance(item.id, localAuthor.id) : undefined
          return (
            <div className={`conflict-card portable-review-card ${active ? 'active' : ''}`} id={`review-item-${item.id}`} data-review-balloon={item.id} data-review-balloon-anchor={item.anchorId} key={item.id}>
              <div className="conflict-heading"><Icon name="branch" size={16} /><span>{label}</span></div>
              <button className={`proposal-option ${active ? 'selected' : ''}`} onClick={() => activate(item.id)}>
                <span className="avatar avatar-blue avatar-small">{initials(item.authorName)}</span>
                <span className="proposal-author"><strong>{item.authorName}</strong><small><ReviewTimestamp value={change.updatedAt ?? change.createdAt} verb={change.updatedAt ? 'Updated' : 'Created'} fallback={locationDetail ?? ''} detail={locationDetail} /></small></span>
                <span className={`status-pill status-${item.status}`}>{statusLabel(item.status)}</span>
                <span className="proposal-copy">{change.changeKind !== 'insert' && <del>{change.anchorContext?.quote || item.excerpt}</del>}{change.proposal !== undefined && <ins>{reviewProposalText(change.proposal)}</ins>}</span>
              </button>
              {change.rationale && <div className="proposal-rationale">“{change.rationale}”</div>}
              {canDecide && active && change.status === 'open' && item.kind !== 'unplaced-change' && (
                <div className="review-actions"><button className="accept" onClick={() => decide(item.id, 'accepted')}><Icon name="check" size={15} /> Accept</button><button className="reject" onClick={() => decide(item.id, 'rejected')}><Icon name="x" size={15} /> Reject</button></div>
              )}
              {canDecide && active && change.status === 'needs-rebase' && (
                <>
                  <div className="review-actions"><button className="accept" onClick={() => { setRebaseChangeId(item.id); setRebaseQuote(selectedTarget?.quote ?? ''); setRebaseProposal(change.proposal ?? '') }}><Icon name="branch" size={15} /> Rebase suggestion</button><button className="reject" onClick={() => decide(item.id, 'rejected')}><Icon name="x" size={15} /> Reject alternative</button></div>
                  {rebaseChangeId === item.id && (
                    <div className="review-rebase-form" ref={rebaseRef} role="group" aria-label="Rebase suggestion">
                      <p>Copy the passage this suggestion refers to from the current manuscript.</p>
                      <label><span>Text in accepted manuscript</span><input value={rebaseQuote} onChange={(event) => setRebaseQuote(event.target.value)} placeholder="Select text in Final preview or paste it here" /></label>
                      {change.changeKind !== 'delete' && <label><span>Revised proposal</span><textarea value={rebaseProposal} onChange={(event) => setRebaseProposal(event.target.value)} rows={3} /></label>}
                      <div><button onClick={() => setRebaseChangeId(undefined)}>Cancel</button><button className="primary-button" onClick={() => rebase(item.id)}>Create rebased proposal</button></div>
                    </div>
                  )}
                </>
              )}
              {active && change.status === 'decision-conflict' && decisionConflict && (
                <div className="review-decision-conflict" role="group" aria-label="Resolve concurrent review decisions">
                  <div><Icon name="branch" size={15} /><span><strong>Concurrent decisions need review</strong><small>{decisionConflict.actions.map(statusLabel).join(' and ')} were recorded from the same shared revision. No choice was discarded.</small></span></div>
                  {canDecide
                    ? <div className="review-actions"><button className="accept" onClick={() => resolveDecisionConflict(item.id, 'accepted')}><Icon name="check" size={14} /> Keep accepted</button><button className="reject" onClick={() => resolveDecisionConflict(item.id, 'rejected')}><Icon name="x" size={14} /> Keep rejected</button><button className="rebase" onClick={() => resolveDecisionConflict(item.id, 'rebased')}><Icon name="branch" size={14} /> Require rebase</button></div>
                    : <p>An owner or editor must choose the recorded outcome before the next checkpoint.</p>}
                </div>
              )}
              {active && change.status === 'decision-conflict' && !decisionConflict && collaborativeReview && (
                <div className="review-decision-conflict" role="group" aria-label="Overlapping acceptances">
                  <p>Two overlapping suggestions were accepted. A reviewer can withdraw their acceptance to keep the other wording.</p>
                  {overlappingAcceptance && <button onClick={() => {
                    try { apply(collaborativeReview.repeatOrUndoDecision(overlappingAcceptance, localAuthor, false).source, 'Acceptance withdrawn') }
                    catch (error) { fail(error) }
                  }}>Withdraw my acceptance</button>}
                </div>
              )}
              {canDecide && active && item.kind === 'unplaced-change' && recovery && (
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
        const resolved = thread.status === 'resolved'
        const collapsed = resolved ? !expandedResolvedThreadIds.includes(item.id) : collapsedThreadIds.includes(item.id)
        const contentId = `review-comment-content-${item.id}`
        return (
          <div className={`comment-card portable-review-card portable-comment-bubble ${active ? 'active' : ''} ${thread.status === 'resolved' ? 'resolved' : ''} ${collapsed ? 'collapsed' : ''}`} id={`review-item-${item.id}`} data-review-balloon={item.id} data-review-balloon-anchor={item.anchorId} key={item.id} onClick={() => setActiveId(item.id)}>
            <div className="portable-comment-header">
              <div className="comment-author"><span className="avatar avatar-clay avatar-small">{initials(item.authorName)}</span><span><strong>{item.authorName}</strong><small><ReviewTimestamp value={thread.createdAt} verb="Created" fallback={item.kind === 'unplaced-thread' ? 'Location needs attention' : 'Comment'} /></small></span></div>
              {resolved && <div className="portable-comment-resolved-actions"><span className="portable-comment-resolved-label"><Icon name="check" size={12} /> Resolved</span>{canDecide && item.kind !== 'unplaced-thread' && <button className="portable-comment-reopen" aria-label="Reopen comment" onClick={() => changeThreadStatus(item.id, 'open')}>Reopen</button>}</div>}
              <button className="portable-comment-toggle" aria-label={`${collapsed ? 'Expand' : 'Collapse'} comment by ${item.authorName}`} aria-expanded={!collapsed} aria-controls={collapsed ? undefined : contentId} onClick={(event) => {
                event.stopPropagation()
                if (collapsed) setActiveId(item.id)
                if (resolved) setExpandedResolvedThreadIds((current) => collapsed ? [...current, item.id] : current.filter((id) => id !== item.id))
                else setCollapsedThreadIds((current) => collapsed ? current.filter((id) => id !== item.id) : [...current, item.id])
              }}><Icon name="chevronDown" size={15} /></button>
            </div>
            {!collapsed && <div className="portable-comment-content" id={contentId}>
              {thread.messageRecords.map((message, index) => index === 0
                ? <p className="portable-comment-body" key={`${item.id}-${index}`}>{message.content}</p>
                : <div className="reply-message portable-comment-reply" key={`${item.id}-${index}`}><span className="avatar avatar-sage avatar-small">{initials(authors.get(message.authorId ?? '') ?? message.authorId ?? 'A')}</span><div><div className="portable-comment-reply-meta"><strong>{authors.get(message.authorId ?? '') ?? message.authorId ?? 'Author'}</strong>{message.timestamp && <small><ReviewTimestamp value={message.timestamp} fallback="" /></small>}</div><p>{message.content}</p></div></div>)}
              {item.kind !== 'unplaced-thread' && (canComment && thread.status === 'open' || canDecide) && <div className="portable-thread-actions">
                {canComment && thread.status === 'open' && replyingThreadId !== item.id && <button className="portable-comment-reply-button" onClick={() => { setActiveId(item.id); setReply(''); setReplyingThreadId(item.id) }}>Reply</button>}
                {canDecide && <>{!resolved && <button className="resolve-button" aria-label="Resolve comment" onClick={() => changeThreadStatus(item.id, 'resolved')}><Icon name="check" size={14} /> Resolve</button>}<button className="portable-delete-thread" aria-label="Delete comment" onClick={() => changeThreadStatus(item.id, 'deleted')}><Icon name="x" size={13} /> Delete</button></>}
              </div>}
              {canComment && replyingThreadId === item.id && thread.status === 'open' && item.kind !== 'unplaced-thread' && (
                <div className="reply-box"><input autoFocus value={reply} onChange={(event) => setReply(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') sendReply(item.id); if (event.key === 'Escape') { setReply(''); setReplyingThreadId(undefined) } }} placeholder="Reply…" aria-label={`Reply to ${item.authorName}`} /><button onClick={() => sendReply(item.id)} disabled={!reply.trim()} aria-label="Send reply"><Icon name="arrowRight" size={15} /></button></div>
              )}
              {canDecide && active && item.kind === 'unplaced-thread' && recovery && (
                <div className="unplaced-review-placement">
                  <p>{recovery.reason}</p>
                  {recovery.candidates.map((match, index) => <div className="unplaced-review-candidate" key={`${match.start}-${match.end}`}><span>{match.excerpt}</span><button onClick={() => placeCandidate(item.anchorId, match.start, match.end)}>Place here {index + 1}</button></div>)}
                  <button className="unplaced-review-manual" onClick={() => { setPlacementAnchorId(item.anchorId); setPlacementQuote(selectedTarget?.quote ?? '') }}>Choose different text</button>
                  {placementAnchorId === item.anchorId && <div className="unplaced-review-form"><label><span>Exact manuscript text</span><input value={placementQuote} onChange={(event) => setPlacementQuote(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') placeAtQuote(item.anchorId) }} /></label><button onClick={() => placeAtQuote(item.anchorId)}>Place review</button></div>}
                </div>
              )}
            </div>}
          </div>
        )
      })}

      {compose && (
        <div className={`portable-review-composer ${compose === 'comment' ? 'portable-comment-composer' : ''}`} ref={composerRef} role="group" aria-label={compose === 'comment' ? 'New comment' : 'New suggestion'} data-review-balloon={compose === 'comment' ? 'new-comment' : undefined} data-review-balloon-target-top={compose === 'comment' && Number.isFinite(composerAnchorTop) ? composerAnchorTop : undefined}>
          {compose === 'suggestion' && <strong>Suggest replacement</strong>}
          {compose === 'suggestion' && <label><span>Exact manuscript text</span><input value={quote} onChange={(event) => { setQuote(event.target.value); setSelectedOccurrence(undefined) }} placeholder="Paste the selected text" /></label>}
          <label>{compose === 'suggestion' && <span>Replacement</span>}<textarea aria-label={compose === 'comment' ? 'Comment' : undefined} placeholder={compose === 'comment' ? 'Write a comment…' : undefined} aria-keyshortcuts={compose === 'comment' ? 'Meta+Enter Control+Enter' : undefined} value={body} onChange={(event) => setBody(event.target.value)} onKeyDown={(event) => {
            if (compose === 'comment' && event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
              event.preventDefault()
              if (body.trim()) create()
            }
          }} rows={3} /></label>
          <div><button onClick={() => { setCompose(null); setCommentTarget(null); setBody('') }}>Cancel</button><button className="primary-button" onClick={create} disabled={!body.trim()}>{compose === 'comment' ? 'Add comment' : 'Add'}</button></div>
        </div>
      )}

      {showFooter && <div className="review-panel-footer portable-review-footer">
        {canComment && <button disabled={!selectedTarget?.quote} title={selectedTarget?.quote ? 'Comment on the selected text' : 'Select manuscript text to add a comment'} onClick={() => { setCompose('comment'); setProblem(''); setCommentTarget(selectedTarget ? { ...selectedTarget } : null); setBody('') }}><Icon name="message" size={15} /> New comment</button>}
        {canSuggest && <button onClick={() => { setCompose('suggestion'); setProblem(''); setQuote(selectedTarget?.quote ?? ''); setSelectedOccurrence(selectedTarget?.occurrence) }}><Icon name="spark" size={15} /> Suggest edit</button>}
        <span>{navigableQueue.length ? `${Math.max(1, activePosition + 1)} of ${navigableQueue.length}` : 'No review items'}</span>
        <button onClick={() => navigate('previous')} disabled={navigableQueue.length < 2} aria-label="Previous review item">↑</button>
        <button onClick={() => navigate('next')} disabled={navigableQueue.length < 2} aria-label="Next review item">↓</button>
      </div>}
    </>
  )
}
