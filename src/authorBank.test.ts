// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import { AUTHOR_BANK_KEY, EMPTY_AUTHOR_BANK, forgetAuthor, readAuthorBank, rememberAuthors, saveAuthorBank } from './authorBank'

describe('remembered publication authors', () => {
  beforeEach(() => localStorage.clear())

  it('ignores malformed local data', () => {
    localStorage.setItem(AUTHOR_BANK_KEY, '{broken')
    expect(readAuthorBank(localStorage)).toEqual(EMPTY_AUTHOR_BANK)
  })

  it('persists authors and updates a matching ORCID instead of duplicating it', () => {
    const first = rememberAuthors(EMPTY_AUTHOR_BANK, [{
      id: 'alice',
      name: ' Alice Martin ',
      orcid: 'https://orcid.org/0000-0002-1825-0097',
      affiliations: ['Institute A', 'Institute A'],
    }])
    const updated = rememberAuthors(first, [{
      name: 'Alice M. Martin',
      orcid: '0000-0002-1825-0097',
      affiliations: ['Institute B'],
    }])
    saveAuthorBank(localStorage, updated)

    expect(readAuthorBank(localStorage).authors).toEqual([{
      id: 'alice',
      name: 'Alice M. Martin',
      orcid: '0000-0002-1825-0097',
      affiliations: ['Institute B'],
    }])
  })

  it('removes one saved author without affecting the others', () => {
    const bank = rememberAuthors(EMPTY_AUTHOR_BANK, [
      { id: 'alice', name: 'Alice Martin', affiliations: [] },
      { id: 'bob', name: 'Bob Chen', affiliations: [] },
    ])
    expect(forgetAuthor(bank, 'alice').authors.map((author) => author.name)).toEqual(['Bob Chen'])
  })
})
