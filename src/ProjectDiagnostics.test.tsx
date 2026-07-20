// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prioritizeProjectDiagnostics, ProjectChecksDialog, ProjectDiagnostics, projectDiagnosticCategory, projectDiagnosticCounts } from './ProjectDiagnostics'
import type { DocumentDiagnostic } from './types'

const diagnostics: DocumentDiagnostic[] = [
  { code: 'cache-ready', level: 'info', message: 'Offline citation cache is ready.' },
  { code: 'record-renamed', level: 'warning', message: 'A cited record was renamed upstream.' },
  { code: 'lock-invalid', level: 'error', message: 'The citation lock needs repair.' },
  { code: 'provider-offline', level: 'warning', message: 'Zotero is offline; cached records remain readable.' },
  { code: 'style-ready', level: 'info', message: 'Citation style loaded.' },
]

const categorizedDiagnostics: DocumentDiagnostic[] = [
  { code: 'frontmatter-unclosed', level: 'info', message: 'The frontmatter block is not closed.' },
  { code: 'execution-kernel-missing', level: 'warning', message: 'The selected computation kernel is unavailable.' },
  { code: 'citation-lock-invalid', level: 'error', message: 'The citation lock needs repair before publication.' },
  { code: 'export-pdf-unavailable', level: 'warning', message: 'PDF export is not currently available.' },
  { code: 'output-artifact-missing', level: 'error', message: 'A retained output artifact is missing.' },
]

describe('project diagnostics', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

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

  it('prioritizes errors and warnings without changing order inside a severity', () => {
    expect(prioritizeProjectDiagnostics(diagnostics).map((diagnostic) => diagnostic.code)).toEqual([
      'lock-invalid',
      'record-renamed',
      'provider-offline',
      'cache-ready',
      'style-ready',
    ])
  })

  it('keeps every project check reachable while previewing the highest-priority three', async () => {
    await act(async () => root.render(<ProjectDiagnostics diagnostics={diagnostics} />))

    expect(container.querySelector('section')?.getAttribute('aria-label')).toBe('5 project checks')
    expect([...container.querySelectorAll('.project-diagnostic-list')][0].textContent).toContain('citation lock needs repair')
    expect([...container.querySelectorAll('.project-diagnostic-list')][0].textContent).not.toContain('Citation style loaded')
    expect(container.querySelector('summary')?.textContent).toBe('Show 2 more checks')
    expect(container.querySelectorAll('[role="listitem"]')).toHaveLength(5)
    expect(container.textContent).toContain('Offline citation cache is ready.')
    expect(container.textContent).toContain('Citation style loaded.')
  })

  it('adds a direct action from the compact preview to the complete checks view', async () => {
    const viewAll = vi.fn()
    await act(async () => root.render(<ProjectDiagnostics diagnostics={diagnostics} onViewAll={viewAll} />))

    const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent === 'View all checks')!
    await act(async () => button.click())
    expect(viewAll).toHaveBeenCalledOnce()
  })

  it('shows severity counts, errors first, conservative groups, full messages, and subdued codes', async () => {
    const action = vi.fn()
    await act(async () => root.render(<ProjectChecksDialog diagnostics={categorizedDiagnostics} onClose={vi.fn()} onAction={action} />))

    expect(container.querySelector('.project-check-counts')?.getAttribute('aria-label')).toBe('2 errors, 2 warnings, 1 informational checks')
    expect([...container.querySelectorAll('.project-check-item')].map((item) => item.className)).toEqual([
      'project-check-item diagnostic-error',
      'project-check-item diagnostic-error',
      'project-check-item diagnostic-warning',
      'project-check-item diagnostic-warning',
      'project-check-item diagnostic-info',
    ])
    expect(container.querySelectorAll('.project-check-item')).toHaveLength(5)
    expect(container.textContent).toContain('The citation lock needs repair before publication.')
    expect([...container.querySelectorAll('code')].map((code) => code.textContent)).toContain('output-artifact-missing')
    expect([...container.querySelectorAll('h4')].map((heading) => heading.textContent)).toEqual(['Citations', 'Outputs', 'Computation', 'Export', 'Source'])

    const citations = [...container.querySelectorAll<HTMLButtonElement>('.project-check-group button')].find((button) => button.textContent === 'Open citations')!
    await act(async () => citations.click())
    expect(action).toHaveBeenCalledWith('citations')
  })

  it('shows a clear empty state and updates from the same live diagnostic props', async () => {
    await act(async () => root.render(<ProjectChecksDialog diagnostics={[]} onClose={vi.fn()} />))
    expect(container.textContent).toContain('No project issues detected.')

    await act(async () => root.render(<ProjectChecksDialog diagnostics={categorizedDiagnostics.slice(0, 4)} onClose={vi.fn()} />))
    expect(container.textContent).not.toContain('No project issues detected.')
    expect(container.querySelectorAll('.project-check-item')).toHaveLength(4)
    expect(projectDiagnosticCounts(categorizedDiagnostics)).toEqual({ error: 2, warning: 2, info: 1 })
    expect(projectDiagnosticCategory(categorizedDiagnostics[2])).toBe('Citations')
  })

  it('focuses its visible close button, traps boundary tabs, and closes with Escape', async () => {
    const close = vi.fn()
    await act(async () => root.render(<ProjectChecksDialog diagnostics={categorizedDiagnostics} onClose={close} onAction={vi.fn()} />))
    const closeButton = container.querySelector<HTMLButtonElement>('[aria-label="Close Project checks"]')!
    const lastAction = [...container.querySelectorAll<HTMLButtonElement>('.project-check-group button')].at(-1)!
    expect(document.activeElement).toBe(closeButton)

    await act(async () => {
      lastAction.focus()
      lastAction.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    })
    expect(document.activeElement).toBe(closeButton)

    await act(async () => closeButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(close).toHaveBeenCalledOnce()
  })
})
