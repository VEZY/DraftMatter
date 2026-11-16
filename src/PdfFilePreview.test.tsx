// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const { load, options } = vi.hoisted(() => ({ load: vi.fn(), options: { workerSrc: '' } }))
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ getDocument: load, GlobalWorkerOptions: options }))
import PdfFilePreview from './PdfFilePreview'

describe('PDF file preview', () => {
  let container: HTMLDivElement, root: ReturnType<typeof createRoot>
  const bytes = new TextEncoder().encode('%PDF-1.7\nfixture')
  const destroy = vi.fn(async () => {})
  const cancel = vi.fn()
  const render = vi.fn(() => ({ promise: Promise.resolve(), cancel }))
  const getPage = vi.fn(async () => ({ getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }), render, cleanup: vi.fn() }))
  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    load.mockReturnValue({ promise: Promise.resolve({ numPages: 3, getPage }), destroy })
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  })
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks() })
  const button = (label: string) => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!

  it('renders and navigates PDF pages with copied bytes, bundled resources and no active layers', async () => {
    await act(async () => root.render(<PdfFilePreview path="references/article.pdf" bytes={bytes} truncated={false} />))
    expect(load).toHaveBeenCalledTimes(1)
    const settings = load.mock.calls[0][0]
    expect(settings.data).not.toBe(bytes)
    expect([...settings.data]).toEqual([...bytes])
    expect(settings).toMatchObject({ useWorkerFetch: false, enableXfa: false, maxImageSize: 16_000_000, disableWorkerRendering: true, disableAutoFetch: true, disableRange: true, disableStream: true })
    expect(settings.url).toBeUndefined()
    expect(settings.BinaryDataFactory).toBeTypeOf('function')
    expect(options.workerSrc).toContain('pdf.worker.min.mjs')
    expect(container.querySelector('canvas')?.getAttribute('aria-label')).toBe('PDF page 1 of 3')
    expect(container.querySelector('canvas')?.dataset.rendered).toBe('true')
    expect(button('Previous PDF page').disabled).toBe(true)
    await act(async () => button('Next PDF page').click())
    expect(container.querySelectorAll('canvas')).toHaveLength(1)
    expect(container.querySelector('canvas')?.getAttribute('aria-label')).toBe('PDF page 2 of 3')
    expect(cancel).toHaveBeenCalled()
    expect(container.querySelector('iframe, object, embed, a, script, .cm-editor')).toBeNull()
    expect(bytes.length).toBeGreaterThan(0)
  })

  it('destroys replaced and unmounted document workers under StrictMode', async () => {
    await act(async () => root.render(<StrictMode><PdfFilePreview path="article.pdf" bytes={bytes} truncated={false} /></StrictMode>))
    expect(load).toHaveBeenCalledTimes(2)
    expect(destroy).toHaveBeenCalledTimes(1)
    await act(async () => root.render(<p>Closed</p>))
    expect(destroy).toHaveBeenCalledTimes(2)
    expect(container.querySelector('canvas')).toBeNull()
  })

  it('bounds canvas allocation even for oversized PDF page dimensions', async () => {
    getPage.mockResolvedValueOnce({ getViewport: ({ scale }: { scale: number }) => ({ width: 1_000_000 * scale, height: 2_000_000 * scale }), render, cleanup: vi.fn() })
    await act(async () => root.render(<PdfFilePreview path="oversized-page.pdf" bytes={bytes} truncated={false} />))
    const canvas = container.querySelector('canvas')!
    expect(canvas.dataset.rendered).toBe('true')
    expect(canvas.width).toBeLessThanOrEqual(8192)
    expect(canvas.height).toBeLessThanOrEqual(8192)
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(16_000_000)
    expect(parseFloat(canvas.style.height)).toBeLessThanOrEqual(8192)
  })

  it('rejects incomplete, oversized and wrongly named PDF contents without starting a worker', async () => {
    await act(async () => root.render(<PdfFilePreview path="article.pdf" bytes={bytes} truncated />))
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('32 MB preview limit')
    await act(async () => root.render(<PdfFilePreview path="article.pdf" bytes={new Uint8Array(32 * 1024 * 1024 + 1)} truncated={false} />))
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('32 MB preview limit')
    await act(async () => root.render(<PdfFilePreview path="article.pdf" bytes={new TextEncoder().encode('<html>not PDF</html>')} truncated={false} />))
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('do not match')
    expect(load).not.toHaveBeenCalled()
  })

  it('explains corrupt or protected PDFs while releasing the failed loading task', async () => {
    load.mockReturnValueOnce({ promise: Promise.reject(new Error('Invalid PDF')), destroy })
    await act(async () => root.render(<PdfFilePreview path="broken.pdf" bytes={bytes} truncated={false} />))
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('could not be displayed')
    load.mockReturnValueOnce({ promise: Promise.reject(Object.assign(new Error('Password required'), { name: 'PasswordException' })), destroy })
    await act(async () => root.render(<PdfFilePreview path="protected.pdf" bytes={bytes} truncated={false} />))
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('password protected')
    expect(destroy).toHaveBeenCalledTimes(1)
  })
})
