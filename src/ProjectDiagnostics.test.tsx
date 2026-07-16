// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prioritizeProjectDiagnostics, ProjectDiagnostics } from './ProjectDiagnostics'
import type { DocumentDiagnostic } from './types'

const diagnostics: DocumentDiagnostic[] = [
  { code: 'cache-ready', level: 'info', message: 'Offline citation cache is ready.' },
  { code: 'record-renamed', level: 'warning', message: 'A cited record was renamed upstream.' },
  { code: 'lock-invalid', level: 'error', message: 'The citation lock needs repair.' },
  { code: 'provider-offline', level: 'warning', message: 'Zotero is offline; cached records remain readable.' },
  { code: 'style-ready', level: 'info', message: 'Citation style loaded.' },
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
})
