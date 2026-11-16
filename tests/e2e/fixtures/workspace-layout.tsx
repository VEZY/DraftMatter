import { createRoot } from 'react-dom/client'
import { DraftMatterApplication } from '/src/DraftMatterApplication'
import { applicationRoutePath } from '/src/applicationRoute'
import { desktopHost } from '/src/desktopHost'
import '/src/styles.css'
import 'katex/dist/katex.min.css'

// Long source and a crowded, synthetic project exercise the real application layout.
const projectRoot = '/fixture/workspace-layout'
const source = Array.from({ length: 48 }, (_, index) => `# Section ${index + 1}\n\nThis is paragraph ${index + 1} of the manuscript. ${'A manuscript remains readable while its project files are browsed. '.repeat(8)}\n`).join('\n')
const files = [{ path: 'paper.md', bytes: source.length, modifiedMs: 1 }, ...Array.from({ length: 120 }, (_, index) => ({
  path: `observations-${String(index + 1).padStart(3, '0')}.csv`, bytes: 128, modifiedMs: 1,
}))]
const project = {
  root: projectRoot,
  config: { schemaVersion: 1, name: 'Workspace layout study', mainDocument: 'paper.md', citationStyle: 'draftmatter-author-date', citationLocale: 'en-US' },
  documents: [{ path: 'paper.md', kind: 'manuscript', bytes: source.length, hash: 'paper-hash', modifiedMs: 1 }], bibliographies: [],
}
desktopHost.available = true
desktopHost.openProject = async () => project
desktopHost.readDocument = async () => ({ path: 'paper.md', content: source, hash: 'paper-hash', modifiedMs: 1 })
desktopHost.documentStatus = async () => ({ kind: 'current', hash: 'paper-hash', modifiedMs: 1 })
desktopHost.readCitationLock = async () => null
desktopHost.readCitationCache = async () => null
desktopHost.readExecutionManifests = async () => []
desktopHost.listDocumentRecoveries = async () => []
desktopHost.listSavedDocumentVersions = async () => []
desktopHost.createDocumentRecovery = async (_root, documentPath, content) => ({ id: 'fixture-recovery', documentPath, source: content, savedAtMillis: Date.now(), sourceHash: 'fixture', bytes: content.length })
desktopHost.saveDocument = async (request) => ({ path: request.path, hash: 'paper-hash', bytes: request.content.length, recoveryPath: null })
desktopHost.listProjectFiles = async () => ({ files, truncated: false })
desktopHost.executeKernel = async () => { throw new Error('Layout navigation must not execute manuscript code') }
window.history.replaceState({}, '', applicationRoutePath({ destination: 'local-editor', localProjectId: projectRoot }))
createRoot(document.getElementById('root')!).render(<DraftMatterApplication />)
