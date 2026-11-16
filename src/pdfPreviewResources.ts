// Vite emits these dependencies as local assets. PDF contents cannot choose a URL.
const maps = import.meta.glob<string>('/node_modules/pdfjs-dist/cmaps/*.bcmap', { query: '?url', import: 'default', eager: true })
const fonts = import.meta.glob<string>('/node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}', { query: '?url', import: 'default', eager: true })
const wasm = import.meta.glob<string>('/node_modules/pdfjs-dist/wasm/{openjpeg,jbig2,qcms_bg}.wasm', { query: '?url', import: 'default', eager: true })
const resources: Record<string, Record<string, string>> = Object.fromEntries(
  Object.entries({ cMapUrl: maps, standardFontDataUrl: fonts, wasmUrl: wasm }).map(([kind, files]) => [kind,
    Object.fromEntries(Object.entries(files).map(([path, url]) => [path.split('/').at(-1)!, url])),
  ]),
)

/** Only renderer assets bundled with DraftMatter can be requested by a PDF worker. */
export class PdfPreviewDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const group = Object.hasOwn(resources, kind) ? resources[kind] : undefined
    const url = group && Object.hasOwn(group, filename) ? group[filename] : undefined
    if (!url) throw new Error('This PDF requested an unsupported rendering resource.')
    const response = await fetch(url, { credentials: 'same-origin' })
    if (!response.ok) throw new Error('A local PDF rendering resource could not be loaded.')
    return new Uint8Array(await response.arrayBuffer())
  }
}
