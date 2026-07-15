import type { CollaborationProjectScope, CollaborationSnapshotMetadata } from './fileStore'

export interface LoadedCollaborationState {
  snapshot?: Uint8Array
  snapshotMetadata?: CollaborationSnapshotMetadata
  updates: Uint8Array[]
  lastActivityAt: string
}

export interface CollaborationPersistence {
  appendUpdate(scope: CollaborationProjectScope, update: Uint8Array): Promise<{ pendingUpdates: number; pendingBytes: number }>
  createSnapshot(scope: CollaborationProjectScope, snapshotId: string, stateUpdate: Uint8Array): Promise<CollaborationSnapshotMetadata>
  load(scope: CollaborationProjectScope): Promise<LoadedCollaborationState>
}
