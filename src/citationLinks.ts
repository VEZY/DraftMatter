export type CitationLinkKind = 'doi' | 'record-url' | 'zotero-item'

export interface CitationLinkRequest {
  kind: CitationLinkKind
  value: string
}

function normalizedDoi(value: string) {
  const doi = value.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').toLowerCase()
  const [registrant, suffix] = doi.split('/', 2)
  if (!registrant || !suffix || !/^10\.\d{4,9}$/.test(registrant) || /\s/.test(suffix) || doi.length > 512) {
    throw new Error('This citation does not contain a valid DOI link.')
  }
  return doi
}

function normalizedRecordUrl(value: string) {
  const raw = value.trim()
  if (!raw || raw.length > 2_048 || /[\u0000-\u001f\u007f\\]/.test(raw)) {
    throw new Error('This citation source URL is not safe to open.')
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('This citation source URL is not valid.')
  }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error('Citation source links must use HTTP or HTTPS without embedded credentials.')
  }
  return url.toString()
}

function normalizedZoteroItemKey(value: string) {
  const itemKey = value.trim()
  if (!/^[A-Za-z0-9]{1,64}$/.test(itemKey)) throw new Error('This citation does not contain a valid Zotero item identity.')
  return itemKey
}

export function citationLinkUrl(request: CitationLinkRequest) {
  if (request.kind === 'doi') return `https://doi.org/${encodeURIComponent(normalizedDoi(request.value))}`
  if (request.kind === 'record-url') return normalizedRecordUrl(request.value)
  return `zotero://select/library/items/${normalizedZoteroItemKey(request.value)}`
}
