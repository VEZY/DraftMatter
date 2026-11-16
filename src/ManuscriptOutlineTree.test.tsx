// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ManuscriptOutlineTree, type ManuscriptOutlineItem, type ManuscriptOutlineTreeProps } from './ManuscriptOutlineTree'

const sections = [
  { id: 'title', title: 'A study of plants', level: 1, position: 0 },
  { id: 'intro', title: 'Introduction', level: 2, position: 2 },
  { id: 'motivation', title: 'Motivation', level: 3, position: 4 },
  { id: 'methods', title: 'Methods', level: 2, position: 6 },
  { id: 'sampling', title: 'Sampling', level: 3, position: 8 },
  { id: 'replication', title: 'Replication', level: 4, position: 10 },
  { id: 'analysis', title: 'Analysis', level: 3, position: 12 },
  { id: 'results', title: 'Results', level: 2, position: 14 },
]
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

async function render(props: Partial<ManuscriptOutlineTreeProps> = {}) {
  await act(async () => root.render(<ManuscriptOutlineTree items={sections} onSelect={vi.fn()} {...props} />))
}
const disclosure = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('.outline-disclosure')].find((button) => button.getAttribute('aria-label') === label)!
const navigation = (title: string) => [...container.querySelectorAll<HTMLButtonElement>('.outline-navigation')].find((button) => button.querySelector('span')?.textContent === title)!
const visibleTitles = () => [...container.querySelectorAll('.outline-navigation > span')].map((element) => element.textContent)

describe('collapsible manuscript outline', () => {
  it('shows the document title and main article sections without hiding them behind the H1', async () => {
    await render()
    expect(visibleTitles()).toEqual(['A study of plants', 'Introduction', 'Methods', 'Results'])
    expect(disclosure('Expand Methods').getAttribute('aria-expanded')).toBe('false')
    const controlledGroup = document.getElementById(disclosure('Expand Methods').getAttribute('aria-controls')!)!
    expect(controlledGroup.hidden).toBe(true)
    expect(container.querySelector('.outline-document-title .outline-disclosure')).toBeNull()
  })

  it('keeps disclosure separate from navigation and preserves the original selection item', async () => {
    const select = vi.fn()
    await render({ onSelect: select })
    await act(async () => disclosure('Expand Methods').click())
    expect(select).not.toHaveBeenCalled()
    expect(visibleTitles()).toEqual(['A study of plants', 'Introduction', 'Methods', 'Sampling', 'Analysis', 'Results'])
    await act(async () => navigation('Sampling').click())
    expect(select).toHaveBeenCalledWith(sections[4])
    expect(select.mock.calls[0][0].position).toBe(8)
    expect(disclosure('Collapse Methods').getAttribute('aria-expanded')).toBe('true')
  })

  it('preserves nested disclosures across collapse, ordinary outline updates and active-section changes', async () => {
    await render()
    await act(async () => disclosure('Expand Methods').click())
    await act(async () => disclosure('Expand Sampling').click())
    expect(visibleTitles()).toContain('Replication')
    await act(async () => disclosure('Collapse Methods').click())
    await render({ items: sections.map((item) => ({ ...item, position: item.position + 100 })), activeId: 'replication' })
    expect(visibleTitles()).not.toContain('Sampling')
    expect(navigation('Methods').getAttribute('aria-current')).toBe('location')
    expect(navigation('Methods').getAttribute('aria-description')).toBe('Contains the current subsection')
    await act(async () => disclosure('Expand Methods').click())
    expect(visibleTitles()).toContain('Replication')
    expect(navigation('Replication').getAttribute('aria-current')).toBe('location')
    expect(navigation('Methods').hasAttribute('aria-current')).toBe(false)
  })

  it('reveals matching descendants and ancestors without replacing saved expansion state', async () => {
    await render({ query: ' REPLICATION ' })
    expect(visibleTitles()).toEqual(['Methods', 'Sampling', 'Replication'])
    expect(disclosure('Collapse Methods').disabled).toBe(true)
    await render({ query: '' })
    expect(visibleTitles()).toEqual(['A study of plants', 'Introduction', 'Methods', 'Results'])
    await act(async () => disclosure('Expand Introduction').click())
    await render({ query: 'replication' })
    await render({ query: '' })
    expect(visibleTitles()).toContain('Motivation')
    expect(visibleTitles()).not.toContain('Sampling')
  })

  it('honors depth filters and reports no results honestly', async () => {
    await render({ maxDepth: 2, activeId: 'replication' })
    expect(visibleTitles()).toEqual(['A study of plants', 'Introduction', 'Methods', 'Results'])
    expect(container.querySelector('.outline-disclosure')).toBeNull()
    expect(navigation('Methods').getAttribute('aria-current')).toBe('location')
    await render({ query: 'replication', maxDepth: 2 })
    expect(container.querySelector('[role="status"]')?.textContent).toBe('No headings match this search.')
    await render({ items: [], query: '' })
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Add a heading to build the outline.')
  })

  it('handles skipped levels and duplicate titles without conflating their disclosures', async () => {
    const items: ManuscriptOutlineItem[] = [
      { id: 'one', title: 'Methods', level: 2 },
      { id: 'one-child', title: 'Details', level: 4 },
      { id: 'two', title: 'Methods', level: 2 },
      { id: 'two-child', title: 'Details', level: 3 },
    ]
    await render({ items })
    const expanders = container.querySelectorAll<HTMLButtonElement>('.outline-disclosure')
    await act(async () => expanders[0].click())
    expect(visibleTitles()).toEqual(['Methods', 'Details', 'Methods'])
    expect(expanders[1].getAttribute('aria-expanded')).toBe('false')
    await act(async () => expanders[1].click())
    expect(visibleTitles()).toEqual(['Methods', 'Details', 'Methods', 'Details'])
  })

  it('treats multiple H1 headings as independently collapsible chapters', async () => {
    await render({ items: [
      { id: 'one', title: 'Chapter one', level: 1 },
      { id: 'one-section', title: 'First section', level: 2 },
      { id: 'two', title: 'Chapter two', level: 1 },
      { id: 'two-section', title: 'Second section', level: 2 },
    ] })
    expect(visibleTitles()).toEqual(['Chapter one', 'Chapter two'])
    await act(async () => disclosure('Expand Chapter two').click())
    expect(visibleTitles()).toEqual(['Chapter one', 'Chapter two', 'Second section'])
  })
})
