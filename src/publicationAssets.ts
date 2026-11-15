import { normalizeProjectRelativePath } from './projectPaths'
import { projectComputationsForPublication } from './publicationComputation'
import { parseMarkdownImage } from './imageMarkdown'

export interface PublicationAsset {
  path: string
  bytes: Uint8Array
  mimeType?: string
  /** Raster fallback for Word versions that cannot display SVG. */
  fallbackPng?: Uint8Array
}

export interface PublicationAssetOptions {
  assets?: PublicationAsset[]
  /** Refuse missing/remote images rather than producing an incomplete document. */
  requireAssets?: boolean
}

export const MAX_PUBLICATION_ASSET_BYTES = 20 * 1024 * 1024
const MAX_PUBLICATION_ASSETS_BYTES = 100 * 1024 * 1024

export function publicationAssetPaths(source: string) {
  const paths = new Set<string>()
  for (const line of projectComputationsForPublication(source).split(/\r\n|[\r\n]/)) {
    const image = parseMarkdownImage(line)
    if (!image) continue
    const target = image.source
    if (/^(?:data:|https?:\/\/)/i.test(target)) continue
    const path = normalizeProjectRelativePath(target)
    if (!path) throw new Error(`Figure path must stay inside the project: ${target}.`)
    paths.add(path)
  }
  return [...paths]
}

export function validatePublicationAssets(assets: PublicationAsset[] = []) {
  let total = 0
  for (const asset of assets) {
    total += asset.bytes.byteLength + (asset.fallbackPng?.byteLength ?? 0)
    if (asset.bytes.byteLength > MAX_PUBLICATION_ASSET_BYTES || (asset.fallbackPng?.byteLength ?? 0) > MAX_PUBLICATION_ASSET_BYTES) {
      throw new Error(`Figure exceeds the 20 MB publication limit: ${asset.path}.`)
    }
  }
  if (total > MAX_PUBLICATION_ASSETS_BYTES) throw new Error('Publication figures exceed the combined 100 MB limit.')
}

