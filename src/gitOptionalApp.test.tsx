// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { desktopHost, type GitRepositoryStatus, type ProjectSnapshot } from './desktopHost'

const projectRoot = '/research/optional-git'
const otherRoot = '/research/no-git'
const source = '# Optional Git study\n\nThe manuscript remains independent of Git.\n'
const project = (root = projectRoot): ProjectSnapshot => ({
  root,
  config: { schemaVersion: 1, name: root === projectRoot ? 'Optional Git study' : 'Unversioned study', mainDocument: 'paper.md', citationStyle: 'draftmatter-author-date', citationLocale: 'en-US' },
  documents: [{ path: 'paper.md', kind: 'manuscript', bytes: source.length, hash: 'paper-hash', modifiedMs: 1 }],
  bibliographies: [],
})
const repository = (root = projectRoot, enabled = true): GitRepositoryStatus => ({
  gitAvailable: true, gitVersion: 'git version 2.50.0', repository: enabled,
  ...(enabled ? { repositoryRoot: root, branch: 'main' } : {}),
  projectPrefix: '', detached: false, ahead: 0, behind: 0, entries: [],
})

describe('optional local Git in the writing workspace', () => {
  let container: HTMLDivElement
  let root: Root
  let available: boolean

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    available = desktopHost.available
    desktopHost.available = false
    vi.spyOn(desktopHost, 'gitStatus').mockResolvedValue(repository())
    vi.spyOn(desktopHost, 'gitInitializationPlan').mockResolvedValue({ repositoryRoot: projectRoot, entries: [
      { path: '.gitignore', bytes: 0, modifiedMs: 0, suggested: true, reason: 'Local exclusions' },
      { path: 'AGENTS.md', bytes: 30, modifiedMs: 1, suggested: true, reason: 'Shared instructions' },
      { path: '.draftmatter/project.json', bytes: 80, modifiedMs: 1, suggested: true, reason: 'Portable project settings' },
      { path: 'paper.md', bytes: source.length, modifiedMs: 1, suggested: false, reason: 'Project file' },
      { path: 'data/observations.csv', bytes: 100, modifiedMs: 1, suggested: false, reason: 'Project file' },
    ], originalIgnoreContent: null, ignoreContent: '# DraftMatter local files\n', ignoreWillChange: true, existingIgnore: false, truncated: false, repositoryExists: false, hasCommits: false })
    vi.spyOn(desktopHost, 'gitInitialize').mockResolvedValue({ repositoryRoot: projectRoot, createdIgnore: false, status: repository() })
    vi.spyOn(desktopHost, 'gitHistory').mockResolvedValue([])
    vi.spyOn(desktopHost, 'gitBranches').mockResolvedValue({ current: 'main', detached: false, branches: [{ name: 'main', current: true }], remotes: ['origin'] })
    vi.spyOn(desktopHost, 'gitRemotes').mockResolvedValue([{ name: 'origin', url: 'https://git.example.org/research/paper.git' }])
    vi.spyOn(desktopHost, 'gitSetRemote').mockRejectedValue(new Error('Remote configuration must be explicitly requested'))
    vi.spyOn(desktopHost, 'gitCreateCheckpoint').mockRejectedValue(new Error('A commit must be explicitly requested'))
    vi.spyOn(desktopHost, 'gitFetch').mockResolvedValue({ action: 'fetch', summary: 'Fetched origin', status: repository() })
    vi.spyOn(desktopHost, 'gitPull').mockResolvedValue({ action: 'pull', summary: 'Already up to date', status: repository() })
    vi.spyOn(desktopHost, 'gitPush').mockResolvedValue({ action: 'push', summary: 'Pushed origin', status: repository() })
    vi.spyOn(desktopHost, 'openProject').mockImplementation(async (root) => project(root))
    vi.spyOn(desktopHost, 'pickProjectFolder').mockResolvedValue(otherRoot)
    vi.spyOn(desktopHost, 'readDocument').mockResolvedValue({ path: 'paper.md', content: source, hash: 'paper-hash', modifiedMs: 1 })
    vi.spyOn(desktopHost, 'documentStatus').mockResolvedValue({ kind: 'current', hash: 'paper-hash', modifiedMs: 1 })
    vi.spyOn(desktopHost, 'saveDocument').mockImplementation(async (request) => ({ path: request.path, hash: 'saved-paper', bytes: request.content.length, recoveryPath: null }))
    vi.spyOn(desktopHost, 'readCitationLock').mockResolvedValue(null)
    vi.spyOn(desktopHost, 'readCitationCache').mockResolvedValue(null)
    vi.spyOn(desktopHost, 'readExecutionManifests').mockResolvedValue([])
    vi.spyOn(desktopHost, 'listProjectFiles').mockResolvedValue({ files: [], truncated: false })
    vi.spyOn(desktopHost, 'listDocumentRecoveries').mockResolvedValue([])
    vi.spyOn(desktopHost, 'listSavedDocumentVersions').mockResolvedValue([])
    vi.spyOn(desktopHost, 'createDocumentRecovery').mockImplementation(async (_root, documentPath, content) => ({ id: 'recovery-fixture', documentPath, source: content, savedAtMillis: Date.now() }))
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  async function waitFor(check: () => void, attempts = 100) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      try { check(); return } catch { await act(async () => new Promise((resolve) => setTimeout(resolve, 10))) }
    }
    check()
  }
  const namedButton = (name: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes(name))!
  const railGit = () => container.querySelector<HTMLButtonElement>('.app-rail [aria-label="Git"]')
  async function openLocal() {
    desktopHost.available = true
    await act(async () => root.render(<App desktopProjectLaunch={project()} />))
    await waitFor(() => expect(container.querySelector('.active-manuscript strong')?.textContent).toBe('paper.md'))
  }
  async function editSource(content: string) {
    await act(async () => namedButton('View source').click())
    await act(async () => namedButton('Edit source').click())
    const textarea = container.querySelector<HTMLTextAreaElement>('[aria-label="Reviewed portable source"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, content)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => namedButton('Apply source').click())
  }

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    desktopHost.available = available
    vi.restoreAllMocks()
  })

  it('keeps browser recovery available without running Git or offering local repository controls', async () => {
    await act(async () => root.render(<App initialExperience="browser-new" />))
    const history = container.querySelector<HTMLButtonElement>('[aria-label="History"]')!
    expect(history).not.toBeNull()
    await act(async () => history.click())
    expect(container.querySelector('[role="dialog"][aria-label="Recovery history"]')).not.toBeNull()
    expect(container.querySelector('.git-history-panel')).toBeNull()
    expect(railGit()).toBeNull()
    expect(container.textContent).not.toContain('Initialize Git')
    for (const method of ['gitStatus', 'gitInitialize', 'gitHistory', 'gitBranches'] as const) {
      expect(desktopHost[method]).not.toHaveBeenCalled()
    }
  })

  it('detects an existing local repository and opens a dedicated Git panel separately from recovery', async () => {
    await openLocal()
    await waitFor(() => expect(railGit()).not.toBeNull())
    expect(desktopHost.gitStatus).toHaveBeenCalledWith(projectRoot)
    expect(desktopHost.gitInitialize).not.toHaveBeenCalled()
    expect(desktopHost.gitHistory).not.toHaveBeenCalled()
    await act(async () => railGit()!.click())
    await waitFor(() => expect(container.querySelector('.git-history-panel[aria-label="Git"]')).not.toBeNull())
    expect(desktopHost.gitHistory).toHaveBeenCalledWith(projectRoot)
    expect(container.querySelector('[role="dialog"][aria-label="Recovery history"]')).toBeNull()
    expect(container.querySelector('.structured-manuscript-editor')?.textContent).toContain('The manuscript remains independent of Git.')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="History"]')!.click())
    expect(container.querySelector('[role="dialog"][aria-label="Recovery history"]')).not.toBeNull()
    for (const method of ['gitCreateCheckpoint', 'gitFetch', 'gitPull', 'gitPush'] as const) expect(desktopHost[method]).not.toHaveBeenCalled()
  })

  it('opens Git for an unversioned local project and initializes only from an explicit panel action', async () => {
    let initialized = false
    let finishInitialize!: () => void
    vi.mocked(desktopHost.gitStatus).mockImplementation(async () => repository(projectRoot, initialized))
    vi.mocked(desktopHost.gitInitialize).mockImplementation(() => new Promise((resolve) => {
      finishInitialize = () => {
        initialized = true
        resolve({ repositoryRoot: projectRoot, createdIgnore: false, status: repository() })
      }
    }))
    await openLocal()
    await waitFor(() => expect(desktopHost.gitStatus).toHaveBeenCalledWith(projectRoot))
    expect(railGit()).not.toBeNull()
    expect(desktopHost.gitInitialize).not.toHaveBeenCalled()
    await act(async () => railGit()!.click())
    const panel = container.querySelector('.git-history-panel')!
    expect(panel).not.toBeNull()
    expect(panel.textContent).toContain('No Git repository')
    const initialize = panel.querySelector<HTMLButtonElement>('[aria-label="Initialize Git…"]')!
    expect(initialize).not.toBeNull()
    expect(initialize.disabled).toBe(false)
    expect(desktopHost.gitInitialize).not.toHaveBeenCalled()
    expect(desktopHost.gitHistory).not.toHaveBeenCalled()
    await act(async () => initialize.click())
    expect(desktopHost.gitInitializationPlan).toHaveBeenCalledExactlyOnceWith(projectRoot)
    expect(desktopHost.gitInitialize).not.toHaveBeenCalled()
    const dialog = container.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="git-initialization-title"]') ?? container.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog).not.toBeNull()
    expect(dialog.querySelector<HTMLInputElement>('[aria-label="Include paper.md"]')?.checked).toBe(true)
    expect(dialog.querySelector<HTMLInputElement>('[aria-label="Include AGENTS.md"]')?.checked).toBe(true)
    expect(dialog.querySelector<HTMLInputElement>('[aria-label="Include data/observations.csv"]')?.checked).toBe(false)
    const confirm = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Initialize and create first commit')!
    await act(async () => confirm.click())
    expect(confirm.disabled).toBe(true)
    await act(async () => confirm.click())
    expect(desktopHost.gitInitialize).toHaveBeenCalledTimes(1)
    await act(async () => finishInitialize())
    await waitFor(() => expect(container.querySelector('.git-branch-summary')).not.toBeNull())
    expect(container.querySelector('.git-history-panel')).toBe(panel)
    expect(railGit()).not.toBeNull()
    expect(desktopHost.gitInitialize).toHaveBeenCalledExactlyOnceWith(projectRoot, { paths: ['.gitignore', 'AGENTS.md', '.draftmatter/project.json', 'paper.md'], message: 'Initialize DraftMatter project', expectedIgnore: null, expectedFiles: [
      { path: 'AGENTS.md', bytes: 30, modifiedMs: 1 }, { path: '.draftmatter/project.json', bytes: 80, modifiedMs: 1 }, { path: 'paper.md', bytes: source.length, modifiedMs: 1 },
    ] })
    expect(desktopHost.gitCreateCheckpoint).not.toHaveBeenCalled()
    expect(desktopHost.gitPush).not.toHaveBeenCalled()
    expect(container.querySelector('.structured-manuscript-editor')?.textContent).toContain('The manuscript remains independent of Git.')
  })

  it('suggests referenced bibliography and figures while leaving unrelated data out of a cancelled first commit', async () => {
    const manuscript = '---\nbibliography: references.bib\n---\n# Optional Git study\n\n![Summary](figures/summary.svg)\n'
    vi.mocked(desktopHost.gitStatus).mockResolvedValue(repository(projectRoot, false))
    vi.mocked(desktopHost.readDocument).mockResolvedValue({ path: 'paper.md', content: manuscript, hash: 'paper-hash', modifiedMs: 1 })
    vi.spyOn(desktopHost, 'readProjectAssets').mockResolvedValue([])
    vi.spyOn(desktopHost, 'readBibliography').mockResolvedValue({ path: 'references.bib', content: '@article{study,title={Study}}', hash: 'bibliography-hash', modifiedMs: 1 })
    const plan = await desktopHost.gitInitializationPlan(projectRoot)
    vi.mocked(desktopHost.gitInitializationPlan).mockClear().mockResolvedValue({ ...plan, entries: [...plan.entries, { path: 'references.bib', bytes: 10, modifiedMs: 1, suggested: false, reason: 'Bibliography' }, { path: 'figures/summary.svg', bytes: 20, modifiedMs: 1, suggested: false, reason: 'Figure' }] })
    await openLocal()
    await act(async () => railGit()!.click())
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Initialize Git…"]')!.click())
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.querySelector<HTMLInputElement>('[aria-label="Include references.bib"]')?.checked).toBe(true)
    expect(dialog.querySelector<HTMLInputElement>('[aria-label="Include figures/summary.svg"]')?.checked).toBe(true)
    expect(dialog.querySelector<HTMLInputElement>('[aria-label="Include data/observations.csv"]')?.checked).toBe(false)
    await act(async () => [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Cancel')!.click())
    expect(container.querySelector('.git-initialization-dialog')).toBeNull()
    expect(desktopHost.gitInitialize).not.toHaveBeenCalled()
    expect(desktopHost.gitCreateCheckpoint).not.toHaveBeenCalled()
    expect(desktopHost.gitPush).not.toHaveBeenCalled()
  })

  it('keeps initialization available when reference metadata needs repair', async () => {
    const manuscript = '---\nbibliography: references.bib\nbibliography: other.bib\n---\n# Optional Git study\n'
    vi.mocked(desktopHost.gitStatus).mockResolvedValue(repository(projectRoot, false))
    vi.mocked(desktopHost.readDocument).mockResolvedValue({ path: 'paper.md', content: manuscript, hash: 'paper-hash', modifiedMs: 1 })
    await openLocal()
    await act(async () => railGit()!.click())
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Initialize Git…"]')!.click())
    const dialog = container.querySelector<HTMLElement>('.git-initialization-dialog')!
    expect(dialog).not.toBeNull()
    expect(dialog.textContent).toContain('Bibliography paths could not be identified')
    expect(dialog.querySelector<HTMLInputElement>('[aria-label="Include paper.md"]')?.checked).toBe(true)
    expect(desktopHost.gitInitialize).not.toHaveBeenCalled()
  })

  it('keeps writing and recovery available when system Git is missing', async () => {
    vi.mocked(desktopHost.gitStatus).mockResolvedValue({ ...repository(projectRoot, false), gitAvailable: false, gitVersion: undefined })
    await openLocal()
    await waitFor(() => expect(desktopHost.gitStatus).toHaveBeenCalledWith(projectRoot))
    expect(railGit()).not.toBeNull()
    await act(async () => railGit()!.click())
    expect(container.querySelector('.git-history-panel')?.textContent).toContain('Git is not installed')
    const initialize = container.querySelector<HTMLButtonElement>('.git-history-panel [aria-label="Initialize Git…"]')
    expect(!initialize || initialize.disabled).toBe(true)
    expect(container.querySelector('.structured-manuscript-editor')?.textContent).toContain('The manuscript remains independent of Git.')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="History"]')!.click())
    expect(container.querySelector('[role="dialog"][aria-label="Recovery history"]')).not.toBeNull()
    expect(desktopHost.gitInitialize).not.toHaveBeenCalled()
  })

  it('ignores a delayed repository result after another local project has opened', async () => {
    let resolveFirst!: (status: GitRepositoryStatus) => void
    vi.mocked(desktopHost.gitStatus).mockImplementation((root) => root === projectRoot
      ? new Promise((resolve) => { resolveFirst = resolve })
      : Promise.resolve(repository(otherRoot, false)))
    await openLocal()
    await waitFor(() => expect(resolveFirst).toBeTypeOf('function'))
    await act(async () => container.querySelector<HTMLButtonElement>('.project-switcher')!.click())
    await act(async () => namedButton('Open project folder').click())
    await waitFor(() => expect(desktopHost.gitStatus).toHaveBeenCalledWith(otherRoot))
    expect(railGit()).not.toBeNull()
    await act(async () => railGit()!.click())
    await waitFor(() => expect(container.querySelector('.git-history-panel')?.textContent).toContain('No Git repository'))
    await act(async () => resolveFirst(repository(projectRoot)))
    expect(railGit()).not.toBeNull()
    expect(container.querySelector('.git-history-panel')?.textContent).toContain('No Git repository')
    expect(container.querySelector('.git-branch-summary')).toBeNull()
    expect(desktopHost.gitHistory).not.toHaveBeenCalled()
    expect(desktopHost.gitInitialize).not.toHaveBeenCalled()
  })

  it('keeps Git accessible after a detection failure and recovers through an explicit refresh', async () => {
    let readable = false
    vi.mocked(desktopHost.gitStatus).mockImplementation(async () => {
      if (!readable) throw { kind: 'conflict', message: 'Another DraftMatter client is writing this project.' }
      return repository()
    })
    await openLocal()
    await waitFor(() => expect(desktopHost.gitStatus).toHaveBeenCalledWith(projectRoot))
    expect(railGit()).not.toBeNull()
    await act(async () => railGit()!.click())
    const panel = container.querySelector('.git-history-panel')!
    await waitFor(() => expect(panel.querySelector('[role="alert"]')?.textContent).toContain('Another DraftMatter client'))
    expect(panel.querySelector('[aria-label="Initialize Git…"]')).toBeNull()
    expect(desktopHost.gitInitialize).not.toHaveBeenCalled()
    expect(desktopHost.gitHistory).not.toHaveBeenCalled()
    readable = true
    await act(async () => panel.querySelector<HTMLButtonElement>('[aria-label="Refresh Git status"]')!.click())
    await waitFor(() => expect(panel.querySelector('.git-branch-summary')?.textContent).toContain('main'))
    expect(panel.querySelector('[role="alert"]')).toBeNull()
    expect(railGit()).not.toBeNull()
    expect(desktopHost.gitInitialize).not.toHaveBeenCalled()
  })

  it('allows opening Git before detection finishes and keeps the panel open for an unversioned project', async () => {
    const pending: ((status: GitRepositoryStatus) => void)[] = []
    vi.mocked(desktopHost.gitStatus).mockImplementation(() => new Promise((resolve) => { pending.push(resolve) }))
    await openLocal()
    expect(railGit()).not.toBeNull()
    await act(async () => railGit()!.click())
    const panel = container.querySelector('.git-history-panel')!
    expect(panel).not.toBeNull()
    expect(panel.textContent).toContain('Reading local repository')
    expect(panel.querySelector('[aria-label="Initialize Git…"]')).toBeNull()
    await waitFor(() => expect(pending.length).toBe(2))
    await act(async () => { for (const resolve of pending) resolve(repository(projectRoot, false)) })
    expect(container.querySelector('.git-history-panel')).toBe(panel)
    expect(panel.textContent).toContain('No Git repository')
    expect(panel.querySelector<HTMLButtonElement>('[aria-label="Initialize Git…"]')?.disabled).toBe(false)
    expect(desktopHost.gitInitialize).not.toHaveBeenCalled()
  })

  it('saves the edited manuscript before committing only its selected path', async () => {
    const entries = ['paper.md', 'data/observations.csv'].map((path) => ({ path, kind: 'modified' as const, indexStatus: ' ', worktreeStatus: 'M', staged: false, unstaged: true, conflicted: false, binary: false }))
    vi.mocked(desktopHost.gitStatus).mockResolvedValue({ ...repository(), entries })
    let diskSource = source
    let sourceAtCommit: string | undefined
    vi.mocked(desktopHost.saveDocument).mockImplementation(async (request) => {
      diskSource = request.content
      return { path: request.path, hash: 'saved-paper', bytes: diskSource.length, recoveryPath: null }
    })
    vi.mocked(desktopHost.gitCreateCheckpoint).mockImplementation(async (request) => {
      sourceAtCommit = diskSource
      return { hash: 'b'.repeat(40), shortHash: 'bbbbbbbb', message: request.message, files: request.paths }
    })
    await openLocal()
    await waitFor(() => expect(railGit()).not.toBeNull())
    const edited = source.replace('The manuscript remains independent of Git.', 'Commit this latest edited manuscript, not its older disk copy.')
    await editSource(edited)
    await act(async () => railGit()!.click())
    await waitFor(() => expect(container.querySelector('.git-history-panel')).not.toBeNull())
    await act(async () => container.querySelector<HTMLInputElement>('[aria-label="Include paper.md"]')!.click())
    expect(container.querySelector<HTMLInputElement>('[aria-label="Include data/observations.csv"]')!.checked).toBe(false)
    const input = container.querySelector<HTMLTextAreaElement>('.git-history-panel textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Save the latest article revision')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => namedButton('Create commit').click())
    await waitFor(() => expect(desktopHost.gitCreateCheckpoint).toHaveBeenCalled())
    expect(sourceAtCommit).toContain('Commit this latest edited manuscript, not its older disk copy.')
    expect(desktopHost.saveDocument).toHaveBeenCalledWith(expect.objectContaining({ root: projectRoot, path: 'paper.md', content: expect.stringContaining('Commit this latest edited manuscript') }))
    expect(vi.mocked(desktopHost.saveDocument).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(desktopHost.gitCreateCheckpoint).mock.invocationCallOrder[0])
    expect(desktopHost.gitCreateCheckpoint).toHaveBeenCalledExactlyOnceWith({ root: projectRoot, paths: ['paper.md'], message: 'Save the latest article revision' })
    expect(desktopHost.gitPush).not.toHaveBeenCalled()
  })

  it('discards a delayed external deletion result while Pull owns the manuscript and reloads the successful pull', async () => {
    let resolvePoll!: (value: Awaited<ReturnType<typeof desktopHost.documentStatus>>) => void
    let resolvePull!: (value: Awaited<ReturnType<typeof desktopHost.gitPull>>) => void
    let pulled = false
    const pulledSource = source.replace('The manuscript remains independent of Git.', 'Read the successfully pulled revision after the delayed deletion check.')
    vi.mocked(desktopHost.documentStatus).mockImplementation(() => new Promise((resolve) => { resolvePoll = resolve }))
    vi.mocked(desktopHost.gitPull).mockImplementation(() => new Promise((resolve) => { resolvePull = resolve }))
    vi.mocked(desktopHost.readDocument).mockImplementation(async () => ({ path: 'paper.md', content: pulled ? pulledSource : source, hash: pulled ? 'pulled-paper' : 'paper-hash', modifiedMs: pulled ? 2 : 1 }))
    vi.spyOn(desktopHost, 'setMainDocument').mockResolvedValue(project())
    await openLocal()
    await waitFor(() => expect(railGit()).not.toBeNull())
    await act(async () => railGit()!.click())
    await waitFor(() => expect(resolvePoll).toBeTypeOf('function'), 250)
    await act(async () => namedButton('Pull fast-forward').click())
    await waitFor(() => expect(resolvePull).toBeTypeOf('function'))
    expect(container.querySelector('.app-shell')?.hasAttribute('inert')).toBe(true)

    await act(async () => resolvePoll({ kind: 'deleted' }))
    expect(container.textContent).not.toContain('deleted outside DraftMatter')
    expect(container.querySelector('.structured-manuscript-editor')?.textContent).toContain('The manuscript remains independent of Git.')
    expect(desktopHost.readDocument).toHaveBeenCalledExactlyOnceWith(projectRoot, 'paper.md')
    expect(desktopHost.documentStatus).toHaveBeenCalledWith(projectRoot, 'paper.md', 'paper-hash')

    pulled = true
    vi.mocked(desktopHost.documentStatus).mockResolvedValue({ kind: 'current', hash: 'pulled-paper', modifiedMs: 2 })
    await act(async () => resolvePull({ action: 'pull', summary: 'Fast-forwarded main', status: repository() }))
    await waitFor(() => expect(container.querySelector('.structured-manuscript-editor')?.textContent).toContain('Read the successfully pulled revision after the delayed deletion check.'))
    expect(container.textContent).not.toContain('deleted outside DraftMatter')
    expect(container.querySelector('.app-shell')?.hasAttribute('inert')).toBe(false)
    expect(desktopHost.gitPull).toHaveBeenCalledTimes(1)
  })

  it.each(['commit', 'pull'] as const)('keeps unsaved manuscript edits when disk saving fails before %s', async (operation) => {
    vi.mocked(desktopHost.gitStatus).mockResolvedValue({ ...repository(), entries: [{ path: 'paper.md', kind: 'modified', indexStatus: ' ', worktreeStatus: 'M', staged: false, unstaged: true, conflicted: false, binary: false }] })
    vi.mocked(desktopHost.saveDocument).mockRejectedValue({ kind: 'io', message: 'The selected manuscript could not be saved: disk full.' })
    await openLocal()
    await waitFor(() => expect(railGit()).not.toBeNull())
    const unsaved = source.replace('The manuscript remains independent of Git.', 'Keep this unsaved revision when the disk is full.')
    await editSource(unsaved)
    await act(async () => railGit()!.click())
    await waitFor(() => expect(container.querySelector('.git-history-panel')).not.toBeNull())
    if (operation === 'commit') {
      await act(async () => container.querySelector<HTMLInputElement>('[aria-label="Include paper.md"]')!.click())
      const input = container.querySelector<HTMLTextAreaElement>('.git-history-panel textarea')!
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Keep the selected revision')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => namedButton('Create commit').click())
    } else await act(async () => namedButton('Pull fast-forward').click())
    await waitFor(() => expect(desktopHost.saveDocument).toHaveBeenCalled())
    expect(desktopHost.gitCreateCheckpoint).not.toHaveBeenCalled()
    expect(desktopHost.gitPull).not.toHaveBeenCalled()
    expect(container.querySelector('.structured-manuscript-editor')?.textContent).toContain('Keep this unsaved revision when the disk is full.')
    expect(container.querySelector('.app-shell')?.hasAttribute('inert')).toBe(false)
  })
})
