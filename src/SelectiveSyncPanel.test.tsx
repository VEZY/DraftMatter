// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SelectiveSyncPanel } from './SelectiveSyncPanel'
import type { ProjectSynchronization } from './useProjectSynchronization'
import type { ProjectSyncComparison, ProjectSyncRow, ProjectSyncSnapshot } from './projectSyncController'

const hash = `sha256:${'a'.repeat(64)}`
function row(path: string, state: ProjectSyncRow['state'], tracked = true, isDefault = false): ProjectSyncRow {
  return {
    path, state, tracked, isDefault, action: state === 'conflict' || state === 'local-missing' || state === 'remote-missing' ? 'resolve' : 'none',
    reason: state === 'conflict' ? 'Both copies changed since their last common version.' : 'The saved copies are preserved.',
    expectedLocalHash: hash, expectedRemoteVersionId: 'file-current',
    local: { path, exists: true, hash, bytes: 20, modifiedMs: 1, tooLarge: false },
    remote: { path, versionId: 'file-current', hash, size: 20 },
  }
}
function model(rows: ProjectSyncRow[] = []): ProjectSynchronization {
  const snapshot: ProjectSyncSnapshot = { rows, busy: false, paused: false, trackedPaths: rows.filter((row) => row.tracked).map((row) => row.path), excludedPaths: [], stale: false }
  return { active: true, snapshot, syncNow: vi.fn(async () => {}), setTracked: vi.fn(async () => {}), setPaused: vi.fn(async () => {}), resolve: vi.fn(async () => {}) }
}

