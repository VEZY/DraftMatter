import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { FileCollaborationStore } from './fileStore'

// A valid UUID may begin with a digit; generated temporary IDs still need to
// satisfy the reference store's letter-prefixed identifier contract.
vi.mock('node:crypto', async (original) => ({
  ...await original<typeof import('node:crypto')>(),
  randomUUID: () => '01234567-89ab-4cde-8fab-0123456789ab',
}))

it('writes and reopens state with the default UUID generator even when its UUID begins with a digit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'draftmatter-default-id-'))
  const document = new Y.Doc()
  const recovered = new Y.Doc()
  try {
    const store = new FileCollaborationStore({ root })
    document.getText('paper').insert(0, 'Saved manuscript')
    await store.createSnapshot({ workspaceId: 'lab', projectId: 'paper' }, 'initial', Y.encodeStateAsUpdate(document))
    Y.applyUpdate(recovered, (await store.load({ workspaceId: 'lab', projectId: 'paper' })).snapshot!)
    expect(recovered.getText('paper').toString()).toBe('Saved manuscript')
  } finally {
    document.destroy(); recovered.destroy()
    await rm(root, { recursive: true, force: true })
  }
})
