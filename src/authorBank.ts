import { normalizePublicationOrcid, type PublicationAuthor } from './publicationMetadata'

export const AUTHOR_BANK_KEY = 'draftmatter.author-bank.v1'

export interface RememberedAuthor extends PublicationAuthor {
  id: string
}

export interface AuthorBank {
  schemaVersion: 1
  authors: RememberedAuthor[]
}

export const EMPTY_AUTHOR_BANK: AuthorBank = { schemaVersion: 1, authors: [] }

function authorId() {
  return globalThis.crypto?.randomUUID?.() ?? `author-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function cleanAuthor(author: Partial<PublicationAuthor>, id: string = authorId()): RememberedAuthor {
  const name = author.name?.trim() ?? ''
  if (!name) throw new Error('Enter the author’s full name.')
  if (name.length > 240 || /[\r\n\0]/.test(name)) throw new Error('Author names must fit on one line and use at most 240 characters.')
  const orcid = normalizePublicationOrcid(author.orcid ?? '')
  const affiliations = [...new Set((author.affiliations ?? []).map((value) => value.trim()).filter(Boolean))]
  if (affiliations.length > 20) throw new Error('Use at most 20 affiliations for one author.')
  if (affiliations.some((value) => value.length > 300 || /[\r\n\0]/.test(value))) {
    throw new Error('Each affiliation must fit on one line and use at most 300 characters.')
  }
  return { id, name, ...(orcid ? { orcid } : {}), affiliations }
}

export function normalizeAuthorProfile(author: Partial<PublicationAuthor>) {
  const { id: _id, ...profile } = cleanAuthor(author)
  return profile
}

export function readAuthorBank(storage: Storage): AuthorBank {
  try {
    const parsed = JSON.parse(storage.getItem(AUTHOR_BANK_KEY) ?? 'null') as Partial<AuthorBank> | null
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.authors)) return EMPTY_AUTHOR_BANK
    const authors = parsed.authors.slice(0, 100).flatMap((author, index) => {
      if (!author || typeof author !== 'object') return []
      try {
        const candidate = author as Partial<RememberedAuthor>
        return [cleanAuthor(candidate, typeof candidate.id === 'string' && candidate.id ? candidate.id : `author-${index + 1}`)]
      } catch {
        return []
      }
    })
    return { schemaVersion: 1, authors }
  } catch {
    return EMPTY_AUTHOR_BANK
  }
}

export function saveAuthorBank(storage: Storage, bank: AuthorBank) {
  storage.setItem(AUTHOR_BANK_KEY, JSON.stringify(bank))
}

function authorKey(author: PublicationAuthor) {
  return author.orcid ? `orcid:${author.orcid.toUpperCase()}` : `name:${author.name.toLocaleLowerCase()}`
}

export function rememberAuthors(bank: AuthorBank, authors: Array<Partial<PublicationAuthor> & { id?: string }>): AuthorBank {
  const next = [...bank.authors]
  for (const author of authors) {
    const normalized = cleanAuthor(author, author.id || authorId())
    const existing = next.findIndex((candidate) => candidate.id === normalized.id || authorKey(candidate) === authorKey(normalized))
    if (existing >= 0) next[existing] = { ...normalized, id: next[existing].id }
    else if (next.length < 100) next.push(normalized)
  }
  return { schemaVersion: 1, authors: next }
}

export function forgetAuthor(bank: AuthorBank, id: string): AuthorBank {
  return { schemaVersion: 1, authors: bank.authors.filter((author) => author.id !== id) }
}
