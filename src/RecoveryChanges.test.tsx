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
    expect(container.textContent).toContain('<script>new()</script>')
    expect(container.querySelector('del')?.textContent).toBe('12')
    expect(container.querySelector('ins')?.textContent).toBe('18')
    expect(container.querySelectorAll('[aria-label^="Removed line"]')).toHaveLength(2)
    expect(container.querySelectorAll('[aria-label^="Added line"]')).toHaveLength(2)
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
