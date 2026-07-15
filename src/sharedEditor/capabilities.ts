export interface SharedEditorCapabilities {
  documentEditing: true
  review: true
  portableImport: true
  cleanClientExport: true
  localFilesystem: false
  localProcesses: false
  codeExecution: false
  git: false
  externalRenderers: false
}

/**
 * Capabilities exposed by the reusable browser editor/reviewer surface.
 *
 * This is intentionally a positive, closed contract rather than a collection
 * of runtime permission checks. Privileged desktop adapters are not part of
 * this package's dependency graph at all.
 */
export const sharedEditorCapabilities: Readonly<SharedEditorCapabilities> = Object.freeze({
  documentEditing: true,
  review: true,
  portableImport: true,
  cleanClientExport: true,
  localFilesystem: false,
  localProcesses: false,
  codeExecution: false,
  git: false,
  externalRenderers: false,
})
