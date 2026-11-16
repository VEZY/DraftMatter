import { createRoot } from 'react-dom/client'
import App from '/src/App'
import { desktopHost } from '/src/desktopHost'
import '/src/styles.css'
import 'katex/dist/katex.min.css'

// A confined fake filesystem: the actual viewer and manuscript renderer still run.
const root = '/fixture/local-images'
const path = 'figures/response plot.png'
const initialSource = '# Local figure study\n\nPlace the figure after this paragraph.\n'
const paper = () => localStorage.getItem('fixture.local-images.paper') ?? initialSource
let image = new Uint8Array(await (await fetch('./response-plot.png')).arrayBuffer())
const reads: string[] = []
const project = {
  root,
  config: { schemaVersion: 1, name: 'Local figure study', mainDocument: 'paper.md', citationStyle: 'draftmatter-author-date', citationLocale: 'en-US' },
  documents: [{ path: 'paper.md', kind: 'manuscript', bytes: paper().length, hash: 'paper-hash', modifiedMs: 1 }], bibliographies: [],
}
desktopHost.available = true
desktopHost.openProject = async () => project
desktopHost.readDocument = async () => ({ path: 'paper.md', content: paper(), hash: 'paper-hash', modifiedMs: 1 })
desktopHost.documentStatus = async () => ({ kind: 'current', hash: 'paper-hash', modifiedMs: 1 })
desktopHost.readCitationLock = async () => null
desktopHost.readCitationCache = async () => null
desktopHost.readExecutionManifests = async () => []
desktopHost.listDocumentRecoveries = async () => []
desktopHost.listSavedDocumentVersions = async () => []
desktopHost.createDocumentRecovery = async (_root, documentPath, source) => ({ id: 'fixture-recovery', documentPath, source, savedAtMillis: Date.now(), sourceHash: 'fixture', bytes: source.length })
desktopHost.saveDocument = async (request) => {
  localStorage.setItem('fixture.local-images.paper', request.content)
  return { path: request.path, hash: 'paper-hash', bytes: request.content.length, recoveryPath: null }
}
desktopHost.listProjectFiles = async () => ({ files: [
  { path: 'paper.md', bytes: paper().length, modifiedMs: 1 }, { path, bytes: image.length, modifiedMs: 1 },
], truncated: false })
desktopHost.readProjectFilePreview = async (requestedRoot, requestedPath, maxBytes) => {
  if (requestedRoot !== root || requestedPath !== path) throw new Error('Unexpected fixture file read')
  reads.push(requestedPath)
  return { path, bytes: [...image.subarray(0, maxBytes)], size: image.length, truncated: image.length > maxBytes, hash: 'sha256:fixture', modifiedMs: 1 }
}
desktopHost.executeKernel = async () => { throw new Error('Image browsing must not execute project code') }
window.projectImagesFixture = { reads: () => reads, paper, async replaceImage() {
  const canvas = document.createElement('canvas')
  canvas.width = 320; canvas.height = 180
  const context = canvas.getContext('2d')!
  context.fillStyle = '#e04b36'; context.fillRect(0, 0, 320, 180)
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), 'image/png'))
  image = new Uint8Array(await blob.arrayBuffer())
} }
createRoot(document.getElementById('root')!).render(<App desktopProjectLaunch={project} />)
