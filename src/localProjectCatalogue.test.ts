import { describe, expect, it } from 'vitest'
import {
  forgetLocalProject,
  readLocalProjectRecents,
  rememberLocalProject,
} from './localProjectCatalogue'
import type { ProjectSnapshot } from './desktopHost'

function project(root: string, name: string): ProjectSnapshot {
  return {
    root,
    config: {
      schemaVersion: 1,
      name,
      mainDocument: 'paper.qmd',
      citationStyle: 'draftmatter-author-date',
      citationLocale: 'en-US',
    },
    documents: [],
    bibliographies: [],
  }
}

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  }
}

describe('desktop Home project catalogue', () => {
  it('deduplicates portable local projects and orders them by real open time', () => {
    const storage = memoryStorage()
    rememberLocalProject(storage, project('/projects/one', 'One'), '2026-07-20T10:00:00.000Z')
    rememberLocalProject(storage, project('/projects/two', 'Two'), '2026-07-21T10:00:00.000Z')
    rememberLocalProject(storage, project('/projects/one', 'One renamed'), '2026-07-22T10:00:00.000Z')

    expect(readLocalProjectRecents(storage)).toEqual([
      {
        root: '/projects/one',
        name: 'One renamed',
        mainDocument: 'paper.qmd',
        lastOpenedAt: '2026-07-22T10:00:00.000Z',
      },
      expect.objectContaining({ root: '/projects/two', name: 'Two' }),
    ])
  })

  it('forgets only the unavailable folder and ignores malformed persisted entries', () => {
    const storage = memoryStorage()
    rememberLocalProject(storage, project('/projects/one', 'One'))
    rememberLocalProject(storage, project('/projects/two', 'Two'))
    expect(forgetLocalProject(storage, '/projects/one')).toEqual([expect.objectContaining({ root: '/projects/two' })])

    storage.setItem('draftmatter.local-project-catalogue.v1', '{"not":"a list"}')
    expect(readLocalProjectRecents(storage)).toEqual([])
  })
})
