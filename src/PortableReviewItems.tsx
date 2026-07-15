import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon'
import { parseReviewMarkup } from './reviewMarkup'
import {
  appendReviewThreadMessage,
  createReviewChange,
  createReviewThread,
  decideReviewChange,
  ensureReviewAuthor,
  setReviewThreadStatus,
} from './reviewOperations'
import { buildReviewQueue, navigateReviewQueue, type ReviewQueueItem } from './reviewQueue'

const localAuthor = { id: 'dm-local-author', name: 'Remi Vezy' }

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
  onActiveIdChange,
  selectedTarget,
  onApply,
}: {
  source: string
  excludeIds?: string[]
  authorId?: string
  activeId?: string
  navigationItems?: ReviewQueueItem[]
  onActiveIdChange?: (id: string | undefined) => void
  selectedTarget?: { quote: string; occurrence: number } | null
  onApply: (source: string, message: string) => void
}) {
  const document = useMemo(() => parseReviewMarkup(source), [source])
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
  const [reply, setReply] = useState('')
  const [problem, setProblem] = useState('')
  const [compose, setCompose] = useState<'comment' | 'suggestion' | null>(null)
  const [quote, setQuote] = useState('')
  const [selectedOccurrence, setSelectedOccurrence] = useState<number>()
  const [body, setBody] = useState('')
  const composerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!navigableQueue.some((item) => item.id === activeId)) setActiveId(navigableQueue[0]?.id)
  }, [activeId, navigableQueue, setActiveId])

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
    const start = selectedMatch ?? matches[0]
    try {
      const result = compose === 'comment'
        ? createReviewThread(source, { start, end: start + selected.length, author: localAuthor, message: body.trim() })
        : createReviewChange(source, { start, end: start + selected.length, author: localAuthor, kind: 'replace', proposal: body })
      setCompose(null)
      setQuote('')
      setBody('')
      apply(result.document.source, compose === 'comment' ? 'Portable comment created' : 'Portable suggestion created')
    } catch (error) {
      fail(error)
    }
  }

  const navigate = (direction: 'next' | 'previous') => {
    const next = navigateReviewQueue(navigableQueue, activeId, direction)
    setActiveId(next?.id)
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
          return (
            <div className={`conflict-card portable-review-card ${active ? 'active' : ''}`} id={`review-item-${item.id}`} key={item.id}>
              <div className="conflict-heading"><Icon name="branch" size={16} /><span>{item.conflictId ? 'Overlapping suggestion' : item.kind === 'unplaced-change' ? 'Unplaced suggestion' : 'Suggestion'}</span><small>{item.anchorId}</small></div>
              <button className={`proposal-option ${active ? 'selected' : ''}`} onClick={() => setActiveId(item.id)}>
                <span className="avatar avatar-blue avatar-small">{initials(item.authorName)}</span>
                <span className="proposal-author"><strong>{item.authorName}</strong><small>{item.kind === 'unplaced-change' ? 'Location needs attention' : item.excerpt}</small></span>
                <span className={`status-pill status-${item.status}`}>{statusLabel(item.status)}</span>
                <span className="proposal-copy"><del>{change.anchorContext?.quote || item.excerpt}</del>{change.proposal !== undefined && <ins>{change.proposal}</ins>}</span>
              </button>
              {change.rationale && <div className="proposal-rationale">“{change.rationale}”</div>}
              {active && change.status === 'open' && item.kind !== 'unplaced-change' && (
                <div className="review-actions"><button className="accept" onClick={() => decide(item.id, 'accepted')}><Icon name="check" size={15} /> Accept</button><button className="reject" onClick={() => decide(item.id, 'rejected')}><Icon name="x" size={15} /> Reject</button></div>
              )}
              {active && change.status === 'needs-rebase' && <div className="review-actions"><button className="reject" onClick={() => decide(item.id, 'rejected')}><Icon name="x" size={15} /> Reject alternative</button></div>}
            </div>
          )
        }

        const thread = document.threads.find((candidate) => candidate.id === item.id)!
        return (
          <div className={`comment-card portable-review-card ${active ? 'active' : ''} ${thread.status === 'resolved' ? 'resolved' : ''}`} id={`review-item-${item.id}`} key={item.id} onClick={() => setActiveId(item.id)}>
            <div className="comment-author"><span className="avatar avatar-clay avatar-small">{initials(item.authorName)}</span><span><strong>{item.authorName}</strong><small>{item.kind === 'unplaced-thread' ? 'Location needs attention' : statusLabel(thread.status)}</small></span></div>
            <div className="comment-quote">“{thread.anchorContext?.quote || item.excerpt}”</div>
            {thread.messageRecords.map((message, index) => index === 0
              ? <p key={`${item.id}-${index}`}>{message.content}</p>
              : <div className="reply-message" key={`${item.id}-${index}`}><span className="avatar avatar-sage avatar-small">{initials(authors.get(message.authorId ?? '') ?? message.authorId ?? 'A')}</span><p><strong>{authors.get(message.authorId ?? '') ?? message.authorId ?? 'Author'}</strong>{message.content}</p></div>)}
            {active && thread.status === 'open' && item.kind !== 'unplaced-thread' && (
              <div className="reply-box"><input value={reply} onChange={(event) => setReply(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') sendReply(item.id) }} placeholder="Reply…" aria-label={`Reply to ${item.authorName}`} /><button onClick={() => sendReply(item.id)} disabled={!reply.trim()} aria-label="Send reply"><Icon name="arrowRight" size={15} /></button></div>
            )}
            {active && item.kind !== 'unplaced-thread' && <div className="portable-thread-actions"><button className="resolve-button" onClick={() => changeThreadStatus(item.id, thread.status === 'resolved' ? 'open' : 'resolved')}><Icon name="check" size={14} /> {thread.status === 'resolved' ? 'Reopen thread' : 'Resolve thread'}</button><button className="portable-delete-thread" onClick={() => changeThreadStatus(item.id, 'deleted')}><Icon name="x" size={13} /> Remove</button></div>}
          </div>
        )
      })}

      {compose && (
        <div className="portable-review-composer" ref={composerRef} role="group" aria-label={compose === 'comment' ? 'New comment' : 'New suggestion'}>
          <strong>{compose === 'comment' ? 'New comment' : 'Suggest replacement'}</strong>
          <label><span>Exact manuscript text</span><input value={quote} onChange={(event) => { setQuote(event.target.value); setSelectedOccurrence(undefined) }} placeholder="Paste the selected text" /></label>
          <label><span>{compose === 'comment' ? 'Comment' : 'Replacement'}</span><textarea value={body} onChange={(event) => setBody(event.target.value)} rows={3} /></label>
          <div><button onClick={() => setCompose(null)}>Cancel</button><button className="primary-button" onClick={create}>Add</button></div>
        </div>
      )}

      <div className="review-panel-footer portable-review-footer">
        <button onClick={() => { setCompose('comment'); setProblem(''); setQuote(selectedTarget?.quote ?? ''); setSelectedOccurrence(selectedTarget?.occurrence) }}><Icon name="message" size={15} /> New comment</button>
        <button onClick={() => { setCompose('suggestion'); setProblem(''); setQuote(selectedTarget?.quote ?? ''); setSelectedOccurrence(selectedTarget?.occurrence) }}><Icon name="spark" size={15} /> Suggest edit</button>
        <span>{navigableQueue.length ? `${Math.max(1, activePosition + 1)} of ${navigableQueue.length}` : 'No review items'}</span>
        <button onClick={() => navigate('previous')} disabled={navigableQueue.length < 2} aria-label="Previous review item">↑</button>
        <button onClick={() => navigate('next')} disabled={navigableQueue.length < 2} aria-label="Next review item">↓</button>
      </div>
    </>
  )
}
