import { describe, expect, it, vi } from 'vitest'
import { CrossrefSearchSession, CrossrefTransportError, crossrefCandidateToCitationRecord, crossrefDuplicateCitekeys, crossrefRequest, parseCrossrefQuery, rankCrossrefWorks, type CrossrefTransport, type CrossrefWork } from './crossref'

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

  it('turns a selected provider candidate into a portable, collision-safe citation record', () => {
    const existing = [{ ...crossrefCandidateToCitationRecord(dynacof), citekey: 'vezy2020dynacof' }]
    const record = crossrefCandidateToCitationRecord(dynacof, existing)

    expect(record).toMatchObject({
      citekey: 'vezy2020dynacof2',
      source: 'crossref',
      type: 'article',
      doi: dynacof.doi,
      provenance: { origin: 'online-search' },
    })
    expect(record.cslData).toMatchObject({ type: 'article-journal', DOI: dynacof.doi })
    expect(crossrefDuplicateCitekeys(dynacof, existing)).toEqual(['vezy2020dynacof'])
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

  it('can explicitly cancel an in-flight picker search', async () => {
    let release: ((works: CrossrefWork[]) => void) | undefined
    let signal: AbortSignal | undefined
    const session = new CrossrefSearchSession({
      search: (_request, nextSignal) => {
        signal = nextSignal
        return new Promise((resolve) => { release = resolve })
      },
    })
    const pending = session.search('coffee model')
    session.cancel()
    release?.([dynacof])

    expect(signal?.aborted).toBe(true)
    expect((await pending).stale).toBe(true)
  })

  it('degrades cleanly for empty, offline, and HTTP 429 paths', async () => {
    const empty = new CrossrefSearchSession({ search: async () => [] })
    expect((await empty.search('unfindable record')).diagnostics).toEqual([expect.objectContaining({ code: 'crossref-empty' })])

    const offline = new CrossrefSearchSession({ search: async () => { throw new CrossrefTransportError('offline', 'offline') } })
    expect((await offline.search('query')).diagnostics).toEqual([expect.objectContaining({ code: 'crossref-offline', level: 'info' })])

    const limited = new CrossrefSearchSession({ search: async () => { throw new CrossrefTransportError('rate-limit', 'slow down', 4_000) } })
    expect((await limited.search('query')).diagnostics).toEqual([expect.objectContaining({ code: 'crossref-rate-limit', message: expect.stringContaining('4 seconds') })])
  })

  it('backs off exponentially after provider throttling while still serving cached queries', async () => {
    let now = 1_000
    const search = vi.fn()
      .mockRejectedValueOnce(new CrossrefTransportError('rate-limit', 'slow down', 2_000))
      .mockRejectedValueOnce(new CrossrefTransportError('http', 'server error', 1_000))
      .mockResolvedValue([dynacof])
    const session = new CrossrefSearchSession({ search }, 32, () => now)

    expect((await session.search('first')).diagnostics[0].code).toBe('crossref-rate-limit')
    expect((await session.search('second')).diagnostics[0].code).toBe('crossref-backoff')
    expect(search).toHaveBeenCalledTimes(1)
    now += 2_001
    expect((await session.search('second')).diagnostics[0].code).toBe('crossref-http')
    now += 2_001
    expect((await session.search('second')).candidates[0].doi).toBe(dynacof.doi)
    expect((await session.search('second')).fromCache).toBe(true)
    expect(search).toHaveBeenCalledTimes(3)
  })
})
