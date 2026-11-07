import { describe, expect, it, vi } from 'vitest'
import { readBrowserPublicationAssets } from './browserPublicationAssets'

describe('browser publication figures', () => {
  it('embeds images already served by the current project without cookies or following redirects', async () => {
    const request = vi.fn<typeof fetch>(async () => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }))
    const assets = await readBrowserPublicationAssets(['figures/plot.svg'], 'https://draft.example.test/paper', request)
    expect(new TextDecoder().decode(assets[0].bytes)).toBe('<svg/>')
    expect(request).toHaveBeenCalledWith('https://draft.example.test/figures/plot.svg', { credentials: 'omit', redirect: 'error' })
  })
  it('rejects traversal, unavailable assets and oversized responses before collecting bytes', async () => {
    const request = vi.fn<typeof fetch>(async () => new Response('large', { headers: { 'content-type': 'image/png', 'content-length': String(21 * 1024 * 1024) } }))
    await expect(readBrowserPublicationAssets(['../private.svg'], 'https://draft.example.test/paper', request)).rejects.toThrow(/inside the project/)
    expect(request).not.toHaveBeenCalled()
    await expect(readBrowserPublicationAssets(['plot.png'], 'https://draft.example.test/paper', request)).rejects.toThrow(/20 MB/)
    await expect(readBrowserPublicationAssets(['plot.png'], 'https://draft.example.test/paper', async () => new Response('login', { headers: { 'content-type': 'text/html' } }))).rejects.toThrow(/unavailable/)
  })
})
