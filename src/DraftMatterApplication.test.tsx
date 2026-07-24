// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DraftMatterApplication } from './DraftMatterApplication'

vi.mock('./App', () => ({
  default: ({ initialExperience }: { initialExperience?: string }) => <div data-testid="editor">{initialExperience ?? 'editor'}</div>,
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
  sessionStorage.clear()
  window.history.replaceState({}, '', '/')
})

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (check()) return
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 10)))
  }
  throw new Error('Timed out waiting for the application Home state.')
}

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('DraftMatter application entry', () => {
  it('shows the approved signed-out Home story without opening editor content', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(<DraftMatterApplication />))

    expect(container.querySelector('[data-testid="editor"]')).toBeNull()
    expect(container.textContent).toContain('A calm workspace for rigorous research')
    expect(container.querySelector('h1')?.textContent).toBe('Your paper should not be the least reproducible part of your research.')
    expect(container.textContent).toContain('Research writing, with the missing pieces built in.')
    expect(container.textContent).toContain('DraftMatter brings writing, citations, reproducible results, review, and collaboration into one focused workspace. Everything is available when needed and quiet when it is not.')
    expect(container.textContent).toContain('Start writing')
    expect(container.textContent).toContain('See how it works')
    expect(container.textContent).toContain('Stay in the flow')
    expect(container.textContent).not.toContain('Keep reproducible results close to the writing.')
    await act(async () => root.unmount())
    container.remove()
  })

  it('scrolls the See how it works action to the guided showcase', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => root.render(<DraftMatterApplication />))
    const action = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('See how it works'))!
    await act(async () => action.click())

    expect(container.querySelector('#home-showcase')).not.toBeNull()
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' })
    await act(async () => root.unmount())
    container.remove()
  })

  it('opens an editable browser copy from Start writing when no collaboration service is configured', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(<DraftMatterApplication />))
    const start = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Start writing'))!
    await act(async () => start.click())

    expect(window.location.search).toBe('?example=complete')
    expect(container.querySelector('[data-testid="editor"]')?.textContent).toBe('complete-example')
    await act(async () => root.unmount())
  })

  it('preserves the signed-in Home as a task-focused draft catalogue', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/api/session')) return jsonResponse({ userId: 'researcher-1', displayName: 'Ari Morgan' })
      if (url.endsWith('/api/workspaces')) {
        return jsonResponse({
          workspaces: [{ id: 'lab', name: 'Ecology lab', role: 'owner', createdAt: '2026-01-02T00:00:00.000Z' }],
        })
      }
      if (url.endsWith('/api/workspaces/lab/projects')) {
        return jsonResponse({
          projects: [{ id: 'canopy', workspaceId: 'lab', name: 'Canopy recovery paper', createdAt: '2026-01-03T00:00:00.000Z' }],
        })
      }
      if (url.endsWith('/api/onboarding')) {
        return jsonResponse({ completedTaskIds: ['create-or-open'], dismissed: true, updatedAt: '2026-01-04T00:00:00.000Z' })
      }
      return new Response(null, { status: 404 })
    }))

    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => root.render(<DraftMatterApplication collaboration={{ initialServiceUrl: 'http://127.0.0.1:4319' }} />))

    const advanced = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Advanced connection setup'))!
    await act(async () => advanced.click())
    const token = container.querySelector<HTMLInputElement>('input[type="password"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(token, 'short-lived-test-token')
      token.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const submit = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Use this service')!
    await act(async () => submit.click())
    await waitFor(() => container.querySelector('.home-catalogue') !== null)

    expect(container.querySelector('.home-catalogue h1')?.textContent).toBe('Drafts')
    expect(container.textContent).toContain('Canopy recovery paper')
    expect(container.textContent).toContain('New draft')
    expect(container.querySelector('.home-showcase')).toBeNull()
    expect(container.textContent).not.toContain('Your paper should not be the least reproducible part of your research.')

    await act(async () => root.unmount())
    container.remove()
  })
})
