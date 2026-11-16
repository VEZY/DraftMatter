// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { desktopHost, type GitRemoteResult, type GitRepositoryStatus } from './desktopHost'
import { GitHistoryPanel, type GitHistoryPanelProps } from './GitHistoryPanel'

const rootPath = '/research/canopy'
const commit = { hash: '1234567890abcdef1234567890abcdef12345678', shortHash: '12345678', authoredAt: '2026-07-16T10:00:00+02:00', author: 'Ada', message: 'Results' }
const repository: GitRepositoryStatus = {
  gitAvailable: true, gitVersion: 'git version 2.50.0', repository: true, repositoryRoot: rootPath,
  projectPrefix: '', branch: 'main', detached: false, ahead: 0, behind: 0,
  entries: [
    { path: 'paper.qmd', kind: 'modified', indexStatus: ' ', worktreeStatus: 'M', staged: false, unstaged: true, conflicted: false, binary: false },
    { path: 'data/observations.csv', kind: 'untracked', indexStatus: '?', worktreeStatus: '?', staged: false, unstaged: true, conflicted: false, binary: false },
  ],
}
const remoteResult = (action: 'fetch' | 'pull' | 'push'): GitRemoteResult => ({ action, summary: `${action} complete`, status: repository })
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }

let container: HTMLDivElement
let app: Root
const notice = vi.fn()
const changed = vi.fn()

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
  vi.spyOn(desktopHost, 'gitStatus').mockResolvedValue(repository)
  vi.spyOn(desktopHost, 'gitBranches').mockResolvedValue({ current: 'main', detached: false, branches: [{ name: 'main', current: true }], remotes: ['origin'] })
  vi.spyOn(desktopHost, 'gitRemotes').mockResolvedValue([{ name: 'origin', url: 'https://git.example.org/canopy.git' }])
  vi.spyOn(desktopHost, 'gitSetRemote').mockResolvedValue([])
  vi.spyOn(desktopHost, 'gitHistory').mockResolvedValue([commit])
  vi.spyOn(desktopHost, 'gitCheckpointDiff').mockResolvedValue({ hash: commit.hash, truncated: false, files: ['paper.qmd'], text: '@@ -1 +1 @@\n-Old commit.\n+New commit.\n' })
  vi.spyOn(desktopHost, 'gitCreateCheckpoint').mockResolvedValue({ hash: commit.hash, shortHash: commit.shortHash, message: 'Results', files: ['paper.qmd'] })
  vi.spyOn(desktopHost, 'gitDiff').mockResolvedValue({ path: 'paper.qmd', staged: false, binary: false, truncated: false, text: '@@ -1 +1 @@\n-Old result.\n+New result.\n' })
  vi.spyOn(desktopHost, 'gitFetch').mockResolvedValue(remoteResult('fetch'))
  vi.spyOn(desktopHost, 'gitPull').mockResolvedValue(remoteResult('pull'))
  vi.spyOn(desktopHost, 'gitPush').mockResolvedValue(remoteResult('push'))
  vi.spyOn(desktopHost, 'gitInitialize').mockRejectedValue(new Error('Initialization belongs to the project menu'))
  vi.spyOn(desktopHost, 'gitRestoreCheckpoint').mockRejectedValue(new Error('Git browsing must not restore files'))
  container = document.createElement('div'); document.body.append(container); app = createRoot(container)
})
afterEach(async () => { await act(async () => app.unmount()); container.remove(); vi.restoreAllMocks() })

