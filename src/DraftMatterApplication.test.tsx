// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DraftMatterApplication } from './DraftMatterApplication'

vi.mock('./App', () => ({
  default: ({ initialExperience, startExampleTour }: { initialExperience?: string; startExampleTour?: boolean }) => <div data-testid="editor" data-example-tour={startExampleTour ? 'open' : 'closed'}>{initialExperience ?? 'editor'}</div>,
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
  it('shows the signed-out application workspace without the public marketing story', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(<DraftMatterApplication />))

    expect(container.querySelector('[data-testid="editor"]')).toBeNull()
    expect(container.querySelector('h1')?.textContent).toBe('Your papers')
    expect(container.textContent).toContain('Browser workspace')
    expect(container.textContent).toContain('New browser draft')
    expect(container.textContent).toContain('Open the complete example')
    expect(container.textContent).toContain('Set up DraftMatter')
    expect(container.textContent).toContain('AI connections')
    expect(container.textContent).toContain('Account & collaboration')
    expect(container.querySelector('.home-showcase')).toBeNull()
    expect(container.textContent).not.toContain('Your paper should be as reproducible as your research.')
    await act(async () => root.unmount())
    container.remove()
  })

  it.each([
    { reducedMotion: false, behavior: 'smooth' },
    { reducedMotion: true, behavior: 'auto' },
  ] as const)('scrolls the settings action to application setup with $behavior behavior', async ({ reducedMotion, behavior }) => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: reducedMotion })))
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => root.render(<DraftMatterApplication />))
    const action = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Settings & account'))!
    await act(async () => action.click())

    expect(container.querySelector('#home-setup')).not.toBeNull()
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior, block: 'start' })
    await act(async () => root.unmount())
    container.remove()
  })

  it('offers app setup with a direct guided-tour action', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(<DraftMatterApplication />))

    const setup = container.querySelector<HTMLElement>('.home-app-setup')!
    expect(setup.textContent).toContain('Learn the workflow')
    expect(setup.textContent).toContain('How to use DraftMatter')
    expect(setup.textContent).toContain('Account & collaboration')
    const tourAction = [...setup.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Start guided tour'))!
    expect(tourAction.textContent).toContain('Start guided tour')
    await act(async () => tourAction.click())

    expect(window.location.pathname).toBe('/tutorial')
    expect(container.querySelector('[data-testid="editor"]')?.getAttribute('data-example-tour')).toBe('open')

    await act(async () => root.unmount())
  })

  it('opens the programming-languages guide from Home', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(<DraftMatterApplication />))

    const languages = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Languages')!
    await act(async () => languages.click())

    expect(window.location.pathname).toBe('/languages')
    expect(container.querySelector('h1')?.textContent).toBe('Code that belongs to the project.')
    expect(container.textContent).toContain('Existing installations come first.')

    await act(async () => root.unmount())
  })

  it('opens a fresh browser draft from the application home', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(<DraftMatterApplication />))
    const start = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('New browser draft'))!
    await act(async () => start.click())

    expect(window.location.pathname).toBe('/draft')
    expect(container.querySelector('[data-testid="editor"]')?.textContent).toBe('browser-new')
    await act(async () => root.unmount())
  })

  it('opens the complete example independently from the new-paper action', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(<DraftMatterApplication />))
    const example = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Open the complete example'))!
    await act(async () => example.click())

    expect(window.location.search).toBe('?example=complete')
    expect(container.querySelector('[data-testid="editor"]')?.textContent).toBe('complete-example')
    await act(async () => root.unmount())
  })

  it('offers one guided-tour action that opens the complete example', async () => {
    window.history.replaceState({}, '', '/learn')
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(<DraftMatterApplication />))

    expect(container.textContent).toContain('Start guided tour')
    expect(container.textContent).not.toContain('Open complete example')
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Start guided tour'))!.click())

    expect(window.location.pathname).toBe('/tutorial')
    expect(container.querySelector('[data-testid="editor"]')?.textContent).toBe('complete-example')
    expect(container.querySelector('[data-testid="editor"]')?.getAttribute('data-example-tour')).toBe('open')

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

    const advanced = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Collaboration account setup'))!
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
    expect(container.textContent).not.toContain('Your paper should be as reproducible as your research.')

    await act(async () => root.unmount())
    container.remove()
  })
})
