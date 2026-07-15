import { describe, expect, it, vi } from 'vitest'
import { createDesktopHost, normaliseCrossrefFailure, normaliseHostFailure, resolveMainDocument, type ProjectSnapshot } from './desktopHost'

const project: ProjectSnapshot = {
  root: '/research/canopy',
  config: { schemaVersion: 1, name: 'Canopy study', mainDocument: 'paper.qmd', citationStyle: 'draftmatter-author-date', citationLocale: 'en-US' },
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
    await host.readCitationLock('/research/canopy')
    await host.readCitationCache('/research/canopy')
    await host.saveCitationLock({ root: '/research/canopy', content: '{"schemaVersion":1,"entries":[]}', expectedHash: null })
    await host.saveDocument({ root: '/research/canopy', path: 'paper.qmd', content: '# Paper', expectedHash: 'old' })
    await host.acquireCitations({
      root: '/research/canopy',
      documentPath: 'paper.qmd',
      documentContent: 'Cited [@vezy2020].',
      expectedDocumentHash: 'old',
      bibliographyPath: 'references.json',
      expectedBibliographyHash: null,
      bibliographyRecords: [{ id: 'vezy2020' }],
      lockContent: '{"schemaVersion":1,"entries":[]}',
      expectedLockHash: null,
      cacheContent: '{"schemaVersion":1,"records":[]}',
      expectedCacheHash: null,
    })
    await host.documentStatus('/research/canopy', 'paper.qmd', 'next')
    await host.setMainDocument('/research/canopy', 'renamed.qmd')
    await host.setCitationPreferences('/research/canopy', 'draftmatter-numeric', 'fr-FR')
    await host.zoteroStatus()
    await host.searchZotero('canopy water', 12)
    await host.searchCrossref({ kind: 'doi', doi: '10.1016/j.envsoft.2019.104609' })
    await host.resolveDoiCsl('10.1016/j.envsoft.2019.104609')
    await host.openScholarSearch('vezy et al. 2020 DynACof')
    await host.probeRuntime('julia')
    await host.discoverJupyterKernels()
    await host.executionTrustStatus('/research/canopy')
    await host.trustProjectForSession('/research/canopy', 'run-project-code-with-user-permissions')
    await host.revokeProjectTrust('/research/canopy')

    expect(calls).toEqual([
      ['open_project', { root: '/research/canopy' }],
      ['read_document', { root: '/research/canopy', path: 'paper.qmd' }],
      ['read_bibliography', { root: '/research/canopy', path: 'references.bib' }],
      ['read_citation_lock', { root: '/research/canopy' }],
      ['read_citation_cache', { root: '/research/canopy' }],
      ['save_citation_lock', { request: { root: '/research/canopy', content: '{"schemaVersion":1,"entries":[]}', expectedHash: null } }],
      ['save_document', { request: { root: '/research/canopy', path: 'paper.qmd', content: '# Paper', expectedHash: 'old' } }],
      ['acquire_citations', { request: {
        root: '/research/canopy', documentPath: 'paper.qmd', documentContent: 'Cited [@vezy2020].', expectedDocumentHash: 'old', bibliographyPath: 'references.json', expectedBibliographyHash: null, bibliographyRecords: [{ id: 'vezy2020' }], lockContent: '{"schemaVersion":1,"entries":[]}', expectedLockHash: null, cacheContent: '{"schemaVersion":1,"records":[]}', expectedCacheHash: null,
      } }],
      ['document_status', { root: '/research/canopy', path: 'paper.qmd', expectedHash: 'next' }],
      ['set_main_document', { root: '/research/canopy', path: 'renamed.qmd' }],
      ['set_citation_preferences', { root: '/research/canopy', style: 'draftmatter-numeric', locale: 'fr-FR' }],
      ['zotero_status', undefined],
      ['zotero_search', { query: 'canopy water', limit: 12 }],
      ['crossref_search', { request: { doi: '10.1016/j.envsoft.2019.104609' } }],
      ['resolve_doi_csl', { doi: '10.1016/j.envsoft.2019.104609' }],
      ['open_scholar_search', { query: 'vezy et al. 2020 DynACof' }],
      ['probe_runtime_executable', { language: 'julia' }],
      ['discover_jupyter_kernels', undefined],
      ['execution_trust_status', { root: '/research/canopy' }],
      ['trust_project_for_session', { root: '/research/canopy', acknowledgement: 'run-project-code-with-user-permissions' }],
      ['revoke_project_trust', { root: '/research/canopy' }],
    ])
  })

  it('does not open a system picker from the browser fallback', async () => {
    const picker = vi.fn()
    const invoke = vi.fn()
    const host = createDesktopHost(invoke, picker, false)

    await expect(host.pickProjectFolder()).resolves.toBeNull()
    await expect(host.executionTrustStatus('/project')).rejects.toMatchObject({ kind: 'integration' })
    await expect(host.trustProjectForSession('/project', 'run-project-code-with-user-permissions')).rejects.toMatchObject({ kind: 'integration' })
    expect(picker).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('normalises structured conflicts without losing their safe message', () => {
    expect(normaliseHostFailure({ kind: 'conflict', message: 'paper.qmd changed outside DraftMatter.' })).toEqual({
      kind: 'conflict',
      message: 'paper.qmd changed outside DraftMatter.',
    })
  })

  it('normalises Crossref rate limits and keeps retry guidance', () => {
    expect(normaliseCrossrefFailure({ kind: 'rate-limit', message: 'Slow down.', retryAfterMs: 3000 })).toMatchObject({
      kind: 'rate-limit',
      message: 'Slow down.',
      retryAfterMs: 3000,
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
