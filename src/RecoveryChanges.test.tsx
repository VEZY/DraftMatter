// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { RecoveryChanges } from './RecoveryChanges'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('recovery changes preview', () => {
  it('shows accessible additions and removals as escaped text without executing or rendering source markup', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const previous = '# Results\nA result of 12.\n<script>old()</script>\n'
    const current = '# Results\nA result of 18.\n<script>new()</script>\n'
    await act(async () => root.render(<RecoveryChanges previousSource={previous} currentSource={current} />))
    expect(container.querySelector('[aria-label="Changes from selected version to current manuscript"]')).not.toBeNull()
    expect(container.querySelector('[role="status"]')?.textContent).toContain('2 added lines · 2 removed lines')
    expect(container.querySelector('[aria-label="Source differences"]')?.getAttribute('tabindex')).toBe('0')
    expect(container.querySelectorAll('script')).toHaveLength(0)
    const currentText = container.querySelector('.recovery-changes-lines')!.cloneNode(true) as HTMLElement
    currentText.querySelectorAll('del').forEach((element) => element.remove())
    expect(currentText.textContent).toContain('<script>new()</script>')
    expect(container.querySelector('del')?.textContent).toBe('12')
    expect(container.querySelector('ins')?.textContent).toBe('18')
    expect(container.querySelectorAll('[aria-label^="Changed line"]')).toHaveLength(2)
    expect(container.querySelectorAll('.recovery-changes-row.added, .recovery-changes-row.removed')).toHaveLength(0)
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Word changes highlighted')
    await act(async () => root.unmount())
  })

  it('shows a long paragraph once and highlights only the few distant words that changed', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const shared = 'Plant models connect organ observations with reproducible measurements across scales. '.repeat(55)
    const previous = `# Results\n\nPlants retained early growth. ${shared}This was an exploratory application. ${shared}Independent evidence remains necessary.\n`
    const current = previous.replace('early growth', 'late growth').replace('exploratory application', 'illustrated application')
    expect(previous.length).toBeGreaterThan(2_000)
    await act(async () => root.render(<RecoveryChanges previousSource={previous} currentSource={current} />))
    const changed = container.querySelector('[aria-label="Changed line 3"]')!
    expect(changed).not.toBeNull()
    expect(changed.classList.contains('changed')).toBe(true)
    expect(changed.classList.contains('removed')).toBe(false)
    expect(changed.classList.contains('added')).toBe(false)
    expect([...changed.querySelectorAll('del')].map((element) => element.textContent)).toEqual(['early', 'exploratory'])
    expect([...changed.querySelectorAll('ins')].map((element) => element.textContent)).toEqual(['late', 'illustrated'])
    expect(changed.textContent?.split('Independent evidence remains necessary.')).toHaveLength(2)
    expect(container.querySelectorAll('.recovery-changes-row.changed')).toHaveLength(1)
    expect(container.querySelectorAll('.recovery-changes-row.added, .recovery-changes-row.removed')).toHaveLength(0)
    expect(changed.querySelector('pre')?.textContent?.split('Plant models connect organ observations')).toHaveLength(111)
    await act(async () => root.unmount())
  })

  it('keeps a fully added or deleted line distinct when it has no paired historical line', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(<RecoveryChanges previousSource="" currentSource="A newly added paragraph.\n" />))
    expect(container.querySelector('[aria-label="Added line 1"]')?.textContent).toContain('A newly added paragraph.')
    expect(container.querySelector('.recovery-changes-row.added')).not.toBeNull()
    expect(container.querySelector('.recovery-changes-row.changed')).toBeNull()
    await act(async () => root.render(<RecoveryChanges previousSource="A deleted paragraph.\n" currentSource="" />))
    expect(container.querySelector('[aria-label="Removed line 1"]')?.textContent).toContain('A deleted paragraph.')
    expect(container.querySelector('.recovery-changes-row.removed')).not.toBeNull()
    expect(container.querySelector('.recovery-changes-row.changed')).toBeNull()
    await act(async () => root.unmount())
  })

  it('keeps line-ending-only changes visible in one otherwise unchanged line', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    for (const [previous, current, from, to] of [
      ['Same text\r\n', 'Same text\n', 'CRLF', 'LF'],
      ['Same text', 'Same text\n', 'No newline', 'LF'],
    ]) {
      await act(async () => root.render(<RecoveryChanges previousSource={previous} currentSource={current} />))
      expect(container.querySelectorAll('.recovery-changes-row.changed')).toHaveLength(1)
      expect(container.querySelectorAll('del, ins')).toHaveLength(0)
      expect(container.querySelector(`[aria-label="Line ending changed from ${from} to ${to}"]`)?.textContent).toBe(`${from} → ${to}`)
      expect(container.querySelector('.recovery-changes-row pre')?.textContent?.split('Same text')).toHaveLength(2)
    }
    await act(async () => root.unmount())
  })

  it('explains when a selected saved version is identical to the current manuscript', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(<RecoveryChanges previousSource="Same source" currentSource="Same source" />))
    expect(container.textContent).toContain('same source as your current manuscript')
    expect(container.querySelector('.recovery-changes-lines')).toBeNull()
    await act(async () => root.unmount())
  })
})
