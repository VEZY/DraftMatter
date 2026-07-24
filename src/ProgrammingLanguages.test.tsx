// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { ProgrammingLanguages } from './ProgrammingLanguages'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('programming languages guide', () => {
  it('explains the adaptive project setup without developer-only detail', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const onBack = vi.fn()

    await act(async () => root.render(<ProgrammingLanguages onBack={onBack} />))

    expect(container.querySelector('h1')?.textContent).toBe('Code that belongs to the project.')
    expect(container.textContent).toContain('Existing installations come first.')
    expect(container.textContent).toContain('Project.toml and Manifest.toml')
    expect(container.textContent).toContain('pyproject.toml, uv.lock, and .venv')
    expect(container.textContent).toContain('renv.lock and the renv project library')
    expect(container.textContent).toContain('Execution happens in the desktop app.')
    expect(container.querySelectorAll('.languages-grid article')).toHaveLength(3)

    await act(async () => container.querySelector<HTMLButtonElement>('header button')?.click())
    expect(onBack).toHaveBeenCalledOnce()

    await act(async () => root.unmount())
    container.remove()
  })
})
