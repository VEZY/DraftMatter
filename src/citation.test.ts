import { describe, expect, it } from 'vitest'
import { normalizeCitationItems, parseCitationCluster, serializeCitationCluster } from './citation'

describe('semantic citation clusters', () => {
  it('parses multiple Pandoc citations with prefixes and locators', () => {
    expect(parseCitationCluster('[see @vezy2024, pp. 18–21; also @martin2023]')).toEqual([
      { citekey: 'vezy2024', prefix: 'see', locator: 'pp. 18–21' },
      { citekey: 'martin2023', prefix: 'also' },
    ])
  })

  it('serializes author suppression, locators, and suffixes deterministically', () => {
    const items = [
      { citekey: 'vezy2024', prefix: 'compare', locator: 'p. 18', suffix: 'emphasis added', suppressAuthor: true },
      { citekey: 'martin2023', suffix: 'supporting data' },
    ]
    const source = '[compare -@vezy2024, p. 18, emphasis added; @martin2023, supporting data]'

    expect(serializeCitationCluster(items)).toBe(source)
    expect(parseCitationCluster(source)).toEqual(items)
  })

  it('falls back to valid legacy citekeys and drops unreadable item data', () => {
    expect(normalizeCitationItems([{ citekey: ' valid ', prefix: ' see ' }, null, { citekey: 'bad key' }], ['legacy'])).toEqual([
      { citekey: 'valid', prefix: 'see' },
    ])
    expect(normalizeCitationItems(undefined, ['vezy2024', 'bad key'])).toEqual([{ citekey: 'vezy2024' }])
  })
})
