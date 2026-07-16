import { describe, expect, it } from 'vitest'
import type { KeyValueStorage } from './storage'
import { DEFAULT_USER_SETTINGS, USER_SETTINGS_KEY, authorInitials, readUserSettings, renameLocalAuthor, saveUserSettings } from './userSettings'

function storage(initial?: string): KeyValueStorage {
  const values = new Map<string, string>(initial === undefined ? [] : [[USER_SETTINGS_KEY, initial]])
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
}

describe('local author settings', () => {
  it('defaults safely when persisted identity is absent or malformed', () => {
    expect(readUserSettings(storage())).toEqual(DEFAULT_USER_SETTINGS)
    expect(readUserSettings(storage('{broken'))).toEqual(DEFAULT_USER_SETTINGS)
    expect(readUserSettings(storage('{"schemaVersion":1,"author":{"id":"../../bad","name":"Bad"}}'))).toEqual(DEFAULT_USER_SETTINGS)
  })

  it('keeps the identity for a cosmetic no-op and allocates a new one for a rename', () => {
    const unchanged = renameLocalAuthor(DEFAULT_USER_SETTINGS, '  Remi   Vezy  ', () => 'unused-id')
    expect(unchanged).toBe(DEFAULT_USER_SETTINGS)

    const renamed = renameLocalAuthor(DEFAULT_USER_SETTINGS, ' Zoé   Dupont ', () => '12345678-abcd')
    expect(renamed).toEqual({ schemaVersion: 1, author: { id: 'dm-author-12345678-abcd', name: 'Zoé Dupont' } })
    expect(DEFAULT_USER_SETTINGS.author).toEqual({ id: 'dm-local-author', name: 'Remi Vezy' })
  })

  it('round-trips the current identity and derives quiet initials', () => {
    const memory = storage()
    const settings = renameLocalAuthor(DEFAULT_USER_SETTINGS, 'Zoé Dupont', () => '12345678-abcd')
    saveUserSettings(memory, settings)
    expect(readUserSettings(memory)).toEqual(settings)
    expect(authorInitials(settings.author.name)).toBe('ZD')
  })

  it('rejects empty, control-bearing, oversized, and invalid generated identities', () => {
    expect(() => renameLocalAuthor(DEFAULT_USER_SETTINGS, '  ')).toThrow('review name')
    expect(() => renameLocalAuthor(DEFAULT_USER_SETTINGS, 'Bad\nName')).toThrow('review name')
    expect(() => renameLocalAuthor(DEFAULT_USER_SETTINGS, 'a'.repeat(241))).toThrow('review name')
    expect(() => renameLocalAuthor(DEFAULT_USER_SETTINGS, 'Alice Martin', () => 'short')).toThrow('identity generator')
  })
})
