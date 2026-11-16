import { createRoot } from 'react-dom/client'
import { DraftMatterApplication } from '/src/DraftMatterApplication'
import { desktopHost } from '/src/desktopHost'
import '/src/styles.css'
import 'katex/dist/katex.min.css'

// The clone operation is synthetic. Native Git is covered by offline Rust tests.
const parent = '/fixture/cloned-papers'
let root = `${parent}/shared-paper`
const source = '# Shared paper\n\nThe cloned manuscript opens without running its computations.\n'
const operations: { kind: string; request?: unknown }[] = []
const project = () => ({ root, config: { schemaVersion: 1, name: 'Shared paper', mainDocument: 'paper.md', citationStyle: 'draftmatter-author-date', citationLocale: 'en-US' }, documents: [{ path: 'paper.md', kind: 'manuscript', bytes: source.length, hash: 'cloned-paper-hash', modifiedMs: 1 }], bibliographies: [] })
desktopHost.available = true
desktopHost.pickProjectFolder = async () => parent
desktopHost.gitClone = async (request) => {
  operations.push({ kind: 'clone', request })
  root = `${request.parent}/${request.folderName}`
  return { root }
}
desktopHost.openProject = async (requestedRoot) => {
  operations.push({ kind: 'open', request: requestedRoot })
  return project()
}
desktopHost.readDocument = async () => ({ path: 'paper.md', content: source, hash: 'cloned-paper-hash', modifiedMs: 1 })
desktopHost.documentStatus = async () => ({ kind: 'current', hash: 'cloned-paper-hash', modifiedMs: 1 })
desktopHost.readCitationLock = async () => null
desktopHost.readCitationCache = async () => null
desktopHost.readExecutionManifests = async () => []
desktopHost.listDocumentRecoveries = async () => []
desktopHost.listSavedDocumentVersions = async () => []
desktopHost.createDocumentRecovery = async (_root, documentPath, content) => ({ id: 'clone-fixture-recovery', documentPath, source: content, savedAtMillis: Date.now() })
desktopHost.listProjectFiles = async () => ({ files: [{ path: 'paper.md', bytes: source.length, modifiedMs: 1 }], truncated: false })
desktopHost.gitStatus = async () => ({ gitAvailable: true, gitVersion: 'git version 2.50.0', repository: true, repositoryRoot: root, projectPrefix: '', branch: 'main', upstream: 'origin/main', detached: false, ahead: 0, behind: 0, entries: [] })
desktopHost.gitRemotes = async () => [{ name: 'origin', url: 'https://git.example.org/team/shared-paper.git' }]
desktopHost.gitHistory = async () => []
desktopHost.executeKernel = async () => {
  operations.push({ kind: 'execute' })
  throw new Error('Opening a cloned paper must not execute computations')
}
window.clonePaperFixture = { operations: () => operations }
window.history.replaceState({}, '', '/')
createRoot(document.getElementById('root')!).render(<DraftMatterApplication />)
