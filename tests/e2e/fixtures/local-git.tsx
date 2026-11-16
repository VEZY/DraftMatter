import { createRoot } from 'react-dom/client'
import { DraftMatterApplication } from '/src/DraftMatterApplication'
import { applicationRoutePath } from '/src/applicationRoute'
import { desktopHost } from '/src/desktopHost'
import '/src/styles.css'
import 'katex/dist/katex.min.css'

// Only this fixture filesystem is changed; native Git semantics have separate tests.
const root = '/fixture/local-git'
const mode = new URLSearchParams(location.search).get('git')
let initialized = mode !== 'off'
let source = '# Optional Git study\n\nThe current article stays editable while Git is open.\n'
const operations: { kind: string; request?: unknown }[] = []
const change = (path: string, kind = 'modified') => ({ path, kind, indexStatus: ' ', worktreeStatus: kind === 'untracked' ? '?' : 'M', staged: false, unstaged: true, conflicted: false, binary: false })
let entries = mode === 'clean' ? [] : [change('paper.md'), change('data/observations.csv', 'untracked')]
const status = () => ({ gitAvailable: true, gitVersion: 'git version 2.50.0', repository: initialized, repositoryRoot: initialized ? root : undefined, projectPrefix: '', branch: initialized ? 'main' : undefined, upstream: initialized ? 'origin/main' : undefined, detached: false, ahead: 0, behind: 0, entries: initialized ? entries : [] })
const history = [{ hash: 'a'.repeat(40), shortHash: 'aaaaaaaa', authoredAt: '2026-11-16T10:00:00Z', author: 'A researcher', message: 'Initial article' }]
const project = () => ({ root, config: { schemaVersion: 1, name: 'Optional Git study', mainDocument: 'paper.md', citationStyle: 'draftmatter-author-date', citationLocale: 'en-US' }, documents: [{ path: 'paper.md', kind: 'manuscript', bytes: source.length, hash: 'paper-hash', modifiedMs: 1 }], bibliographies: [] })
desktopHost.available = true
desktopHost.openProject = async () => project()
desktopHost.setMainDocument = async () => project()
desktopHost.readDocument = async () => ({ path: 'paper.md', content: source, hash: 'paper-hash', modifiedMs: 1 })
desktopHost.documentStatus = async () => ({ kind: 'current', hash: 'paper-hash', modifiedMs: 1 })
desktopHost.readCitationLock = async () => null
desktopHost.readCitationCache = async () => null
desktopHost.readExecutionManifests = async () => []
desktopHost.listDocumentRecoveries = async () => []
desktopHost.listSavedDocumentVersions = async () => []
desktopHost.createDocumentRecovery = async (_root, documentPath, content) => ({ id: 'git-fixture-recovery', documentPath, source: content, savedAtMillis: Date.now() })
desktopHost.saveDocument = async (request) => {
  source = request.content
  operations.push({ kind: 'save', request })
  return { path: request.path, hash: 'paper-hash', bytes: source.length, recoveryPath: null }
}
desktopHost.listProjectFiles = async () => ({ files: [{ path: 'paper.md', bytes: source.length, modifiedMs: 1 }, { path: '.gitignore', bytes: 20, modifiedMs: 1 }, { path: 'data/observations.csv', bytes: 128, modifiedMs: 1 }], truncated: false })
desktopHost.gitStatus = async () => status()
desktopHost.gitBranches = async () => ({ current: 'main', detached: false, branches: [{ name: 'main', current: true }], remotes: ['origin'] })
desktopHost.gitHistory = async () => [...history]
desktopHost.gitInitialize = async (requestedRoot) => {
  operations.push({ kind: 'initialize', request: requestedRoot }); initialized = true
  return { repositoryRoot: root, createdIgnore: false, status: status() }
}
desktopHost.gitCreateCheckpoint = async (request) => {
  operations.push({ kind: 'commit', request })
  entries = entries.filter((entry) => !request.paths.includes(entry.path))
  const commit = { hash: 'b'.repeat(40), shortHash: 'bbbbbbbb', authoredAt: '2026-11-16T11:00:00Z', author: 'A researcher', message: request.message }
  history.unshift(commit)
  return { ...commit, files: request.paths }
}
desktopHost.gitDiff = async (request) => ({ path: request.path, staged: request.staged, binary: false, truncated: false, text: 'diff --git a/paper.md b/paper.md\n--- a/paper.md\n+++ b/paper.md\n@@ -1 +1 @@\n-Previous result.\n+Revised result.\n' })
desktopHost.gitCheckpointDiff = async (request) => ({ hash: request.hash, files: ['paper.md'], truncated: false, text: 'diff --git a/paper.md b/paper.md\n--- a/paper.md\n+++ b/paper.md\n@@ -1 +1 @@\n-Previous result.\n+Revised result.\n' })
desktopHost.gitFetch = async (request) => { operations.push({ kind: 'fetch', request }); return { action: 'fetch', summary: 'Fetched origin', status: status() } }
desktopHost.gitPush = async (request) => { operations.push({ kind: 'push', request }); return { action: 'push', summary: 'Pushed main', status: status() } }
desktopHost.gitPull = async (request) => {
  operations.push({ kind: 'pull', request })
  if (entries.length) throw new Error('Keep uncommitted files before pulling.')
  source = '# Optional Git study\n\nA fast-forwarded article from the configured remote.\n'
  return { action: 'pull', summary: 'Fast-forwarded main', status: status() }
}
desktopHost.executeKernel = async () => { throw new Error('Git navigation must not execute manuscript code') }
window.localGitFixture = { operations: () => operations, initialized: () => initialized, source: () => source }
window.history.replaceState({}, '', applicationRoutePath({ destination: 'local-editor', localProjectId: root }))
createRoot(document.getElementById('root')!).render(<DraftMatterApplication />)