async function render(props: Partial<GitHistoryPanelProps> = {}) {
  await act(async () => app.render(<GitHistoryPanel root={rootPath} manuscriptPath="paper.qmd" onNotice={notice} onRepositoryChange={changed} {...props} />))
}
function button(label: string) {
  const match = [...container.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.getAttribute('aria-label') === label || element.textContent?.trim() === label)
  if (!match) throw new Error(`Button not found: ${label}`)
  return match
}
async function click(label: string) { await act(async () => button(label).click()) }
async function select(path: string) { await act(async () => container.querySelector<HTMLInputElement>(`[aria-label="Include ${path}"]`)!.click()) }
async function message(value: string) {
  const input = container.querySelector('textarea')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}

 describe('Git panel', () => {
  it('requires explicit selection and commits only selected files after the save guard', async () => {
    const before = vi.fn(async () => true)
    await render({ onBeforeCommit: before })
    expect(container.querySelector('aside')?.getAttribute('aria-label')).toBe('Git')
    expect([...container.querySelectorAll<HTMLInputElement>('[type="checkbox"]')].every((input) => !input.checked)).toBe(true)
    await message('  Revise results  ')
    expect(button('Create commit').disabled).toBe(true)
    await select('paper.qmd')
    await click('Create commit')
    expect(before).toHaveBeenCalledExactlyOnceWith(['paper.qmd'])
    expect(desktopHost.gitCreateCheckpoint).toHaveBeenCalledExactlyOnceWith({ root: rootPath, paths: ['paper.qmd'], message: 'Revise results' })
    expect(notice).toHaveBeenCalledWith('Commit 12345678 created locally.')
    expect(container.querySelector('textarea')?.value).toBe('')
    expect([...container.querySelectorAll<HTMLInputElement>('[type="checkbox"]')].every((input) => !input.checked)).toBe(true)
    expect(desktopHost.gitPush).not.toHaveBeenCalled()
  })

  it('preserves an empty selection across refreshes and preserves the message when saving fails', async () => {
    await render({ onBeforeCommit: async () => false })
    await click('Refresh Git status')
    expect(container.querySelector<HTMLInputElement>('[aria-label="Include paper.qmd"]')?.checked).toBe(false)
    await select('paper.qmd'); await message('Keep my message'); await click('Create commit')
    expect(desktopHost.gitCreateCheckpoint).not.toHaveBeenCalled()
    expect(container.querySelector('textarea')?.value).toBe('Keep my message')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('No commit was created')
  })

  it('preserves the selected files and commit message after a native commit error', async () => {
    vi.mocked(desktopHost.gitCreateCheckpoint).mockRejectedValueOnce({ kind: 'integration', message: 'Configure your Git author name and email.' })
    await render(); await select('paper.qmd'); await message('Results'); await click('Create commit')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Configure your Git author')
    expect(container.querySelector('textarea')?.value).toBe('Results')
    expect(container.querySelector<HTMLInputElement>('[aria-label="Include paper.qmd"]')?.checked).toBe(true)
  })

  it('shows working and staged changes separately when a file has both', async () => {
    vi.mocked(desktopHost.gitStatus).mockResolvedValue({ ...repository, entries: [{ ...repository.entries[0], staged: true, indexStatus: 'M' }] })
    await render(); await click('View changes in paper.qmd')
    expect(desktopHost.gitDiff).toHaveBeenLastCalledWith({ root: rootPath, path: 'paper.qmd', staged: false })
    expect(container.querySelector('.semantic-diff')?.textContent).toContain('Old result.')
    await click('Source')
    expect(container.querySelector('.git-diff-preview pre')?.textContent).toContain('@@ -1 +1 @@')
    await click('View staged changes in paper.qmd')
    expect(desktopHost.gitDiff).toHaveBeenLastCalledWith({ root: rootPath, path: 'paper.qmd', staged: true })
    expect(container.querySelector('.git-diff-preview')?.textContent).toContain('Staged changes')
  })

  it('browses commits without exposing restoration or branch management', async () => {
    await render(); await click('View commit 12345678')
    expect(desktopHost.gitCheckpointDiff).toHaveBeenCalledExactlyOnceWith({ root: rootPath, hash: commit.hash })
    expect(container.querySelector('.git-diff-preview')?.textContent).toContain('read-only commit')
    expect(container.querySelector('.semantic-diff')?.textContent).toContain('New commit.')
    expect(container.textContent).not.toMatch(/Create and switch|Restore clean files|Create checkpoint/)
    expect(container.textContent).toContain('separate from automatic Recovery History')
    expect(desktopHost.gitRestoreCheckpoint).not.toHaveBeenCalled()
  })

  it('performs remote actions only on click and delegates Pull to the project save/reload guard', async () => {
    const pull = vi.fn(async () => ({ ...remoteResult('pull'), summary: 'guarded pull complete' }))
    await render({ onPull: pull })
    expect(desktopHost.gitFetch).not.toHaveBeenCalled(); expect(desktopHost.gitPull).not.toHaveBeenCalled(); expect(desktopHost.gitPush).not.toHaveBeenCalled()
    await click('Fetch')
    expect(desktopHost.gitFetch).toHaveBeenCalledExactlyOnceWith({ root: rootPath, remote: 'origin' })
    await click('Pull fast-forward')
    expect(pull).toHaveBeenCalledExactlyOnceWith({ root: rootPath, remote: 'origin', branch: 'main' })
    expect(desktopHost.gitPull).not.toHaveBeenCalled()
    await click('Push')
    expect(desktopHost.gitPush).toHaveBeenCalledExactlyOnceWith({ root: rootPath, remote: 'origin', branch: 'main' })
    expect(desktopHost.gitHistory).toHaveBeenCalledTimes(4)
  })

  it('uses the configured upstream by default and labels an explicitly chosen alternative target', async () => {
    vi.mocked(desktopHost.gitStatus).mockResolvedValue({ ...repository, upstream: 'fork/results-review' })
    vi.mocked(desktopHost.gitBranches).mockResolvedValue({ current: 'main', detached: false, branches: [], remotes: ['origin', 'fork'] })
    vi.mocked(desktopHost.gitRemotes).mockResolvedValue([{ name: 'origin', url: 'https://git.example.org/canopy.git' }, { name: 'fork', url: 'git@git.example.org:ada/canopy.git' }])
    const pull = vi.fn(async () => remoteResult('pull'))
    await render({ onPull: pull })
    const select = container.querySelector<HTMLSelectElement>('.git-remote-section select')!
    expect(select.value).toBe('fork')
    expect(container.textContent).toContain('Pull / Push target: fork/results-review')
    await click('Pull fast-forward')
    expect(pull).toHaveBeenCalledExactlyOnceWith({ root: rootPath })
    await click('Push')
    expect(desktopHost.gitPush).toHaveBeenLastCalledWith({ root: rootPath })
    await act(async () => { select.value = 'origin'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(container.textContent).toContain('Pull / Push target: origin/main')
    await click('Push')
    expect(desktopHost.gitPush).toHaveBeenLastCalledWith({ root: rootPath, remote: 'origin', branch: 'main' })
  })

  it('configures a new remote locally without transferring files', async () => {
    vi.mocked(desktopHost.gitRemotes).mockResolvedValue([])
    vi.mocked(desktopHost.gitSetRemote).mockImplementation(async (request) => {
      const remotes = [{ name: request.name, url: request.url }]
      vi.mocked(desktopHost.gitRemotes).mockResolvedValue(remotes)
      return remotes
    })
    await render()
    expect(desktopHost.gitSetRemote).not.toHaveBeenCalled()
    const inputs = container.querySelectorAll<HTMLInputElement>('.git-remote-form input')
    expect(inputs[0].value).toBe('origin')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(inputs[1], 'https://git.example.org/team/paper.git')
      inputs[1].dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click('Save remote')
    expect(desktopHost.gitSetRemote).toHaveBeenCalledExactlyOnceWith({ root: rootPath, name: 'origin', url: 'https://git.example.org/team/paper.git', expectedUrl: null })
    expect(container.querySelector('.git-remote-address')?.textContent).toContain('https://git.example.org/team/paper.git')
    expect(container.querySelector('.git-remote-form')).toBeNull()
    expect(desktopHost.gitFetch).not.toHaveBeenCalled()
    expect(desktopHost.gitPull).not.toHaveBeenCalled()
    expect(desktopHost.gitPush).not.toHaveBeenCalled()
    expect(desktopHost.gitCreateCheckpoint).not.toHaveBeenCalled()
  })

  it('keeps remote edits after a concurrent configuration change and preserves the original URL guard', async () => {
    vi.mocked(desktopHost.gitSetRemote).mockRejectedValue({ kind: 'conflict', message: 'The remote URL changed. Refresh before editing it.' })
    await render(); await click('Edit remote')
    const inputs = container.querySelectorAll<HTMLInputElement>('.git-remote-form input')
    expect(inputs[0].disabled).toBe(true)
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(inputs[1], 'git@git.example.org:team/new-paper.git')
      inputs[1].dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(inputs[1].value).toBe('git@git.example.org:team/new-paper.git')
    await click('Save remote')
    expect(desktopHost.gitSetRemote).toHaveBeenCalledExactlyOnceWith({ root: rootPath, name: 'origin', url: 'git@git.example.org:team/new-paper.git', expectedUrl: 'https://git.example.org/canopy.git' })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('remote URL changed')
    expect(inputs[1].value).toBe('git@git.example.org:team/new-paper.git')
    expect(desktopHost.gitFetch).not.toHaveBeenCalled()
    expect(desktopHost.gitPush).not.toHaveBeenCalled()
  })

  it('shows an existing separate push URL when editing only the fetch address', async () => {
    vi.mocked(desktopHost.gitRemotes).mockResolvedValue([{ name: 'origin', url: 'https://git.example.org/canopy.git', pushUrl: 'git@git.example.org:ada/canopy.git' }])
    await render(); await click('Edit remote')
    expect(container.querySelector('.git-remote-form')?.textContent).toContain('Fetch URL')
    expect(container.querySelector('.git-remote-form')?.textContent).toContain('The separate push URL is preserved: git@git.example.org:ada/canopy.git')
    expect(desktopHost.gitSetRemote).not.toHaveBeenCalled()
  })

  it('refreshes external changes when the idle panel regains focus without contacting a remote', async () => {
    await render()
    const calls = vi.mocked(desktopHost.gitStatus).mock.calls.length
    vi.mocked(desktopHost.gitStatus).mockResolvedValue({ ...repository, entries: [...repository.entries, { ...repository.entries[0], path: 'scripts/analysis.py' }] })
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(desktopHost.gitStatus).toHaveBeenCalledTimes(calls + 1)
    expect(container.querySelector('[aria-label="Include scripts/analysis.py"]')).not.toBeNull()
    expect(desktopHost.gitFetch).not.toHaveBeenCalled(); expect(desktopHost.gitPull).not.toHaveBeenCalled(); expect(desktopHost.gitPush).not.toHaveBeenCalled()
  })

  it('retains the manuscript selection and displays remote failures', async () => {
    vi.mocked(desktopHost.gitPull).mockRejectedValueOnce({ kind: 'conflict', message: 'Pull requires a clean working tree.' })
    await render(); await select('paper.qmd'); await click('Pull fast-forward')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('clean working tree')
    expect(container.querySelector<HTMLInputElement>('[aria-label="Include paper.qmd"]')?.checked).toBe(true)
    expect(desktopHost.gitPush).not.toHaveBeenCalled()
  })

  it('does not initialize a missing repository or query history for a missing Git executable', async () => {
    vi.mocked(desktopHost.gitStatus).mockResolvedValue({ ...repository, repository: false })
    await render()
    expect(container.textContent).toContain('No Git repository detected')
    expect(container.textContent).toContain('Open Git from the project navigation')
    expect(desktopHost.gitInitialize).not.toHaveBeenCalled(); expect(desktopHost.gitHistory).not.toHaveBeenCalled()
    vi.mocked(desktopHost.gitStatus).mockResolvedValue({ ...repository, gitAvailable: false, repository: false })
    await render({ root: '/another/project' })
    expect(container.textContent).toContain('Git is not installed')
    expect(desktopHost.gitBranches).not.toHaveBeenCalled()
  })

  it('keeps setup available after an initialization error and retries only on click', async () => {
    vi.mocked(desktopHost.gitStatus).mockResolvedValue({ ...repository, repository: false, entries: [] })
    const initialize = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce({ kind: 'io', message: 'The project folder is read-only.' })
      .mockImplementationOnce(async () => { vi.mocked(desktopHost.gitStatus).mockResolvedValue(repository) })
    await render({ onInitialize: initialize })
    expect(initialize).not.toHaveBeenCalled()
    await click('Initialize Git…')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('project folder is read-only')
    expect(button('Initialize Git…').disabled).toBe(false)
    expect(initialize).toHaveBeenCalledTimes(1)
    await click('Initialize Git…')
    expect(initialize).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.querySelector('[aria-label="Working changes"]')).not.toBeNull()
    expect(desktopHost.gitCreateCheckpoint).not.toHaveBeenCalled()
    expect(desktopHost.gitPush).not.toHaveBeenCalled()
  })

  it('describes a parent repository and disables commits in detached HEAD or conflicted states', async () => {
    vi.mocked(desktopHost.gitStatus).mockResolvedValue({ ...repository, repositoryRoot: '/research', projectPrefix: 'canopy', detached: true })
    await render(); await select('paper.qmd'); await message('Results')
    expect(container.textContent).toContain('Project folder inside /research')
    expect(button('Create commit').disabled).toBe(true)
    expect(button('Push').disabled).toBe(true)
    vi.mocked(desktopHost.gitStatus).mockResolvedValue({ ...repository, entries: [{ ...repository.entries[0], conflicted: true }] })
    await click('Refresh Git status')
    expect(container.querySelector<HTMLInputElement>('[type="checkbox"]')?.disabled).toBe(true)
    expect(button('Create commit').disabled).toBe(true)
  })

  it('ignores delayed status and history responses after switching projects', async () => {
    const old = deferred<GitRepositoryStatus>()
    vi.mocked(desktopHost.gitStatus).mockReturnValueOnce(old.promise)
    await render()
    vi.mocked(desktopHost.gitStatus).mockResolvedValue({ ...repository, branch: 'new-project' })
    await render({ root: '/another/project' })
    await act(async () => old.resolve({ ...repository, branch: 'old-project' }))
    expect(container.textContent).toContain('new-project')
    expect(container.textContent).not.toContain('old-project')
    expect(changed).not.toHaveBeenCalledWith(expect.objectContaining({ branch: 'old-project' }))
  })

  it('cancels a commit before native mutation when the project changes during the save guard', async () => {
    const before = deferred<boolean>()
    await render({ onBeforeCommit: () => before.promise })
    await select('paper.qmd'); await message('Old project edit'); await click('Create commit')
    await render({ root: '/another/project' })
    await act(async () => before.resolve(true))
    expect(desktopHost.gitCreateCheckpoint).not.toHaveBeenCalled()
    expect(container.querySelector('textarea')?.value).toBe('')
    expect(notice).not.toHaveBeenCalled()
  })

  it('blocks duplicate clicks while a commit is running and ignores stale notices after closing', async () => {
    const pending = deferred<Awaited<ReturnType<typeof desktopHost.gitCreateCheckpoint>>>()
    vi.mocked(desktopHost.gitCreateCheckpoint).mockReturnValueOnce(pending.promise)
    await render(); await select('paper.qmd'); await message('Results')
    await act(async () => { button('Create commit').click(); button('Create commit').click() })
    expect(desktopHost.gitCreateCheckpoint).toHaveBeenCalledTimes(1)
    expect(container.querySelector('textarea')?.disabled).toBe(true)
    await act(async () => app.render(<p>Closed</p>))
    await act(async () => pending.resolve({ hash: commit.hash, shortHash: commit.shortHash, message: 'Results', files: ['paper.qmd'] }))
    expect(notice).not.toHaveBeenCalled()
  })
})
