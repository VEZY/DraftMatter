import type { KeyValueStorage } from './storage'

export const USER_SETTINGS_KEY = 'draftmatter.user-settings.v1'

export interface LocalAuthorIdentity {
  id: string
  name: string
}

export interface UserSettings {
  schemaVersion: 1
  author: LocalAuthorIdentity
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  schemaVersion: 1,
  author: { id: 'dm-local-author', name: 'Remi Vezy' },
}

const portableAuthorId = /^dm-(?:local-author|author-[A-Za-z0-9-]{8,})$/

function normalizedName(value: string) {
  return value.trim().replace(/\s+/g, ' ')
}

function validName(value: string) {
  const bytes = new TextEncoder().encode(value).byteLength
  return Boolean(value) && bytes <= 240 && !/[\u0000-\u001f\u007f]/.test(value)
}

export function readUserSettings(storage: KeyValueStorage): UserSettings {
  try {
    const parsed = JSON.parse(storage.getItem(USER_SETTINGS_KEY) ?? 'null') as Partial<UserSettings> | null
    const rawName = parsed?.author?.name ?? ''
    if (/[\u0000-\u001f\u007f]/.test(rawName)) return structuredClone(DEFAULT_USER_SETTINGS)
    const name = normalizedName(rawName)
    const id = parsed?.author?.id ?? ''
    if (parsed?.schemaVersion !== 1 || !portableAuthorId.test(id) || !validName(name)) return structuredClone(DEFAULT_USER_SETTINGS)
    return { schemaVersion: 1, author: { id, name } }
  } catch {
    return structuredClone(DEFAULT_USER_SETTINGS)
  }
}

function generatedAuthorId(idFactory: () => string) {
  const token = idFactory().replace(/[^A-Za-z0-9-]/g, '')
  if (token.length < 8) throw new Error('The local author identity generator returned an invalid identifier.')
  return `dm-author-${token}`
}

export function renameLocalAuthor(
  settings: UserSettings,
  name: string,
  idFactory: () => string = () => globalThis.crypto.randomUUID(),
): UserSettings {
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error('Your review name must contain between 1 and 240 UTF-8 bytes without control characters.')
  const normalized = normalizedName(name)
  if (!validName(normalized)) throw new Error('Your review name must contain between 1 and 240 UTF-8 bytes without control characters.')
  if (normalized === settings.author.name) return settings
  return { schemaVersion: 1, author: { id: generatedAuthorId(idFactory), name: normalized } }
}

export function saveUserSettings(storage: KeyValueStorage, settings: UserSettings) {
  storage.setItem(USER_SETTINGS_KEY, JSON.stringify(settings))
}

export function authorInitials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toLocaleUpperCase()).join('') || 'A'
}
