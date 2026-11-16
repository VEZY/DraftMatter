export type ProjectPreviewKind = 'image' | 'pdf' | 'table' | 'markdown' | 'text' | 'unsupported'

export function projectPreviewKind(path: string): ProjectPreviewKind {
  const name = path.split('/').at(-1)?.toLowerCase() ?? ''
  if (/\.(?:png|jpe?g|gif|webp|svg)$/.test(name)) return 'image'
  if (/\.pdf$/.test(name)) return 'pdf'
  if (/\.(?:csv|tsv)$/.test(name)) return 'table'
  if (/\.(?:md|qmd|markdown)$/.test(name)) return 'markdown'
  if (/\.(?:py|r|jl|js|jsx|ts|tsx|json|toml|ya?ml|txt|log|bib|bibtex|ris|sh|bash|zsh|fish|c|cpp|cc|h|hpp|rs|css|scss|html?|xml|ini|cfg|conf|sql|tex|m|lock|ipynb)$/.test(name)
    || /^(?:\.gitignore|\.gitattributes|\.editorconfig|\.rprofile|\.python-version|\.renvignore|license|readme|makefile|dockerfile)$/.test(name)) return 'text'
  return 'unsupported'
}

/** A partial UTF-8 suffix is allowed only for a deliberately truncated prefix. */
export function previewText(bytes: Uint8Array, truncated = false): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes, { stream: truncated })
    return /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text) ? null : text
  } catch { return null }
}

export function previewImageMediaType(path: string, bytes: Uint8Array): string {
  const extension = path.split('.').at(-1)?.toLowerCase()
  if (extension === 'svg') return 'image/svg+xml'
  const ascii = (start: number, count: number) => String.fromCharCode(...bytes.subarray(start, start + count))
  if (extension === 'png' && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return 'image/png'
  if ((extension === 'jpg' || extension === 'jpeg') && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (extension === 'gif' && /^GIF8[79]a$/.test(ascii(0, 6))) return 'image/gif'
  if (extension === 'webp' && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp'
  throw new Error('The image contents do not match its file type.')
}

export interface TablePreview { headers: string[]; rows: string[][]; truncated: boolean }

/** Quoted delimiters and newlines are preserved; work and rendered cells stay bounded. */
export function parseTablePreview(source: string, delimiter: ',' | '\t', partial = false, maxRows = 500): TablePreview {
  const rows: string[][] = []
  let row: string[] = [], cell = '', quoted = false, truncated = partial
  const endCell = () => { row.push(cell); cell = ''; if (row.length > 100) truncated = true }
  const endRow = () => { endCell(); rows.push(row.slice(0, 100)); row = [] }
  let index = 0
  for (; index < source.length && rows.length < maxRows + 1; index++) {
    const character = source[index]
    if (character === '"') {
      if (quoted && source[index + 1] === '"') { if (cell.length < 10_000) cell += '"'; index++ }
      else if (quoted || !cell) quoted = !quoted
      else if (cell.length < 10_000) cell += character
    } else if (!quoted && character === delimiter) endCell()
    else if (!quoted && (character === '\n' || character === '\r')) {
      endRow()
      if (character === '\r' && source[index + 1] === '\n') index++
    } else if (cell.length < 10_000) cell += character
    else truncated = true
  }
  if (index < source.length) truncated = true
  if (!partial && index >= source.length && (cell || row.length)) endRow()
  if (quoted) truncated = true
  return { headers: rows.shift() ?? [], rows: rows.slice(0, maxRows), truncated }
}

const svgElements = new Set('svg g defs title desc path rect circle ellipse line polyline polygon text tspan linearGradient radialGradient stop clipPath mask pattern use'.split(' '))
const svgAttributes = new Set('xmlns viewBox width height x y x1 y1 x2 y2 cx cy r rx ry d points fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-dasharray opacity transform id class font-size font-family font-weight text-anchor dominant-baseline preserveAspectRatio gradientUnits gradientTransform offset stop-color stop-opacity clip-path mask patternUnits patternTransform href'.split(' '))

/** SVG is displayed as an image, never inserted as page HTML. No active or external content survives. */
export function sanitizePreviewSvg(source: string): string {
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('SVG declarations are not supported in the safe preview.')
  const document = new DOMParser().parseFromString(source, 'image/svg+xml')
  if (document.querySelector('parsererror') || document.documentElement.localName !== 'svg') throw new Error('This SVG could not be read.')
  for (const element of Array.from(document.querySelectorAll('*'))) {
    if (!svgElements.has(element.localName) || element.namespaceURI !== 'http://www.w3.org/2000/svg') { element.remove(); continue }
    for (const attribute of Array.from(element.attributes)) {
      const value = attribute.value.trim()
      if (!svgAttributes.has(attribute.name) || /[<>\\\u0000-\u001f]|(?:https?:|data:|javascript:|\/\/)/i.test(value)
        || (attribute.localName === 'href' && !/^#[\w.-]+$/.test(value))
        || (/url\s*\(/i.test(value) && !/^url\(\s*#[\w.-]+\s*\)$/.test(value))) element.removeAttribute(attribute.name)
    }
  }
  return new XMLSerializer().serializeToString(document.documentElement)
}
