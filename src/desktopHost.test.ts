import { describe, expect, it, vi } from 'vitest'
import { createDesktopHost, normaliseHostFailure, resolveMainDocument, type ProjectSnapshot } from './desktopHost'

const project: ProjectSnapshot = {
  root: '/research/canopy',
  config: { schemaVersion: 1, name: 'Canopy study', mainDocument: 'paper.qmd' },
  documents: [],
  bibliographies: [],
}

describe('desktop host adapter', () => {
  it('keeps native command names and payloads typed and narrow', async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = []
    const invoke = async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push([command, args])
      return (command === 'open_project' ? project : { hash: 'next' }) as T
    }
    const host = createDesktopHost(invoke, vi.fn(), true)

    await expect(host.openProject('/research/canopy')).resolves.toEqual(project)
    await host.readDocument('/research/canopy', 'paper.qmd')
    await host.readBibliography('/research/canopy', 'references.bib')
    await host.saveDocument({ root: '/research/canopy', path: 'paper.qmd', content: '# Paper', expectedHash: 'old' })
    await host.documentStatus('/research/canopy', 'paper.qmd', 'next')
    await host.setMainDocument('/research/canopy', 'renamed.qmd')

    expect(calls).toEqual([
      ['open_project', { root: '/research/canopy' }],
      ['read_document', { root: '/research/canopy', path: 'paper.qmd' }],
      ['read_bibliography', { root: '/research/canopy', path: 'references.bib' }],
      ['save_document', { request: { root: '/research/canopy', path: 'paper.qmd', content: '# Paper', expectedHash: 'old' } }],
      ['document_status', { root: '/research/canopy', path: 'paper.qmd', expectedHash: 'next' }],
      ['set_main_document', { root: '/research/canopy', path: 'renamed.qmd' }],
    ])
  })

  it('does not open a system picker from the browser fallback', async () => {
    const picker = vi.fn()
    const host = createDesktopHost(vi.fn(), picker, false)

    await expect(host.pickProjectFolder()).resolves.toBeNull()
    expect(picker).not.toHaveBeenCalled()
  })

  it('normalises structured conflicts without losing their safe message', () => {
    expect(normaliseHostFailure({ kind: 'conflict', message: 'paper.qmd changed outside DraftMatter.' })).toEqual({
      kind: 'conflict',
      message: 'paper.qmd changed outside DraftMatter.',
    })
  })

  it('uses configuration or an explicit choice without guessing between manuscripts', () => {
    const multiple: ProjectSnapshot = {
      ...project,
      config: { ...project.config, mainDocument: 'missing.qmd' },
      documents: [
        { path: 'article.qmd', kind: 'manuscript', bytes: 10, modifiedMs: 1, hash: 'a' },
        { path: 'notes.md', kind: 'manuscript', bytes: 20, modifiedMs: 2, hash: 'b' },
      ],
    }

    expect(resolveMainDocument(multiple)).toBeNull()
    expect(resolveMainDocument(multiple, 'notes.md')).toBe('notes.md')
    expect(resolveMainDocument({ ...multiple, documents: [multiple.documents[0]] })).toBe('article.qmd')
  })
})
