// @vitest-environment jsdom

import { act, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { StructuredManuscriptEditor, type StructuredManuscriptEditorHandle } from './StructuredManuscriptEditor'
import { articleSizedFixture } from './performanceFixture'

describe('DM-P5-07 article-sized interactive performance gate', () => {
  it('mounts and edits a 90-page rendered manuscript within recorded CI budgets', async () => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    if (typeof HTMLElement.prototype.scrollIntoView !== 'function') {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => undefined })
    }
    const source = articleSizedFixture()
    const container = document.createElement('div')
    const editor = createRef<StructuredManuscriptEditorHandle>()
    const changes: string[] = []
    document.body.append(container)
    const root = createRoot(container)

    try {
      const mountStart = performance.now()
      await act(async () => root.render(
        <StructuredManuscriptEditor ref={editor} source={source} onChange={(next) => changes.push(next)} />,
      ))
      const mountMs = performance.now() - mountStart

      expect(container.querySelectorAll('h2')).toHaveLength(90)
      expect(container.querySelectorAll('table')).toHaveLength(90)
      expect(mountMs, `rendered editor mount took ${mountMs.toFixed(1)} ms`).toBeLessThan(5_000)

      const editStart = performance.now()
      await act(async () => {
        expect(editor.current?.insertHeading('Performance checkpoint', 2, 'sec-performance-checkpoint')).toBe(true)
      })
      const editMs = performance.now() - editStart

      expect(changes).toHaveLength(1)
      expect(changes[0]).toContain('## Performance checkpoint {#sec-performance-checkpoint}')
      expect(changes[0].length).toBeGreaterThan(250_000)
      expect(editMs, `structured edit and serialization took ${editMs.toFixed(1)} ms`).toBeLessThan(1_500)
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })
})
