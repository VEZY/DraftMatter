import { describe, expect, it, vi } from 'vitest'
import identicalReviewSource from '../fixtures/portable/25-review-identical.qmd?raw'
import { CollaborativeDocument } from './collaboration'
import { projectCollaborationPortableSource } from './collaborationCheckpoint'
import { bootstrapCollaborationSource, initializeCollaborationSource, validateCollaborationServiceUrl } from './hocuspocusClient'
import { publishProjectResources, readProjectResources, sharedImage } from './projectResources'

describe('browser collaboration client boundary', () => {
  it('never imports a stale local resource snapshot when reopening an existing room', async () => {
    const room = CollaborativeDocument.fromPortableSource('# Remote revision\n')
    const current = { images: [sharedImage('figures/plot.svg', new TextEncoder().encode('<svg>New result</svg>'))], citations: [] }
    publishProjectResources(room.doc, current)
    const provider = vi.fn(async () => ({ images: [sharedImage('figures/plot.svg', new TextEncoder().encode('<svg>Old checkpoint</svg>'))], citations: [] }))
    expect(await initializeCollaborationSource(room, { source: '# Stale checkpoint\n', canBootstrap: true, resourceProvider: provider })).toBe(false)
    expect(provider).not.toHaveBeenCalled()
    expect(room.source).toBe('# Remote revision\n')
    expect(readProjectResources(room.doc)).toEqual(current)
    room.destroy()
  })

  it('imports resources atomically only for an explicitly authorized empty-room bootstrap', async () => {
    const room = new CollaborativeDocument()
    const resources = { images: [sharedImage('figures/plot.svg', new TextEncoder().encode('<svg/>'))], citations: [] }
    const provider = vi.fn(async () => resources)
    await expect(initializeCollaborationSource(room, { source: '# Local\n', canBootstrap: false, resourceProvider: provider })).rejects.toThrow(/initialized by its owner/)
    expect(provider).not.toHaveBeenCalled()
    const updates: Uint8Array[] = []
    const stop = room.onUpdate((update) => updates.push(update))
    expect(await initializeCollaborationSource(room, { source: '# Local\n', canBootstrap: true, resourceProvider: provider })).toBe(true)
    expect(updates).toHaveLength(1)
    expect(readProjectResources(room.doc)).toEqual(resources)
    stop(); room.destroy()
  })

  it('rechecks room initialization after an asynchronous resource read', async () => {
    const room = new CollaborativeDocument()
    let finish!: (value: { images: []; citations: [] }) => void
    const reading = new Promise<{ images: []; citations: [] }>((resolve) => { finish = resolve })
    const pending = initializeCollaborationSource(room, { source: '# Local\n', canBootstrap: true, resourceProvider: () => reading })
    room.reconcilePortableSource('# Peer initialized the room\n')
    finish({ images: [], citations: [] })
    expect(await pending).toBe(false)
    expect(room.source).toBe('# Peer initialized the room\n')
    room.destroy()
  })

  it('does not initialize a room if its proposed resource snapshot is invalid', async () => {
    const room = new CollaborativeDocument()
    await expect(initializeCollaborationSource(room, { source: '# Local\n', canBootstrap: true, resources: { images: [{ kind: 'image', path: '../outside.svg', mimeType: 'image/svg+xml', base64: 'AA==' }], citations: [] } })).rejects.toThrow(/unsupported shared resource/)
    expect(room.source).toBe('')
    room.destroy()
  })
  it('requires encrypted remote WebSockets and permits loopback development', () => {
    expect(validateCollaborationServiceUrl('wss://collab.example.org/realtime?secret=drop#fragment')).toBe('wss://collab.example.org/realtime')
    expect(validateCollaborationServiceUrl('ws://127.0.0.1:1234/')).toBe('ws://127.0.0.1:1234')
    expect(() => validateCollaborationServiceUrl('ws://collab.example.org')).toThrow(/requires wss/)
    expect(() => validateCollaborationServiceUrl('https://collab.example.org')).toThrow(/requires wss/)
  })

  it('reconciles local portable edits as a minimal shared transaction without losing review records', () => {
    const collaboration = CollaborativeDocument.fromPortableSource(identicalReviewSource)
    const before = collaboration.source
    const updated = identicalReviewSource.replace('leaf area declined', 'leaf area declined substantially')
    const updates: Uint8Array[] = []
    const stop = collaboration.onUpdate((update, origin) => { if (origin === 'app-edit') updates.push(update) })
    collaboration.reconcilePortableSource(updated, 'app-edit')

    expect(updates).toHaveLength(1)
    expect(updates[0].byteLength).toBeLessThan(collaboration.encodeUpdate().byteLength)
    expect(collaboration.source.length - before.length).toBe(' substantially'.length)
    expect(collaboration.snapshot().proposals.map((proposal) => proposal.id)).toEqual(['dm-i01', 'dm-i02'])
    const projected = projectCollaborationPortableSource(collaboration)
    expect(projected).toContain('leaf area declined substantially')
    expect(projected).toContain('leaf expansion slowed')
    stop()
    collaboration.destroy()
  })

  it('allows only an owner-authorized client to initialize an empty shared manuscript', () => {
    const empty = new CollaborativeDocument()
    expect(() => bootstrapCollaborationSource(empty, '# Shared draft\n', false)).toThrow(/initialized by its owner/)
    expect(empty.source).toBe('')
    expect(bootstrapCollaborationSource(empty, '# Shared draft\n', true)).toBe(true)
    expect(empty.source).toBe('# Shared draft\n')
    expect(bootstrapCollaborationSource(empty, '# Replaced draft\n', false)).toBe(false)
    expect(empty.source).toBe('# Shared draft\n')
    expect(() => bootstrapCollaborationSource(empty, '# Collision\n', true, true)).toThrow(/did not overwrite/)
    expect(empty.source).toBe('# Shared draft\n')
    empty.destroy()
  })
})
