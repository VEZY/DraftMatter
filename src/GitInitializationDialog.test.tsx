// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitInitializationDialog, type GitInitializationCandidate } from './GitInitializationDialog'

const files: GitInitializationCandidate[] = [
  { path: '.gitignore', category: 'infrastructure', required: true },
  { path: '.draftmatter/project.json', bytes: 120, category: 'infrastructure', suggested: true, detail: 'Includes manuscript selection, environment preferences and server links.' },
  { path: '.agents/skills/draftmatter-authoring/SKILL.md', category: 'infrastructure', suggested: true },
  { path: 'paper.qmd', bytes: 500, category: 'project', suggested: true },
  { path: 'data/observations.csv', bytes: 20_000, category: 'project' },
]
let container: HTMLDivElement
let root: Root
const confirm = vi.fn<(paths: string[], message: string) => Promise<void>>()
const close = vi.fn()
beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  confirm.mockReset().mockResolvedValue(undefined); close.mockReset()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks() })
async function render(projectRoot = '/research/paper') { await act(async () => root.render(<GitInitializationDialog root={projectRoot} files={files} ignoreNotice="Your existing .gitignore is preserved; DraftMatter exclusions will be appended." onConfirm={confirm} onClose={close} />)) }
const button = (name: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent?.trim() === name || element.getAttribute('aria-label') === name)!
const checkbox = (path: string) => [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((element) => element.getAttribute('aria-label') === `Include ${path}`)!
async function input(value: string) {
  const field = container.querySelector<HTMLInputElement>('.git-initialization-message input')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) })
}

describe('Git initialization review', () => {
  it('only commits explicitly reviewed selections and keeps optional datasets unchecked', async () => {
    await render()
    expect(confirm).not.toHaveBeenCalled()
    expect(checkbox('.gitignore').checked).toBe(true)
    expect(checkbox('.gitignore').disabled).toBe(true)
    expect(container.textContent).toContain('Includes manuscript selection, environment preferences and server links.')
    expect(document.activeElement).toBe(checkbox('.draftmatter/project.json'))
    expect(checkbox('data/observations.csv').checked).toBe(false)
    expect(container.textContent).toContain('Your existing .gitignore is preserved')
    await act(async () => checkbox('paper.qmd').click())
    await act(async () => checkbox('data/observations.csv').click())
    await input('  Preserve project infrastructure  ')
    await act(async () => button('Initialize and create first commit').click())
    expect(confirm).toHaveBeenCalledExactlyOnceWith(['.gitignore', '.draftmatter/project.json', '.agents/skills/draftmatter-authoring/SKILL.md', 'data/observations.csv'], 'Preserve project infrastructure')
    expect(close).not.toHaveBeenCalled()
  })

  it('retains checked paths and message after failure so an initialized repository can retry its first commit', async () => {
    confirm.mockRejectedValueOnce({ kind: 'integration', message: 'Configure your Git name and email, then retry the first commit.' }).mockResolvedValueOnce(undefined)
    await render()
    await act(async () => checkbox('data/observations.csv').click())
    await input('My first commit')
    await act(async () => button('Initialize and create first commit').click())
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Configure your Git name and email')
    expect(checkbox('data/observations.csv').checked).toBe(true)
    expect(button('Initialize and create first commit').disabled).toBe(false)
    await act(async () => button('Initialize and create first commit').click())
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(confirm.mock.calls[1]).toEqual(confirm.mock.calls[0])
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('prevents duplicate mutation and cancellation while the first commit is being created', async () => {
    let finish!: () => void
    confirm.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
    await render()
    await act(async () => button('Initialize and create first commit').click())
    expect(button('Creating first commit…').disabled).toBe(true)
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      container.querySelector('.git-initialization-backdrop')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(close).not.toHaveBeenCalled()
    expect([...container.querySelectorAll<HTMLInputElement>('input')].every((element) => element.disabled || element.closest('fieldset[disabled]'))).toBe(true)
    await act(async () => finish())
    expect(button('Initialize and create first commit').disabled).toBe(false)
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('starts a fresh selection and ignores late errors after changing project identity', async () => {
    let fail!: (error: Error) => void
    confirm.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject }))
    await render()
    await act(async () => checkbox('data/observations.csv').click())
    await act(async () => button('Initialize and create first commit').click())
    await render('/research/another-paper')
    await act(async () => fail(new Error('Old project failed.')))
    expect(container.textContent).not.toContain('Old project failed')
    expect(container.textContent).toContain('/research/another-paper')
    expect(checkbox('data/observations.csv').checked).toBe(false)
    expect(button('Initialize and create first commit').disabled).toBe(false)
  })
})
