// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RecoveryHistory, type RecoveryHistoryProps, type RecoveryHistoryVersion } from './RecoveryHistory'
import { parsePortableDocument, sourceHash } from './document'
import { initialDraft } from './sampleDraft'
import type { RecoverySnapshot } from './storage'

const current = '---\ntitle: "Current paper"\n---\n\n# Results\n\nCurrent manuscript text.\n'
function snapshot(id: string, source: string, hour = '08'): RecoverySnapshot {
  return { id, filename: 'paper.md', title: `Version ${id}`, savedAt: `2026-11-16T${hour}:00:00.000Z`, sourceHash: sourceHash(source), source,
    draft: parsePortableDocument(source, initialDraft).draft,
    documentIdentity: { kind: 'desktop', projectRoot: '/research/paper', documentPath: 'paper.md' } }
}
const older = snapshot('older', current.replace('Current manuscript text.', 'Earlier **manuscript** text.'))
const oldest = snapshot('oldest', current.replace('Current manuscript text.', 'The first saved draft.'), '07')
const metadata = ({ source: _source, draft: _draft, ...version }: RecoverySnapshot): RecoveryHistoryVersion => version
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('read-only recovery history browsing', () => {
  let container: HTMLDivElement, root: ReturnType<typeof createRoot>
  let props: RecoveryHistoryProps
  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
    props = { snapshots: [older, oldest], documentPath: 'paper.md', currentSource: current, currentTitle: 'Current paper', onClose: vi.fn(), onRestore: vi.fn(), onSaveVersion: vi.fn() }
  })
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks() })
  async function render(next = props) { props = next; await act(async () => root.render(<RecoveryHistory {...props} />)) }
  async function select(id: string) { await act(async () => container.querySelector<HTMLButtonElement>(`[data-history-select="${id}"]`)!.click()) }
  function button(text: string) { return [...container.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent === text)! }
  async function name(value: string) {
    const input = container.querySelector<HTMLInputElement>('.recovery-name-form input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    return input
  }

  it('previews a saved manuscript without restoring, saving, executing code, or fetching historical images', async () => {
    const source = `${older.source}\n![Archived figure](https://example.test/image.svg)\n\n<script>window.historicalCodeRan=true</script>\n\n\`\`\`python {#analysis .execute}\nprint("do not run")\n\`\`\`\n`
    const historical = snapshot('historical', source)
    const fetch = vi.spyOn(globalThis, 'fetch')
    await render({ ...props, snapshots: [historical] })
    expect(document.activeElement).toBe(container.querySelector('[data-history-select="current"]'))
    await select('historical')
    const preview = container.querySelector('[aria-label="Read-only manuscript preview"]')!
    expect(preview.textContent).toContain('Earlier manuscript text.')
    expect(preview.querySelector('strong')?.textContent).toBe('manuscript')
    expect(preview.querySelectorAll('img, script, iframe, [contenteditable]')).toHaveLength(0)
    expect(preview.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Archived figure')
    expect(preview.querySelector('details pre')?.textContent).toContain('print("do not run")')
    expect(props.onRestore).not.toHaveBeenCalled()
    expect(props.onSaveVersion).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(historical.source).toBe(source)
  })

  it('keeps both distinct events and the selected preview when a new version has identical contents', async () => {
    await render()
    await select('older')
    const newEvent = { ...older, id: 'new-event', savedAt: '2026-11-16T10:00:00.000Z' }
    await render({ ...props, snapshots: [newEvent, older, oldest] })
    expect(container.querySelectorAll('.recovery-version-button')).toHaveLength(3)
    expect(container.querySelector('[data-history-select="older"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector('[aria-label="Read-only manuscript preview"]')?.textContent).toContain('Earlier manuscript text.')
    expect(props.onRestore).not.toHaveBeenCalled()
    await act(async () => button('Restore this version').click())
    expect(props.onRestore).toHaveBeenCalledOnce()
    expect(props.onRestore).toHaveBeenCalledWith(older)
  })

  it('browses with arrow keys and returns to the current manuscript without creating a version', async () => {
    await render()
    const currentButton = container.querySelector<HTMLButtonElement>('[data-history-select="current"]')!
    await act(async () => currentButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })))
    expect(document.activeElement).toBe(container.querySelector('[data-history-select="older"]'))
    expect(container.querySelector('[data-history-select="older"]')?.getAttribute('aria-pressed')).toBe('true')
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })))
    expect(container.querySelector('[aria-label="Read-only manuscript preview"]')?.textContent).toContain('The first saved draft.')
    await select('current')
    expect(container.querySelector('[aria-label="Read-only manuscript preview"]')?.textContent).toContain('Current manuscript text.')
    expect(button('Restore this version')).toBeUndefined()
    await act(async () => button('Back to current manuscript').click())
    expect(props.onClose).toHaveBeenCalledOnce()
    expect(props.onRestore).not.toHaveBeenCalled()
    expect(props.onSaveVersion).not.toHaveBeenCalled()
  })

  it('offers escaped source and a selected-to-current comparison, with keyboard tab navigation', async () => {
    await render()
    await select('older')
    const previewTab = button('Preview')
    await act(async () => previewTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })))
    expect(button('Changes').getAttribute('aria-selected')).toBe('true')
    expect(container.querySelector('[role="tabpanel"]')?.textContent).toContain('Earlier')
    await act(async () => button('Source').click())
    expect(container.querySelector('[aria-label="Version source"]')?.textContent).toBe(older.source)
    expect(container.querySelectorAll('textarea, [contenteditable]')).toHaveLength(0)
    expect(props.onRestore).not.toHaveBeenCalled()
    expect(props.onSaveVersion).not.toHaveBeenCalled()
  })

  it('loads only the selected archived version and ignores a response arriving after another selection', async () => {
    const first = deferred<RecoverySnapshot>(), second = deferred<RecoverySnapshot>()
    const loadSnapshot = vi.fn((version: RecoveryHistoryVersion) => version.id === older.id ? first.promise : second.promise)
    await render({ ...props, snapshots: [metadata(older), metadata(oldest)], loadSnapshot, onTagVersion: vi.fn() })
    expect(loadSnapshot).not.toHaveBeenCalled()
    await select('older')
    expect(loadSnapshot).toHaveBeenCalledTimes(1)
    expect(button('Restore this version').disabled).toBe(true)
    expect(button('Name & keep version').disabled).toBe(true)
    expect(container.querySelector('[role="tabpanel"]')?.textContent).toContain('Loading this version')
    await select('oldest')
    expect(loadSnapshot).toHaveBeenCalledTimes(2)
    await act(async () => second.resolve(oldest))
    expect(button('Name & keep version').disabled).toBe(false)
    expect(container.querySelector('[aria-label="Read-only manuscript preview"]')?.textContent).toContain('The first saved draft.')
    await act(async () => first.resolve(older))
    expect(container.querySelector('[aria-label="Read-only manuscript preview"]')?.textContent).not.toContain('Earlier manuscript text.')
    expect(container.querySelector('[data-history-select="oldest"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(props.onRestore).not.toHaveBeenCalled()
    expect(props.onSaveVersion).not.toHaveBeenCalled()
  })

  it('refuses an unverified payload and retries loading without writing history', async () => {
    const loadSnapshot = vi.fn().mockResolvedValueOnce(oldest).mockResolvedValueOnce(older)
    await render({ ...props, snapshots: [metadata(older)], loadSnapshot })
    await select('older')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('could not be verified')
    expect(button('Restore this version').disabled).toBe(true)
    await act(async () => button('Retry loading version').click())
    expect(container.querySelector('[aria-label="Read-only manuscript preview"]')?.textContent).toContain('Earlier manuscript text.')
    expect(loadSnapshot).toHaveBeenCalledTimes(2)
    expect(props.onRestore).not.toHaveBeenCalled()
    expect(props.onSaveVersion).not.toHaveBeenCalled()
  })

  it('traps keyboard focus, closes on Escape, and restores focus to the original trigger', async () => {
    const trigger = document.body.appendChild(document.createElement('button'))
    trigger.focus()
    await render()
    const first = button('Save version'), last = button('Back to current manuscript')
    last.focus()
    await act(async () => last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })))
    expect(document.activeElement).toBe(first)
    await act(async () => first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })))
    expect(document.activeElement).toBe(last)
    await act(async () => last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(props.onClose).toHaveBeenCalledOnce()
    await act(async () => root.render(null))
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })

  it('disables destructive and navigation controls while a restoration is preserving the current draft', async () => {
    await render()
    await select('older')
    await render({ ...props, busy: true })
    expect(container.querySelector<HTMLButtonElement>('.recovery-restore-version')?.disabled).toBe(true)
    expect(button('Back to current manuscript').disabled).toBe(true)
    expect(button('Save version').disabled).toBe(true)
    expect([...container.querySelectorAll<HTMLButtonElement>('[data-history-select]')].every((element) => element.disabled)).toBe(true)
  })

  it('names the selected saved text without restoring it, saving the current draft, or moving the preview', async () => {
    const onTagVersion = vi.fn(), onSaveNamedVersion = vi.fn()
    await render({ ...props, onTagVersion, onSaveNamedVersion })
    await select('older')
    await act(async () => button('Name & keep version').click())
    expect(container.querySelector('form')?.getAttribute('aria-label')).toBe('Name selected version')
    expect(container.querySelector('form')?.textContent).toContain('does not restore it')
    const input = await name('  Ready for co-authors  ')
    expect(document.activeElement).toBe(input)
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    expect(onTagVersion).toHaveBeenCalledExactlyOnceWith(older, 'Ready for co-authors')
    expect(props.onRestore).not.toHaveBeenCalled()
    expect(props.onSaveVersion).not.toHaveBeenCalled()
    expect(onSaveNamedVersion).not.toHaveBeenCalled()
    expect(container.querySelector('form')).toBeNull()
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Your working manuscript is unchanged.')
    const kept = { ...older, id: 'named-event', kind: 'manual' as const, label: 'Ready for co-authors' }
    await render({ ...props, snapshots: [kept, older, oldest] })
    expect(container.querySelector('[data-history-select="older"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector('[data-history-select="named-event"]')?.textContent).toContain('Named · kept')
    expect(container.querySelector('[aria-label="Read-only manuscript preview"]')?.textContent).toContain('Earlier manuscript text.')
  })

  it('keeps the naming form and saved text available when protection fails, then supports retry', async () => {
    const onTagVersion = vi.fn().mockRejectedValueOnce(new Error('The archive is full. No existing version was deleted.')).mockResolvedValueOnce(undefined)
    await render({ ...props, onTagVersion })
    await select('older')
    await act(async () => button('Name & keep version').click())
    await name('Before revisions')
    await act(async () => button('Keep named version').click())
    expect(container.querySelector('form')).not.toBeNull()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('archive is full')
    expect(container.querySelector<HTMLInputElement>('form input')?.value).toBe('Before revisions')
    expect(container.querySelector('[aria-label="Read-only manuscript preview"]')?.textContent).toContain('Earlier manuscript text.')
    expect(props.onRestore).not.toHaveBeenCalled()
    await act(async () => button('Keep named version').click())
    expect(onTagVersion).toHaveBeenCalledTimes(2)
    expect(container.querySelector('form')).toBeNull()
  })

  it('guards naming against duplicate submission and navigation until the saved version is protected', async () => {
    const pending = deferred<void>(), onTagVersion = vi.fn(() => pending.promise)
    await render({ ...props, onTagVersion })
    await select('older')
    await act(async () => button('Name & keep version').click())
    const input = await name('Keep this result')
    await act(async () => {
      container.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      container.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(onTagVersion).toHaveBeenCalledOnce()
    expect(input.disabled).toBe(true)
    expect(button('Back to current manuscript').disabled).toBe(true)
    expect(button('Restore this version')).toBeUndefined()
    expect([...container.querySelectorAll<HTMLButtonElement>('[data-history-select]')].every((element) => element.disabled)).toBe(true)
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(props.onClose).not.toHaveBeenCalled()
    expect(container.querySelector('form')).not.toBeNull()
    await act(async () => pending.resolve())
    expect(container.querySelector('form')).toBeNull()
    expect(button('Restore this version').disabled).toBe(false)
  })

  it('validates names and saves the current working version separately from a historical preview', async () => {
    const onTagVersion = vi.fn(), onSaveNamedVersion = vi.fn()
    await render({ ...props, onTagVersion, onSaveNamedVersion })
    await select('older')
    await act(async () => button('Name current version').click())
    expect(container.querySelector('form')?.getAttribute('aria-label')).toBe('Name current version')
    await name('   ')
    await act(async () => button('Keep named version').click())
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('1 to 160 characters')
    expect(onSaveNamedVersion).not.toHaveBeenCalled()
    const input = await name('Current milestone')
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })))
    expect(onSaveNamedVersion).not.toHaveBeenCalled()
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    expect(onSaveNamedVersion).toHaveBeenCalledExactlyOnceWith('Current milestone')
    expect(onTagVersion).not.toHaveBeenCalled()
    expect(props.onRestore).not.toHaveBeenCalled()
    expect(container.querySelector('[data-history-select="older"]')?.getAttribute('aria-pressed')).toBe('true')
  })

  it('cancels naming with Escape while leaving history open and returns focus to the naming action', async () => {
    const onTagVersion = vi.fn()
    await render({ ...props, onTagVersion })
    await select('older')
    const action = button('Name & keep version')
    await act(async () => action.click())
    const input = await name('A draft name')
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(container.querySelector('form')).toBeNull()
    expect(document.activeElement).toBe(action)
    expect(props.onClose).not.toHaveBeenCalled()
    expect(onTagVersion).not.toHaveBeenCalled()
    expect(container.querySelector('[data-history-select="older"]')?.getAttribute('aria-pressed')).toBe('true')
  })
})
