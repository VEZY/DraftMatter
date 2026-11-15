import { describe, expect, it } from 'vitest'
import { classifySelectiveSyncFile, defaultTrackedSyncPaths, MAX_SELECTIVE_SYNC_FILE_BYTES, type SelectiveSyncBaseline, type SelectiveSyncRemoteFile } from './selectiveSync'

const path = 'figures/result.png'
const baseline: SelectiveSyncBaseline = { localHash: 'hash-original', remoteVersionId: 'version-original' }
const local = (hash: string | null = 'hash-original', exists = true) => ({ path, exists, hash })
const remote = (versionId = 'version-original', hash?: string): SelectiveSyncRemoteFile => ({ path, versionId, ...(hash ? { hash } : {}) })

describe('selective synchronization comparisons', () => {
  it.each([
    ['unchanged', 'hash-original', 'version-original', undefined, 'current', 'none'],
    ['local change', 'hash-local', 'version-original', undefined, 'upload', 'upload'],
    ['online change', 'hash-original', 'version-online', undefined, 'download', 'download'],
    ['both change', 'hash-local', 'version-online', 'hash-online', 'conflict', 'resolve'],
    ['both change to equal contents', 'hash-same', 'version-online', 'hash-same', 'establish-baseline', 'record-baseline'],
    ['new online version with equal contents', 'hash-original', 'version-online', 'hash-original', 'establish-baseline', 'record-baseline'],
  ] as const)('classifies %s against the common version', (_name, hash, version, onlineHash, state, action) => {
    expect(classifySelectiveSyncFile({ local: local(hash), remote: remote(version, onlineHash), baseline })).toMatchObject({
      path, state, action, expectedLocalHash: hash, expectedRemoteVersionId: version,
    })
  })

  it('records initial equality only when actual contents are known to match', () => {
    expect(classifySelectiveSyncFile({ local: local(), remote: remote('version-new', 'hash-original') }).state).toBe('establish-baseline')
    expect(classifySelectiveSyncFile({ local: local(), remote: remote('version-new', 'hash-other') }).state).toBe('conflict')
    expect(classifySelectiveSyncFile({ local: local(), remote: remote('version-new') }).state).toBe('conflict')
    expect(classifySelectiveSyncFile({ local: local(null), remote: remote('version-new', 'hash-original'), baseline }).state).toBe('conflict')
    expect(classifySelectiveSyncFile({ local: local(), remote: remote('version-original', 'hash-other'), baseline }).state).toBe('conflict')
  })

  it('allows creating a missing copy without replacing a divergent file', () => {
    expect(classifySelectiveSyncFile({ local: local() })).toMatchObject({ state: 'upload', expectedRemoteVersionId: null })
    expect(classifySelectiveSyncFile({ local: local(null, false), remote: remote() })).toMatchObject({ state: 'download', expectedLocalHash: null })
    expect(classifySelectiveSyncFile({ local: local(), baseline: { localHash: 'hash-original', remoteVersionId: null } }).state).toBe('upload')
  })

  it('retains deletion conflicts instead of recreating or deleting files automatically', () => {
    expect(classifySelectiveSyncFile({ local: local(null, false), remote: remote(), baseline }).state).toBe('local-missing')
    expect(classifySelectiveSyncFile({ local: local(null, false), remote: remote('version-new'), baseline }).state).toBe('conflict')
    const deleted = { ...remote('version-deleted'), deleted: true }
    expect(classifySelectiveSyncFile({ local: local(), remote: deleted, baseline }).state).toBe('remote-missing')
    expect(classifySelectiveSyncFile({ local: local('hash-changed'), remote: deleted, baseline }).state).toBe('conflict')
    expect(classifySelectiveSyncFile({ local: local(), remote: deleted }).state).toBe('remote-missing')
    expect(classifySelectiveSyncFile({ local: local(null, false), remote: deleted, baseline })).toMatchObject({ state: 'conflict', action: 'resolve', expectedRemoteVersionId: 'version-deleted' })
    expect(classifySelectiveSyncFile({ local: local(null, false), baseline }).state).toBe('conflict')
  })

  it('does not describe unavailable copies or oversized transfers as synchronized', () => {
    expect(classifySelectiveSyncFile({ local: local(null, false) })).toMatchObject({ state: 'local-missing', action: 'none' })
    expect(classifySelectiveSyncFile({ local: { ...local(), tooLarge: true }, remote: remote(), baseline }).state).toBe('too-large')
    expect(classifySelectiveSyncFile({ local: local(), remote: { ...remote(), size: MAX_SELECTIVE_SYNC_FILE_BYTES + 1 }, baseline }).state).toBe('too-large')
  })

  it('rejects path mismatches and private metadata rather than comparing unrelated files', () => {
    expect(() => classifySelectiveSyncFile({ local: local(), remote: { ...remote(), path: 'other.png' } })).toThrow('do not match')
    expect(() => classifySelectiveSyncFile({ local: { ...local(), path: '../outside.png' } })).toThrow('project-relative')
    expect(() => classifySelectiveSyncFile({ local: { ...local(), path: '.git/config' } })).toThrow('project-relative')
  })
})

describe('default synchronization selection', () => {
  it('follows the manuscript, figures, and references while leaving data and arbitrary JSON to explicit choices', () => {
    expect(defaultTrackedSyncPaths({
      manuscriptPath: 'paper.qmd',
      figurePaths: ['plots/referenced.svg'],
      bibliographyPaths: ['metadata/sources.json'],
      files: ['paper.qmd', 'figures/unused.png', 'figures/plot.pdf', 'figures/readme.txt', 'references.bib', 'references.json', 'data/input.csv', 'data/study.json', { path: 'data/discovered.json', kind: 'bibliography' }, { path: 'data/raw-image.png', kind: 'figure' }, 'analysis.py', '.git/config', '.draftmatter/state.json'],
    })).toEqual(['figures/plot.pdf', 'figures/unused.png', 'metadata/sources.json', 'paper.qmd', 'plots/referenced.svg', 'references.bib', 'references.json'])
  })

  it('preserves explicit opt-outs when defaults are discovered again', () => {
    expect(defaultTrackedSyncPaths({ manuscriptPath: 'paper.qmd', files: ['figures/unused.png', 'references.json', 'figures/new.png'], excludedPaths: ['paper.qmd', 'figures/unused.png'] }))
      .toEqual(['figures/new.png', 'references.json'])
  })
})
