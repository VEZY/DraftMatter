import { useEffect, useRef, useState } from 'react'
import { desktopHost, type ApplyProjectSyncFileResult, type ProjectSnapshot } from './desktopHost'
import type { CollaborationFileService } from './CollaborationDialog'
import { ProjectFileClient } from './collaboration/projectFileClient'
import { normalizeCollaborationServiceUrl } from './collaboration/serviceClient'
import { projectAssetHash } from './desktopHost'
import { defaultTrackedSyncPaths } from './selectiveSync'
import { ProjectSyncController, type ProjectSyncSnapshot, type ProjectSyncComparison, type ProjectSyncExpectedVersions } from './projectSyncController'
import { ProjectSyncRemoteAdapter, type ProjectSyncLiveManuscript, type ProjectSyncPreview } from './projectSyncRemote'

export interface ProjectSynchronizationOptions {
  project: ProjectSnapshot | null
  manuscriptPath?: string
  service: CollaborationFileService | null
  connected: boolean
  getManuscript: () => ProjectSyncLiveManuscript | undefined
  getPreviews: () => Promise<ProjectSyncPreview[]>
  defaultFigurePaths: () => string[]
  defaultBibliographyPaths: () => string[]
  canonicalizePreview?: (path: string, bytes: Uint8Array) => Promise<Uint8Array>
  publishPreview: (path: string, bytes: Uint8Array, expectedHash: string | null) => Promise<Uint8Array | void>
  onLocalApplied: (path: string, result?: ApplyProjectSyncFileResult) => Promise<void>
}

export function useProjectSynchronization(options: ProjectSynchronizationOptions) {
  const latest = useRef(options)
  latest.current = options
  const controller = useRef<ProjectSyncController | null>(null)
  const [snapshot, setSnapshot] = useState<ProjectSyncSnapshot | null>(null)
  const service = options.service
  const root = options.project?.root
  const path = options.manuscriptPath
  const link = options.project?.config.collaboration
  let sameService = false
  try { sameService = Boolean(link && service && normalizeCollaborationServiceUrl(link.serviceUrl).apiUrl === service.client.urls.apiUrl) } catch { /* Invalid links cannot enable synchronization. */ }
  const active = Boolean(desktopHost.available && root && path && service && options.connected
    && sameService && link && link.workspaceId === service?.workspace.id && link.projectId === service?.projectId)

  useEffect(() => {
    setSnapshot(null)
    if (!active || !root || !path || !service || !link) return
    let disposed = false
    const isCurrent = () => {
      const current = latest.current
      const currentLink = current.project?.config.collaboration
      try {
        return !disposed && current.connected && current.project?.root === root && current.manuscriptPath === path
          && current.service?.client === service.client && current.service.currentUserId === service.currentUserId
          && current.service.workspace.id === service.workspace.id && current.service.projectId === service.projectId
          && currentLink?.workspaceId === service.workspace.id && currentLink.projectId === service.projectId
          && normalizeCollaborationServiceUrl(currentLink.serviceUrl).apiUrl === service.client.urls.apiUrl
      } catch { return false }
    }
    const canUpload = () => isCurrent() && ['owner', 'editor'].includes(latest.current.service?.workspace.role ?? '')
    const requireCurrent = () => { if (!isCurrent()) throw new Error('The linked project or account changed. Reconnect before synchronizing.') }
    const remote = new ProjectSyncRemoteAdapter({
      api: new ProjectFileClient(service.client, service.workspace.id, service.projectId, service.currentUserId),
      canUpload,
      liveManuscript: {
        path,
        read: async () => {
          requireCurrent()
          const manuscript = latest.current.getManuscript()
          if (!manuscript || manuscript.path !== path) throw new Error('Reconnect this manuscript before synchronizing it.')
          return manuscript.read()
        },
        write: async (bytes, expectedVersionId) => {
          const manuscript = latest.current.getManuscript()
          if (!canUpload() || !manuscript || manuscript.path !== path) throw new Error('This manuscript is no longer editable in the active project.')
          return manuscript.write(bytes, expectedVersionId)
        },
      },
      getPreviews: () => { requireCurrent(); return latest.current.getPreviews() },
      canonicalizePreview: (filePath, bytes) => { requireCurrent(); return latest.current.canonicalizePreview?.(filePath, bytes) ?? Promise.resolve(bytes) },
      publishPreview: (filePath, bytes, expectedHash) => { requireCurrent(); return latest.current.publishPreview(filePath, bytes, expectedHash) },
    })
    const instance = new ProjectSyncController({
      root,
      scope: { serviceUrl: link.serviceUrl, workspaceId: service.workspace.id, projectId: service.projectId },
      manuscriptPath: path,
      host: desktopHost,
      remote,
      canUpload,
      getDefaultPaths: (files) => { requireCurrent(); return defaultTrackedSyncPaths({
        manuscriptPath: path,
        files,
        figurePaths: latest.current.defaultFigurePaths(),
        bibliographyPaths: latest.current.defaultBibliographyPaths(),
      }) },
      onLocalApplied: (filePath, result) => { if (isCurrent()) return latest.current.onLocalApplied(filePath, result) },
      onRemoteWritten: async (filePath, bytes) => { const hash = await projectAssetHash(bytes); if (isCurrent()) await latest.current.onLocalApplied(filePath, { path: filePath, bytes: bytes.byteLength, hash, recoveryPath: null }) },
    })
    controller.current = instance
    const unsubscribe = instance.subscribe(setSnapshot)
    setSnapshot(instance.getSnapshot())
    const synchronize = () => { if (!instance.getSnapshot().busy) void instance.sync().catch(() => undefined) }
    synchronize()
    const timer = window.setInterval(synchronize, 10_000)
    const focus = synchronize
    window.addEventListener('focus', focus)
    return () => {
      disposed = true
      window.clearInterval(timer)
      window.removeEventListener('focus', focus)
      unsubscribe()
      instance.dispose()
      if (controller.current === instance) controller.current = null
    }
  }, [active, root, path, service?.client, service?.workspace.id, service?.projectId, service?.currentUserId, link?.serviceUrl])

  return {
    active, snapshot,
    syncNow: async () => { await controller.current?.sync() },
    setTracked: async (filePath: string, tracked: boolean) => {
      const instance = controller.current
      await instance?.setTracked(filePath, tracked)
      if (tracked && instance === controller.current && !instance?.getSnapshot().paused) await instance?.sync()
    },
    setPaused: async (paused: boolean) => {
      const instance = controller.current
      await instance?.setPaused(paused)
      if (!paused && instance === controller.current) await instance?.sync()
    },
    compare: async (filePath: string, expected?: ProjectSyncExpectedVersions) => controller.current?.compare(filePath, expected),
    resolve: async (filePath: string, choice: 'local' | 'remote' | 'both', expected?: ProjectSyncExpectedVersions) => { await controller.current?.resolve(filePath, choice, expected) },
  }
}

export type ProjectSynchronization = Omit<ReturnType<typeof useProjectSynchronization>, 'compare'> & { compare?: (path: string, expected?: ProjectSyncExpectedVersions) => Promise<ProjectSyncComparison | undefined> }