export function publicationImageType(bytes: Uint8Array) {
  if (!bytes.length || bytes.byteLength > MAX_PUBLICATION_ASSET_BYTES) throw new Error('Publication images must contain between 1 byte and 20 MB.')
  if (bytes[0] === 0x89 && new TextDecoder().decode(bytes.slice(1, 8)) === 'PNG\r\n\x1a\n') return { mimeType: 'image/png', extension: 'png' }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mimeType: 'image/jpeg', extension: 'jpeg' }
  if (/^GIF8[79]a$/.test(new TextDecoder().decode(bytes.slice(0, 6)))) return { mimeType: 'image/gif', extension: 'gif' }
  if (bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP') return { mimeType: 'image/webp', extension: 'webp' }
  const text = new TextDecoder().decode(bytes)
  if (/^\s*(?:<\?xml[^>]*>\s*)?<svg(?:[\s>]|\/>)/i.test(text)) {
    if (/<!DOCTYPE|<!ENTITY|@import|<\s*(?:script|foreignObject|iframe|object|embed|animate\w*|set)\b|\bon[a-z]+\s*=|(?:href|src)\s*=\s*["'](?!#)|url\(\s*(?!#)/i.test(text)) {
      throw new Error('Publication SVG images must be inert and self-contained.')
    }
    return { mimeType: 'image/svg+xml', extension: 'svg' }
  }
  throw new Error('Publication figures must be PNG, JPEG, GIF, WebP, or inert SVG images.')
}

export function publicationBytesDataUrl(bytes: Uint8Array) {
  const { mimeType } = publicationImageType(bytes)
  let binary = ''
  for (let index = 0; index < bytes.length; index += 32_768) binary += String.fromCharCode(...bytes.subarray(index, index + 32_768))
  return `data:${mimeType};base64,${globalThis.btoa(binary)}`
}

export function embeddedPublicationImage(source: string): PublicationAsset | undefined {
  const match = source.match(/^data:image\/(?:png|jpeg|gif|webp|svg\+xml)(;base64)?,(.*)$/is)
  if (!match) return undefined
  if (match[2].length > MAX_PUBLICATION_ASSET_BYTES * 4) throw new Error('Embedded figure exceeds the publication size limit.')
  let bytes: Uint8Array
  try {
    bytes = match[1]
      ? Uint8Array.from(globalThis.atob(match[2]), (character) => character.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(match[2]))
  } catch { throw new Error('Embedded publication figure is not a valid data URL.') }
  publicationImageType(bytes)
  return { path: source, bytes }
}

export function resolvePublicationImage(source: string, options: PublicationAssetOptions): PublicationAsset | undefined {
  const embedded = embeddedPublicationImage(source)
  if (embedded) return options.assets?.find((candidate) => candidate.path === source) ?? embedded
  const path = normalizeProjectRelativePath(source)
  const asset = path ? options.assets?.find((candidate) => normalizeProjectRelativePath(candidate.path) === path) : undefined
  if (asset) {
    publicationImageType(asset.bytes)
    return asset
  }
  if (options.requireAssets) throw new Error(`Figure is unavailable for a complete export: ${source}. Include the image in the local project.`)
  return undefined
}

/** Read canvas dimensions without decoding pixels. RIFF/VP8X/VP8L layouts:
 * https://developers.google.com/speed/webp/docs/riff_container
 * VP8 key-frame dimensions: RFC 6386, section 9.1. */
function webpDimensions(bytes: Uint8Array) {
  const malformed = () => new Error('WebP figure has a malformed or incomplete image header.')
  if (bytes.length < 20) throw malformed()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const end = view.getUint32(4, true) + 8
  if (end < 20 || end > bytes.length || end % 2 !== 0) throw malformed()
  const uint24 = (offset: number) => bytes[offset] + bytes[offset + 1] * 256 + bytes[offset + 2] * 65536
  let offset = 12
  while (offset + 8 <= end) {
    const type = new TextDecoder().decode(bytes.subarray(offset, offset + 4))
    const size = view.getUint32(offset + 4, true)
    const payload = offset + 8
    const next = payload + size + (size % 2)
    if (next > end || (size % 2 && bytes[payload + size] !== 0)) throw malformed()
    if (type === 'VP8X') {
      if (size < 10) throw malformed()
      return { width: uint24(payload + 4) + 1, height: uint24(payload + 7) + 1 }
    }
    if (type === 'VP8 ') {
      if (size < 10 || (bytes[payload] & 1) !== 0 || bytes[payload + 3] !== 0x9d || bytes[payload + 4] !== 0x01 || bytes[payload + 5] !== 0x2a) throw malformed()
      return { width: view.getUint16(payload + 6, true) & 0x3fff, height: view.getUint16(payload + 8, true) & 0x3fff }
    }
    if (type === 'VP8L') {
      if (size < 5 || bytes[payload] !== 0x2f) throw malformed()
      const bits = view.getUint32(payload + 1, true)
      if (bits >>> 29 !== 0) throw malformed()
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
    }
    offset = next
  }
  throw malformed()
}

export function publicationImageDimensions(bytes: Uint8Array): { width: number; height: number } {
  const type = publicationImageType(bytes).extension
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let width = 640
  let height = 400
  if (type === 'png' && bytes.length >= 24) { width = view.getUint32(16); height = view.getUint32(20) }
  if (type === 'gif' && bytes.length >= 10) { width = view.getUint16(6, true); height = view.getUint16(8, true) }
  if (type === 'webp') ({ width, height } = webpDimensions(bytes))
  if (type === 'jpeg') {
    let offset = 2
    while (offset + 8 < bytes.length && bytes[offset] === 0xff) {
      const marker = bytes[offset + 1]
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        height = view.getUint16(offset + 5); width = view.getUint16(offset + 7); break
      }
      const length = view.getUint16(offset + 2)
      if (length < 2) break
      offset += length + 2
    }
  }
  if (type === 'svg') {
    const svg = new TextDecoder().decode(bytes)
    const box = svg.match(/\bviewBox\s*=\s*["']\s*[-+\d.eE]+[ ,]+[-+\d.eE]+[ ,]+([-+\d.eE]+)[ ,]+([-+\d.eE]+)/i)
    width = Number(box?.[1] ?? svg.match(/\bwidth\s*=\s*["']([\d.]+)/i)?.[1] ?? width)
    height = Number(box?.[2] ?? svg.match(/\bheight\s*=\s*["']([\d.]+)/i)?.[1] ?? height)
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width * height > 100_000_000) throw new Error('Figure dimensions exceed the publication image limit.')
  return { width, height }
}

/** Rasterize bounded in-memory SVG/WebP assets without fetching external resources. */
export async function preparePublicationAssetsForDocx(assets: PublicationAsset[], source?: string) {
  assets = [...assets]
  for (const line of (source ?? '').split(/\r\n|[\r\n]/)) {
    const image = parseMarkdownImage(line)
    const embedded = image && embeddedPublicationImage(image.source)
    if (embedded && !assets.some((asset) => asset.path === embedded.path)) assets.push(embedded)
  }
  validatePublicationAssets(assets)
  const prepared: PublicationAsset[] = []
  for (const asset of assets) {
    if (!['svg', 'webp'].includes(publicationImageType(asset.bytes).extension) || asset.fallbackPng) { prepared.push(asset); continue }
    if (typeof document === 'undefined') { prepared.push(asset); continue }
    const dimensions = publicationImageDimensions(asset.bytes)
    const scale = Math.min(2, 2400 / Math.max(dimensions.width, dimensions.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(dimensions.width * scale))
    canvas.height = Math.max(1, Math.round(dimensions.height * scale))
    const image = new Image()
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error(`Figure could not be decoded for Word: ${asset.path}.`))
      image.src = publicationBytesDataUrl(asset.bytes)
    })
    const context = canvas.getContext('2d')
    if (!context) throw new Error('The browser could not prepare publication figures for Word.')
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const png = embeddedPublicationImage(canvas.toDataURL('image/png'))
    if (!png) throw new Error(`Figure could not be prepared for Word: ${asset.path}.`)
    prepared.push({ ...asset, fallbackPng: png.bytes })
  }
  validatePublicationAssets(prepared)
  return prepared
}
