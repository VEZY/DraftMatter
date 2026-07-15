import type { ZoteroItem, ZoteroSearchResult, ZoteroStatus } from './desktopHost'
import type { CitationRecord, DocumentDiagnostic } from './types'

export interface ZoteroTransport {
  status: () => Promise<ZoteroStatus>
  search: (query: string, limit: number) => Promise<ZoteroSearchResult>
}

export interface ZoteroVersionStamp {
  zoteroVersion?: string
  apiVersion?: string
  schemaVersion?: string
  libraryVersion?: string
}

export interface ZoteroQueryResult {
  available: boolean
  records: CitationRecord[]
  diagnostics: DocumentDiagnostic[]
  version: ZoteroVersionStamp
}

function creatorName(creator: ZoteroItem['creators'][number]) {
  if (creator.name?.trim()) return creator.name.trim()
  return [creator.firstName, creator.lastName].filter(Boolean).join(' ').trim()
}

function citationKey(item: ZoteroItem) {
  const explicit = item.citationKey?.trim()
    || item.extra?.match(/(?:^|\n)Citation Key:\s*([^\s]+)/i)?.[1]
  if (explicit && /^[a-zA-Z0-9_:.+-]+$/.test(explicit)) return explicit
  return `zotero-${item.itemKey.toLowerCase()}`
}

function publicationYear(date?: string) {
  return date?.match(/\b(?:1[5-9]\d{2}|20\d{2}|21\d{2})\b/)?.[0]
}

export function zoteroItemToCitation(item: ZoteroItem, libraryVersion?: string): CitationRecord {
  const authors = item.creators
    .filter((creator) => creator.creatorType === 'author' || creator.creatorType === 'editor')
    .map(creatorName)
    .filter(Boolean)
  return {
    citekey: citationKey(item),
    type: item.itemType || 'document',
    title: item.title.trim() || 'Untitled Zotero item',
    authors,
    year: publicationYear(item.date),
    container: item.publicationTitle?.trim() || undefined,
    doi: item.doi?.trim() || undefined,
    url: item.url?.trim() || undefined,
    source: 'zotero',
    provenance: { origin: 'zotero-local', locator: item.itemKey },
    sourceIdentity: {
      provider: 'zotero',
      itemKey: item.itemKey,
      itemVersion: item.version,
      libraryVersion,
    },
  }
}

function changedVersion(previous: ZoteroVersionStamp | undefined, current: ZoteroVersionStamp) {
  if (!previous) return []
  return (['zoteroVersion', 'apiVersion', 'schemaVersion'] as const)
    .filter((key) => previous[key] && current[key] && previous[key] !== current[key])
    .map((key) => `${key}: ${previous[key]} → ${current[key]}`)
}

export async function queryZoteroLibrary(
  transport: ZoteroTransport,
  query: string,
  previousVersion?: ZoteroVersionStamp,
  limit = 25,
): Promise<ZoteroQueryResult> {
  let status: ZoteroStatus
  try {
    status = await transport.status()
  } catch (error) {
    return {
      available: false,
      records: [],
      diagnostics: [{
        code: 'zotero-unavailable',
        level: 'info',
        message: `Zotero is unavailable; cached and project sources remain searchable. ${error instanceof Error ? error.message : String(error)}`,
      }],
      version: previousVersion ?? {},
    }
  }

  const statusVersion: ZoteroVersionStamp = {
    zoteroVersion: status.zoteroVersion,
    apiVersion: status.apiVersion,
    schemaVersion: status.schemaVersion,
  }
  if (!status.available) {
    return {
      available: false,
      records: [],
      diagnostics: [{
        code: 'zotero-unavailable',
        level: 'info',
        message: status.message || 'Zotero is closed or its local API is disabled; cached and project sources remain searchable.',
      }],
      version: statusVersion,
    }
  }

  try {
    const result = await transport.search(query, Math.min(50, Math.max(1, limit)))
    const version: ZoteroVersionStamp = {
      ...statusVersion,
      apiVersion: result.apiVersion ?? statusVersion.apiVersion,
      schemaVersion: result.schemaVersion ?? statusVersion.schemaVersion,
      libraryVersion: result.libraryVersion,
    }
    const changes = changedVersion(previousVersion, version)
    return {
      available: true,
      records: result.items.map((item) => zoteroItemToCitation(item, result.libraryVersion)),
      diagnostics: changes.length ? [{
        code: 'zotero-version-changed',
        level: 'warning',
        message: `Zotero's local data contract changed (${changes.join(', ')}). Results were refreshed; cited records remain cached by item identity.`,
      }] : [],
      version,
    }
  } catch (error) {
    return {
      available: false,
      records: [],
      diagnostics: [{
        code: 'zotero-search-unavailable',
        level: 'warning',
        message: `Zotero became unavailable during search; cached and project sources remain usable. ${error instanceof Error ? error.message : String(error)}`,
      }],
      version: statusVersion,
    }
  }
}
