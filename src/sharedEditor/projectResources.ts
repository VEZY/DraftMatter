import type * as Y from 'yjs'
import type { CitationRecord } from '../types'
import { normalizeProjectRelativePath } from '../projectPaths'

export const PROJECT_RESOURCES_ROOT = 'draftmatter:resources'
export const MAX_PROJECT_RESOURCE_BYTES = 8 * 1024 * 1024
export const MAX_SHARED_IMAGE_BYTES = 2 * 1024 * 1024
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'])
const CITATION_SOURCES = new Set(['bibtex', 'csl-json', 'ris', 'endnote', 'zotero', 'crossref', 'sample'])

export interface SharedProjectImage { kind: 'image'; path: string; mimeType: string; base64: string }
export interface SharedProjectCitation { kind: 'citation'; record: CitationRecord }
export type SharedProjectResource = SharedProjectImage | SharedProjectCitation
export interface ProjectResources { images: SharedProjectImage[]; citations: CitationRecord[] }

export function bytesToBase64(bytes: Uint8Array) {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  return btoa(binary)
}

export function base64ToBytes(base64: string) {
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
}

export function sharedImage(path: string, bytes: Uint8Array): SharedProjectImage {
  const mimeType = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' } as Record<string, string>)[path.split('.').at(-1)?.toLowerCase() ?? '']
  const image: SharedProjectImage = { kind: 'image', path, mimeType, base64: bytesToBase64(bytes) }
  if (!validResource(`image:${path}`, image)) throw new Error(`The figure “${path}” cannot be shared. Use a supported image no larger than 2 MB inside the project.`)
  return image
}

function boundedJson(value: unknown, depth = 0): boolean {
  if (depth > 10) return false
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'string') return value.length <= 64 * 1024
  if (Array.isArray(value)) return value.length <= 2048 && value.every((item) => boundedJson(item, depth + 1))
  return typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    && Object.entries(value).length <= 256 && Object.entries(value).every(([key, item]) => !['__proto__', 'constructor', 'prototype'].includes(key) && boundedJson(item, depth + 1))
}

function validResource(key: string, value: unknown): value is SharedProjectResource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as SharedProjectResource
  if (item.kind === 'image') {
    if (typeof item.path !== 'string' || key !== `image:${item.path}` || normalizeProjectRelativePath(item.path) !== item.path
      || !IMAGE_TYPES.has(item.mimeType) || typeof item.base64 !== 'string' || !item.base64.length
      || item.base64.length > Math.ceil(MAX_SHARED_IMAGE_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.base64)) return false
    return Object.keys(item).every((name) => ['kind', 'path', 'mimeType', 'base64'].includes(name))
  }
  if (item.kind !== 'citation' || !item.record || !boundedJson(item.record)) return false
  const record = item.record
  return typeof record.citekey === 'string' && /^[a-zA-Z0-9_:.+-]{1,256}$/.test(record.citekey)
    && key === `citation:${record.citekey}` && typeof record.title === 'string' && typeof record.type === 'string'
    && Array.isArray(record.authors) && record.authors.every((name) => typeof name === 'string') && CITATION_SOURCES.has(record.source)
    && JSON.stringify(record).length <= 128 * 1024 && Object.keys(item).every((name) => ['kind', 'record'].includes(name))
}

/** The server calls this on the candidate document, before accepting any update. */
export function projectResourcesDiagnostic(document: Y.Doc): string | null {
  let bytes = 0
  const resources = document.getMap<unknown>(PROJECT_RESOURCES_ROOT)
  if (resources.size > 1024) return 'too-many-project-resources'
  for (const [key, value] of resources) {
    if (!validResource(key, value)) return 'invalid-project-resource'
    bytes += new TextEncoder().encode(JSON.stringify(value)).byteLength
    if (bytes > MAX_PROJECT_RESOURCE_BYTES) return 'project-resources-too-large'
  }
  return null
}

export function readProjectResources(document: Y.Doc): ProjectResources {
  const diagnostic = projectResourcesDiagnostic(document)
  if (diagnostic) throw new Error(`Shared project resources could not be read (${diagnostic}).`)
  const images: SharedProjectImage[] = []
  const citations: CitationRecord[] = []
  for (const value of document.getMap<SharedProjectResource>(PROJECT_RESOURCES_ROOT).values()) {
    if (value.kind === 'image') images.push(value)
    else citations.push(value.record)
  }
  return { images: images.sort((a, b) => a.path.localeCompare(b.path)), citations: citations.sort((a, b) => a.citekey.localeCompare(b.citekey)) }
}

/** Publish each keyed resource independently, retaining resources contributed by peers. */
export function publishProjectResources(document: Y.Doc, resources: ProjectResources) {
  const proposed = new Map<string, SharedProjectResource>()
  for (const image of resources.images) proposed.set(`image:${image.path}`, image)
  for (const record of resources.citations) proposed.set(`citation:${record.citekey}`, { kind: 'citation', record: JSON.parse(JSON.stringify(record)) as CitationRecord })
  for (const [key, value] of proposed) if (!validResource(key, value)) throw new Error('The project contains an unsupported shared resource.')
  const map = document.getMap<SharedProjectResource>(PROJECT_RESOURCES_ROOT)
  const combined = new Map([...map.entries(), ...proposed.entries()])
  if (combined.size > 1024 || [...combined.values()].reduce((total, value) => total + new TextEncoder().encode(JSON.stringify(value)).byteLength, 0) > MAX_PROJECT_RESOURCE_BYTES) {
    throw new Error('Shared figures and references exceed the 8 MB project limit. Reduce figure sizes before sharing.')
  }
  for (const [key, value] of proposed) {
    if (JSON.stringify(map.get(key)) !== JSON.stringify(value)) document.transact(() => map.set(key, value), 'draftmatter-project-resources')
  }
}
