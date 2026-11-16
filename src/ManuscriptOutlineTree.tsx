import { useId, useMemo, useState } from 'react'
import { Icon } from './Icon'
import './manuscriptOutlineTree.css'

export interface ManuscriptOutlineItem {
  id: string
  title: string
  level: number
}

export interface ManuscriptOutlineTreeProps<T extends ManuscriptOutlineItem = ManuscriptOutlineItem> {
  items: readonly T[]
  activeId?: string
  query?: string
  maxDepth?: number
  onSelect: (item: T) => void
}

interface OutlineBranch<T extends ManuscriptOutlineItem> {
  item: T
  children: OutlineBranch<T>[]
  containsCurrent: boolean
  documentTitle?: boolean
}

function branchesFor<T extends ManuscriptOutlineItem>(items: readonly T[], activeId?: string) {
  const roots: OutlineBranch<T>[] = []
  const parents: OutlineBranch<T>[] = []
  // A single leading H1 is the document title, not a disclosure hiding every
  // article section. Multiple H1s remain ordinary chapter headings.
  const hasDocumentTitle = items[0]?.level === 1 && !items.slice(1).some((item) => item.level === 1)
  for (const [index, item] of items.entries()) {
    const branch: OutlineBranch<T> = { item, children: [], containsCurrent: item.id === activeId }
    if (hasDocumentTitle && index === 0) {
      branch.documentTitle = true
      roots.push(branch)
      continue
    }
    while (parents.length && parents.at(-1)!.item.level >= item.level) parents.pop()
    if (parents.length) parents.at(-1)!.children.push(branch)
    else roots.push(branch)
    if (branch.containsCurrent) parents.forEach((parent) => { parent.containsCurrent = true })
    parents.push(branch)
  }
  return roots
}

function filteredBranches<T extends ManuscriptOutlineItem>(branches: OutlineBranch<T>[], query: string, maxDepth: number, ancestorMatched = false): OutlineBranch<T>[] {
  return branches.flatMap((branch) => {
    if (branch.item.level > maxDepth) return []
    const matches = ancestorMatched || !query || branch.item.title.toLocaleLowerCase().includes(query)
    const children = filteredBranches(branch.children, query, maxDepth, matches)
    return matches || children.length ? [{ ...branch, children }] : []
  })
}

/** Compact section navigation with independent, keyboard-accessible disclosures. */
export function ManuscriptOutlineTree<T extends ManuscriptOutlineItem>({ items, activeId, query = '', maxDepth = 6, onSelect }: ManuscriptOutlineTreeProps<T>) {
  const treeId = useId()
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const branches = useMemo(() => filteredBranches(branchesFor(items, activeId), normalizedQuery, maxDepth), [items, activeId, normalizedQuery, maxDepth])

  const toggle = (id: string) => setExpanded((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const renderBranch = (branch: OutlineBranch<T>, index: string) => {
    const { item, children } = branch
    const hasChildren = children.length > 0
    const isExpanded = hasChildren && (Boolean(normalizedQuery) || expanded.has(item.id))
    const isCurrent = item.id === activeId
    const containsHiddenCurrent = !isCurrent && branch.containsCurrent
      && (!isExpanded || !children.some((child) => child.containsCurrent))
    const groupId = `${treeId}-section-${index}`
    return <li key={item.id} className={branch.documentTitle ? 'outline-document-title' : undefined}>
      <div className="outline-section-row">
        {hasChildren ? <button
          type="button"
          className="outline-disclosure"
          aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${item.title}`}
          aria-expanded={isExpanded}
          aria-controls={groupId}
          disabled={Boolean(normalizedQuery)}
          title={normalizedQuery ? 'Clear the search to collapse sections' : `${isExpanded ? 'Hide' : 'Show'} subsections`}
          onClick={() => toggle(item.id)}
        ><Icon name="chevronDown" size={14} /></button> : <span className="outline-disclosure-spacer" aria-hidden="true" />}
        <button
          type="button"
          className={`outline-navigation${isCurrent ? ' active' : ''}${containsHiddenCurrent ? ' contains-current' : ''}`}
          aria-current={isCurrent || containsHiddenCurrent ? 'location' : undefined}
          aria-description={containsHiddenCurrent ? 'Contains the current subsection' : undefined}
          onClick={() => onSelect(item)}
        ><span>{item.title}</span></button>
      </div>
      {hasChildren && <ul id={groupId} hidden={!isExpanded} aria-label={`${item.title} subsections`}>{isExpanded && children.map((child, childIndex) => renderBranch(child, `${index}-${childIndex}`))}</ul>}
    </li>
  }

  if (!branches.length) return <p className="outline-empty" role="status">{normalizedQuery
    ? 'No headings match this search.'
    : items.length ? 'No headings within this depth.' : 'Add a heading to build the outline.'}</p>

  return <ul className="manuscript-outline-tree" aria-label="Manuscript sections">{branches.map((branch, index) => renderBranch(branch, String(index)))}</ul>
}