describe('selective synchronization choices', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  })
  afterEach(async () => { await act(async () => root.unmount()); container.remove() })
  const button = (label: string, scope: ParentNode = container) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === label)!
  const checkbox = (path: string) => container.querySelector<HTMLInputElement>(`input[aria-label="Follow ${path}"]`)!

  it('shows manuscript, figures and references followed by default while letting users opt in or out explicitly', async () => {
    const current = model([row('paper.qmd', 'current', true, true), row('figures/result.svg', 'current', true, true), row('references.bib', 'current', true, true), row('data/input.csv', 'untracked', false)])
    await act(async () => root.render(<SelectiveSyncPanel model={current} />))
    expect(checkbox('paper.qmd').checked).toBe(true)
    expect(checkbox('figures/result.svg').checked).toBe(true)
    expect(checkbox('references.bib').checked).toBe(true)
    expect(checkbox('data/input.csv').checked).toBe(false)
    await act(async () => checkbox('data/input.csv').click())
    expect(current.setTracked).toHaveBeenCalledWith('data/input.csv', true)
    await act(async () => checkbox('figures/result.svg').click())
    expect(current.setTracked).toHaveBeenCalledWith('figures/result.svg', false)
    expect(container.textContent).toContain('Deletions are never propagated automatically')
  })

  it('routes each explicit conflict choice to its file and disables choices without the necessary copy', async () => {
    const missingLocal = row('data/missing-local.csv', 'local-missing')
    missingLocal.local = { ...missingLocal.local!, exists: false, hash: null, bytes: 0 }
    const missingRemote = row('data/missing-online.csv', 'remote-missing')
    missingRemote.remote = { ...missingRemote.remote!, deleted: true }
    const current = model([row('data/conflict.csv', 'conflict'), missingLocal, missingRemote])
    await act(async () => root.render(<SelectiveSyncPanel model={current} />))
    const conflict = checkbox('data/conflict.csv').closest('li')!
    for (const [label, choice] of [['Keep local', 'local'], ['Use online', 'remote'], ['Keep both', 'both']] as const) {
      await act(async () => button(label, conflict).click())
      expect(current.resolve).toHaveBeenCalledWith('data/conflict.csv', choice, { localHash: hash, remoteVersionId: 'file-current' })
    }
    const local = checkbox('data/missing-local.csv').closest('li')!
    expect(button('Keep local', local).disabled).toBe(true)
    expect(button('Keep both', local).disabled).toBe(true)
    expect(button('Use online', local).disabled).toBe(false)
    const remote = checkbox('data/missing-online.csv').closest('li')!
    expect(button('Use online', remote).disabled).toBe(true)
    expect(button('Keep both', remote).disabled).toBe(true)
    expect(button('Keep local', remote).disabled).toBe(false)
    expect(container.textContent).toContain('3 to resolve')
  })

  it('keeps conflict copies visible and surfaces a stale-version rejection instead of claiming success', async () => {
    const current = model([row('figures/result.svg', 'conflict')])
    vi.mocked(current.resolve).mockRejectedValue(new Error('The online version changed. Refresh before deciding.'))
    await act(async () => root.render(<SelectiveSyncPanel model={current} />))
    await act(async () => button('Use online').click())
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('The online version changed. Refresh before deciding.')
    expect(checkbox('figures/result.svg').checked).toBe(true)
    expect(button('Keep both').disabled).toBe(false)
  })

  it('compares both copies as inert read-only text before choosing a version', async () => {
    const current = model([row('data/conflict.txt', 'conflict')])
    const localText = '<img src=x onerror="window.injected=true"><script>window.injected=true</script>\nLocal results'
    const onlineText = 'Online results\nA different analysis'
    const expected = { localHash: hash, remoteVersionId: 'file-current' }
    current.compare = vi.fn(async (): Promise<ProjectSyncComparison> => ({
      path: 'data/conflict.txt', expected,
      local: { bytes: new TextEncoder().encode(localText), hash },
      remote: { bytes: new TextEncoder().encode(onlineText), hash, versionId: 'file-current' },
    }))
    await act(async () => root.render(<SelectiveSyncPanel model={current} />))
    await act(async () => button('Compare copies').click())
    expect(current.compare).toHaveBeenCalledWith('data/conflict.txt', expected)
    const comparison = container.querySelector('[aria-label="Compare copies of data/conflict.txt"]')!
    expect([...comparison.querySelectorAll('pre')].map((element) => element.textContent)).toEqual([localText, onlineText])
    expect(comparison.querySelector('img, script, textarea, input, [contenteditable="true"]')).toBeNull()
    expect(comparison.textContent).toContain('Local copy')
    expect(comparison.textContent).toContain('Online copy')
    expect(current.resolve).not.toHaveBeenCalled()
    expect(current.setTracked).not.toHaveBeenCalled()
    expect(current.syncNow).not.toHaveBeenCalled()
    await act(async () => button('Close comparison').click())
    expect(container.querySelector('[aria-label="Compare copies of data/conflict.txt"]')).toBeNull()
    await act(async () => button('Compare copies').click())
    await act(async () => button('Keep both').click())
    expect(current.resolve).toHaveBeenCalledWith('data/conflict.txt', 'both', expected)
    expect(container.querySelector('[aria-label="Compare copies of data/conflict.txt"]')).toBeNull()
  })

  it('disables all conflict choices when the displayed comparison is stale until the copies are compared again', async () => {
    const initialRow = row('data/conflict.txt', 'conflict')
    const current = model([initialRow])
    const initialExpected = { localHash: hash, remoteVersionId: 'file-current' }
    const latestExpected = { localHash: hash, remoteVersionId: 'file-newest' }
    current.compare = vi.fn()
      .mockResolvedValueOnce({ path: initialRow.path, expected: initialExpected, local: { bytes: new TextEncoder().encode('Local analysis'), hash }, remote: { bytes: new TextEncoder().encode('Online analysis'), hash, versionId: 'file-current' } })
      .mockResolvedValueOnce({ path: initialRow.path, expected: latestExpected, local: { bytes: new TextEncoder().encode('Local analysis'), hash }, remote: { bytes: new TextEncoder().encode('Newest online analysis'), hash, versionId: 'file-newest' } })
    await act(async () => root.render(<SelectiveSyncPanel model={current} />))
    await act(async () => button('Compare copies').click())
    const updatedRow = { ...initialRow, expectedRemoteVersionId: 'file-newest', remote: { ...initialRow.remote!, versionId: 'file-newest' } }
    await act(async () => root.render(<SelectiveSyncPanel model={{ ...current, snapshot: { ...current.snapshot!, rows: [updatedRow] } }} />))
    expect(container.querySelector('[role="status"]')?.textContent).toContain('The copies changed after this preview')
    for (const label of ['Keep local', 'Use online', 'Keep both']) {
      expect(button(label).disabled).toBe(true)
      await act(async () => button(label).click())
    }
    expect(current.resolve).not.toHaveBeenCalled()
    expect(button('Compare copies').disabled).toBe(false)
    await act(async () => button('Compare copies').click())
    expect(current.compare).toHaveBeenLastCalledWith(initialRow.path, latestExpected)
    expect(container.querySelector('[role="status"]')).toBeNull()
    expect(container.querySelector('.selective-sync-comparison')?.textContent).toContain('Newest online analysis')
    expect(button('Use online').disabled).toBe(false)
    await act(async () => button('Use online').click())
    expect(current.resolve).toHaveBeenCalledWith(initialRow.path, 'remote', latestExpected)
  })

  it('keeps pause and unfollow available during a pass while preventing another synchronization', async () => {
    const current = model([row('paper.qmd', 'current', true, true)])
    await act(async () => root.render(<SelectiveSyncPanel model={current} />))
    await act(async () => button('Pause').click())
    expect(current.setPaused).toHaveBeenCalledWith(true)
    await act(async () => root.render(<SelectiveSyncPanel model={{ ...current, snapshot: { ...current.snapshot!, paused: true } }} />))
    expect(button('Sync now').disabled).toBe(true)
    expect(container.textContent).toContain('Paused. Existing copies are preserved.')
    await act(async () => button('Resume').click())
    expect(current.setPaused).toHaveBeenCalledWith(false)
    await act(async () => root.render(<SelectiveSyncPanel model={{ ...current, snapshot: { ...current.snapshot!, busy: true } }} />))
    expect(checkbox('paper.qmd').disabled).toBe(false)
    expect(button('Pause').disabled).toBe(false)
    expect(button('Synchronizing…').disabled).toBe(true)
    await act(async () => { checkbox('paper.qmd').click(); button('Pause').click() })
    expect(current.setTracked).toHaveBeenLastCalledWith('paper.qmd', false)
    expect(current.setPaused).toHaveBeenLastCalledWith(true)
    expect(current.syncNow).not.toHaveBeenCalled()
  })

  it('filters the available choices without changing tracking and hides when synchronization is unavailable', async () => {
    const current = model([row('paper.qmd', 'current', true, true), row('data/input.csv', 'untracked', false)])
    await act(async () => root.render(<SelectiveSyncPanel model={current} />))
    const input = container.querySelector<HTMLInputElement>('[aria-label="Find a synchronization file"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'DATA/')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.querySelectorAll('.selective-sync-file')).toHaveLength(1)
    expect(container.textContent).toContain('data/input.csv')
    expect(current.setTracked).not.toHaveBeenCalled()
    await act(async () => root.render(<SelectiveSyncPanel model={{ ...current, active: false }} />))
    expect(container.querySelector('[aria-label="Selective synchronization"]')).toBeNull()
  })
})
