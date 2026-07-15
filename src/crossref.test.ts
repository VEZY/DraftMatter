import { describe, expect, it, vi } from 'vitest'
import { CrossrefSearchSession, CrossrefTransportError, crossrefRequest, parseCrossrefQuery, rankCrossrefWorks, type CrossrefTransport, type CrossrefWork } from './crossref'

const dynacof: CrossrefWork = {
  doi: '10.1016/j.envsoft.2019.104609',
  title: 'DynACof: A process-based model to study growth, yield and ecosystem services of coffee agroforestry systems',
  authors: [{ family: 'Vezy', given: 'Rémi' }, { family: 'Le Maire', given: 'Guillaume' }],
  year: 2020,
  container: 'Environmental Modelling & Software',
  type: 'journal-article',
  url: 'https://doi.org/10.1016/j.envsoft.2019.104609',
  providerScore: 12,
}

const distractor: CrossrefWork = {
  doi: '10.1000/other',
  title: 'Coffee systems and field observations',
  authors: [{ family: 'Other' }],
  year: 2020,
  type: 'journal-article',
  providerScore: 80,
}

describe('Crossref scholarly search', () => {
  it('parses exact DOI and high-confidence citation-shaped queries', () => {
    expect(parseCrossrefQuery('https://doi.org/10.1016/j.envsoft.2019.104609')).toMatchObject({ doi: '10.1016/j.envsoft.2019.104609', structured: true })
    const parsed = parseCrossrefQuery('vezy et al. 2020 DynACof')
    expect(parsed).toMatchObject({ author: 'vezy', year: 2020, title: 'DynACof', structured: true })
    expect(crossrefRequest(parsed)).toEqual(expect.objectContaining({
      kind: 'works',
      author: 'vezy',
      title: 'DynACof',
      fromPublicationDate: '2020-01-01',
      untilPublicationDate: '2020-12-31',
      rows: 20,
    }))
    expect(crossrefRequest(parseCrossrefQuery('coffee agroforestry model'))).toEqual(expect.objectContaining({ kind: 'works', bibliographic: 'coffee agroforestry model' }))
  })

  it('ranks the gating DynACof DOI first despite a higher provider score elsewhere', () => {
    const ranked = rankCrossrefWorks(parseCrossrefQuery('vezy et al. 2020 DynACof'), [distractor, dynacof])
    expect(ranked.map((candidate) => candidate.doi)).toEqual(['10.1016/j.envsoft.2019.104609', '10.1000/other'])
    expect(ranked[0].localScore).toBeGreaterThan(ranked[1].localScore)
  })

  it('falls back once from an empty structured request to the unchanged bibliographic query', async () => {
    const calls: unknown[] = []
    const transport: CrossrefTransport = {
      search: vi.fn(async (request) => {
        calls.push(request)
        return calls.length === 1 ? [] : [dynacof]
      }),
    }
    const result = await new CrossrefSearchSession(transport).search('vezy et al. 2020 DynACof')

    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual(expect.objectContaining({ kind: 'works', bibliographic: 'vezy et al. 2020 DynACof' }))
    expect(result.candidates[0].doi).toBe(dynacof.doi)
  })

  it('caches successful normalized queries for the session', async () => {
    const transport = { search: vi.fn(async () => [dynacof]) }
    const session = new CrossrefSearchSession(transport)

    expect((await session.search('  coffee   model ')).fromCache).toBe(false)
    expect((await session.search('coffee model')).fromCache).toBe(true)
    expect(transport.search).toHaveBeenCalledTimes(1)
  })

  it('marks ignored stale responses and aborts superseded work', async () => {
    let releaseFirst: ((works: CrossrefWork[]) => void) | undefined
    const signals: AbortSignal[] = []
    const transport: CrossrefTransport = {
      search: (_request, signal) => {
        signals.push(signal)
        if (signals.length === 1) return new Promise((resolve) => { releaseFirst = resolve })
        return Promise.resolve([dynacof])
      },
    }
    const session = new CrossrefSearchSession(transport)
    const first = session.search('first query')
    const second = session.search('second query')
    releaseFirst?.([distractor])

    expect((await first).stale).toBe(true)
    expect((await second).candidates[0].doi).toBe(dynacof.doi)
    expect(signals[0].aborted).toBe(true)
  })

  it('degrades cleanly for empty, offline, and HTTP 429 paths', async () => {
    const empty = new CrossrefSearchSession({ search: async () => [] })
    expect((await empty.search('unfindable record')).diagnostics).toEqual([expect.objectContaining({ code: 'crossref-empty' })])

    const offline = new CrossrefSearchSession({ search: async () => { throw new CrossrefTransportError('offline', 'offline') } })
    expect((await offline.search('query')).diagnostics).toEqual([expect.objectContaining({ code: 'crossref-offline', level: 'info' })])

    const limited = new CrossrefSearchSession({ search: async () => { throw new CrossrefTransportError('rate-limit', 'slow down', 4_000) } })
    expect((await limited.search('query')).diagnostics).toEqual([expect.objectContaining({ code: 'crossref-rate-limit', message: expect.stringContaining('4 seconds') })])
  })
})
