import { useEffect, useRef, useState } from 'react'
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type PDFDocumentLoadingTask, type RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import { PdfPreviewDataFactory } from './pdfPreviewResources'

GlobalWorkerOptions.workerSrc = workerUrl
const MAX_CANVAS_PIXELS = 16_000_000
const MAX_CANVAS_EDGE = 8192
const MAX_PDF_BYTES = 32 * 1024 * 1024
const errorMessage = (error: unknown) => error instanceof Error && error.name === 'PasswordException'
  ? 'This PDF is password protected. Open it in your PDF reader to view it.'
  : 'This PDF could not be displayed. It may be damaged or use an unsupported format.'

export default function PdfFilePreview({ path, bytes, truncated }: { path: string; bytes: Uint8Array; truncated: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [page, setPage] = useState(1)
  const [zoom, setZoom] = useState(0)
  const [width, setWidth] = useState(800)
  const [loading, setLoading] = useState(true)
  const [rendering, setRendering] = useState(false)
  const [problem, setProblem] = useState('')

  useEffect(() => {
    setPdf(null); setPage(1); setProblem(''); setLoading(true)
    if (truncated || bytes.byteLength > MAX_PDF_BYTES) {
      setProblem('This PDF exceeds the 32 MB preview limit. Open the complete file in your PDF reader.'); setLoading(false); return
    }
    if (!new TextDecoder('latin1').decode(bytes.subarray(0, 1024)).includes('%PDF-')) {
      setProblem('The file contents do not match the PDF file type.'); setLoading(false); return
    }
    let cancelled = false
    let task: PDFDocumentLoadingTask | undefined
    try {
      task = getDocument({
        // PDF.js transfers ownership of this buffer to the worker. Preserve the tab's bytes for downloads.
        data: Uint8Array.from(bytes),
        BinaryDataFactory: PdfPreviewDataFactory,
        useWorkerFetch: false,
        useSystemFonts: false,
        enableXfa: false,
        disableWorkerRendering: true,
        maxImageSize: MAX_CANVAS_PIXELS,
        canvasMaxAreaInBytes: MAX_CANVAS_PIXELS * 4,
        disableAutoFetch: true,
        disableStream: true,
        disableRange: true,
        verbosity: 0,
      })
      void task.promise.then((document) => { if (!cancelled) { setPdf(document); setLoading(false) } }, (error: unknown) => {
        if (!cancelled) { setProblem(errorMessage(error)); setLoading(false) }
      })
    } catch (error) { setProblem(errorMessage(error)); setLoading(false) }
    return () => { cancelled = true; void task?.destroy().catch(() => {}) }
  }, [bytes, truncated, path])

  useEffect(() => {
    const element = host.current
    if (!element) return
    const measure = () => setWidth(Math.max(160, element.clientWidth - 48))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const element = host.current
    if (!pdf || !element) return
    let cancelled = false
    let task: RenderTask | undefined
    const canvas = document.createElement('canvas')
    canvas.setAttribute('role', 'img')
    canvas.setAttribute('aria-label', `PDF page ${page} of ${pdf.numPages}`)
    setRendering(true); setProblem('')
    // A fresh canvas prevents an old asynchronous render from painting a newly selected page.
    element.replaceChildren(canvas)
    element.scrollTop = 0
    void pdf.getPage(page).then(async (pdfPage) => {
      if (cancelled) return
      const natural = pdfPage.getViewport({ scale: 1 })
      const desiredScale = zoom ? zoom / 100 : Math.min(2, width / natural.width)
      const scale = Math.min(desiredScale, MAX_CANVAS_EDGE / natural.width, MAX_CANVAS_EDGE / natural.height, Math.sqrt(MAX_CANVAS_PIXELS / (natural.width * natural.height)))
      const viewport = pdfPage.getViewport({ scale })
      if (!(viewport.width > 0 && viewport.height > 0 && Number.isFinite(viewport.width + viewport.height))) throw new Error('Invalid page size')
      const density = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)), MAX_CANVAS_EDGE / viewport.width, MAX_CANVAS_EDGE / viewport.height)
      canvas.width = Math.max(1, Math.floor(viewport.width * density))
      canvas.height = Math.max(1, Math.floor(viewport.height * density))
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`
      task = pdfPage.render({ canvas, viewport, transform: density === 1 ? undefined : [density, 0, 0, density, 0, 0] })
      try { await task.promise } finally { pdfPage.cleanup() }
      if (!cancelled) { canvas.dataset.rendered = 'true'; setRendering(false) }
    }).catch((error: unknown) => { if (!cancelled) { setProblem(errorMessage(error)); setRendering(false) } })
    return () => { cancelled = true; task?.cancel(); canvas.remove(); canvas.width = 0; canvas.height = 0 }
  }, [pdf, page, zoom, width])

  return <section className="file-pdf-preview" aria-label="PDF preview">
    <div className="file-preview-toolbar file-pdf-toolbar">
      <button type="button" aria-label="Previous PDF page" disabled={!pdf || page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</button>
      <label>Page <input type="number" aria-label="PDF page" value={page} min={1} max={pdf?.numPages ?? 1} disabled={!pdf} onChange={(event) => {
        const value = event.currentTarget.valueAsNumber
        if (Number.isFinite(value)) setPage(Math.max(1, Math.min(pdf?.numPages ?? 1, Math.trunc(value))))
      }} /></label><span>of {pdf?.numPages ?? '…'}</span>
      <button type="button" aria-label="Next PDF page" disabled={!pdf || page >= pdf.numPages} onClick={() => setPage((value) => value + 1)}>Next</button>
      <label>Zoom <select aria-label="PDF zoom" value={zoom} disabled={!pdf} onChange={(event) => setZoom(Number(event.target.value))}>
        <option value={0}>Fit width</option><option value={50}>50%</option><option value={100}>100%</option><option value={150}>150%</option><option value={200}>200%</option>
      </select></label>
    </div>
    {loading && <p className="file-preview-unavailable" role="status">Loading PDF…</p>}
    {problem && <p className="file-preview-problem" role="alert">{problem}</p>}
    {pdf && !problem && <p className="file-pdf-status" role="status">{rendering ? 'Rendering page…' : `Page ${page} of ${pdf.numPages}`}</p>}
    <div ref={host} className="file-pdf-canvas" aria-busy={loading || rendering} hidden={!pdf || Boolean(problem)} />
  </section>
}
