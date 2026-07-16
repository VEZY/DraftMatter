// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { desktopHost, type GitRepositoryStatus } from './desktopHost'
import { GitHistoryPanel } from './GitHistoryPanel'

const rootPath = '/research/canopy'
const status: GitRepositoryStatus = {
  gitAvailable: true,
  gitVersion: 'git version 2.50.0',
  repository: true,
  repositoryRoot: rootPath,
  projectPrefix: '',
  branch: 'main',
  detached: false,
  ahead: 0,
  behind: 0,
  entries: [{
    path: 'paper.qmd',
    kind: 'modified',
    indexStatus: ' ',
    worktreeStatus: 'M',
    staged: false,
    unstaged: true,
    conflicted: false,
    binary: false,
  }],
}

function button(container: ParentNode, label: string) {
  const match = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(label))
  if (!match) throw new Error(`Button ${label} was not found.`)
  return match as HTMLButtonElement
}

async function flush() {
  await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))
}

describe('Git history panel', () => {
  let container: HTMLDivElement
  let appRoot: ReturnType<typeof createRoot>
  let notices: string[]

  beforeEach(async () => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    notices = []
    vi.spyOn(desktopHost, 'gitStatus').mockResolvedValue(status)
    vi.spyOn(desktopHost, 'gitBranches').mockResolvedValue({ current: 'main', detached: false, branches: [{ name: 'main', current: true }], remotes: [] })
    vi.spyOn(desktopHost, 'gitHistory').mockResolvedValue([{ hash: '1234567890abcdef1234567890abcdef12345678', shortHash: '12345678', authoredAt: '2026-07-16T10:00:00+02:00', author: 'Ada', message: 'Results' }])
    vi.spyOn(desktopHost, 'gitCheckpointDiff').mockResolvedValue({
      hash: '1234567890abcdef1234567890abcdef12345678',
      truncated: false,
      text: '@@ -1 +1 @@\n-Old checkpoint.\n+New checkpoint.\n',
    })
    vi.spyOn(desktopHost, 'gitCreateCheckpoint').mockResolvedValue({ hash: '1234567890', shortHash: '12345678', message: 'Results', files: ['paper.qmd'] })
    vi.spyOn(desktopHost, 'gitDiff').mockResolvedValue({
      path: 'paper.qmd',
      staged: false,
      binary: false,
      truncated: false,
      text: '@@ -1 +1 @@\n-Old result.\n+New result.\n',
    })
    container = document.createElement('div')
    document.body.append(container)
    appRoot = createRoot(container)
    await act(async () => appRoot.render(<GitHistoryPanel root={rootPath} manuscriptPath="paper.qmd" onNotice={(message) => notices.push(message)} />))
    await flush()
  })

  afterEach(async () => {
    await act(async () => appRoot.unmount())
    vi.restoreAllMocks()
    container.remove()
  })

  it('shows a rendered prose diff without exposing review storage syntax', async () => {
    await act(async () => button(container, 'Rendered').click())
    await flush()

    expect(container.querySelector('.semantic-diff')?.textContent).toContain('Old result.')
    expect(container.querySelector('.semantic-diff')?.textContent).toContain('New result.')
    expect(desktopHost.gitDiff).toHaveBeenCalledWith({ root: rootPath, path: 'paper.qmd', staged: false })
  })

  it('creates a named local checkpoint from only the selected manuscript', async () => {
    const input = container.querySelector<HTMLInputElement>('.git-checkpoint-form input')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, 'Results')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button(container, 'Create checkpoint').click())
    await flush()

    expect(desktopHost.gitCreateCheckpoint).toHaveBeenCalledWith({ root: rootPath, paths: ['paper.qmd'], message: 'Results' })
    expect(notices).toContain('Checkpoint 12345678 created locally. Nothing was pushed.')
  })

  it('browses a checkpoint as a read-only rendered or source diff', async () => {
    expect(container.textContent).toContain('Results')
    expect(container.textContent).toContain('12345678 · Ada')

    const history = container.querySelector('.git-history-browser')!
    await act(async () => button(history, 'Rendered').click())
    await flush()

    expect(desktopHost.gitCheckpointDiff).toHaveBeenCalledWith({ root: rootPath, hash: '1234567890abcdef1234567890abcdef12345678' })
    expect(container.querySelector('.git-checkpoint-diff')?.textContent).toContain('Old checkpoint.')
    expect(container.querySelector('.git-checkpoint-diff')?.textContent).toContain('New checkpoint.')
    expect(container.querySelector('.git-checkpoint-diff')?.textContent).toContain('read-only checkpoint')
  })
})
