import { afterEach, describe, expect, it, vi } from 'vitest'
import { initializePublicRuntimeConfiguration, publicRuntimeEnvironment } from './publicRuntimeConfiguration'
import { publicConfigurationFromEnvironment, serializePublicRuntimeConfiguration, validatePublicRuntimeConfiguration } from './publicConfigurationModel.mjs'

const environment = {
  DM_PUBLIC_COLLABORATION_URL: 'https://sync.draftmatter.eu',
  DM_LEGAL_PUBLISHER_NAME: 'Rémi Vezy',
  DM_LEGAL_CONTACT_EMAIL: 'contact@draftmatter.eu',
  DM_LEGAL_HOSTING_DETAILS: 'SAS PulseHeberg, Toulon, France.',
  DM_LEGAL_DATA_LOCATION: 'Hosted in France by a French company.',
  DM_LEGAL_ADDITIONAL_PROCESSORS: 'OVHcloud, for contact email delivery.',
}
const payload = () => publicConfigurationFromEnvironment(environment)
afterEach(() => { delete globalThis.__DRAFTMATTER_PUBLIC_ENVIRONMENT__; vi.resetModules() })

describe('public runtime configuration boundary', () => {
  it('exports only the six public fields, never service secrets or arbitrary Vite settings', () => {
    const config = publicConfigurationFromEnvironment({ ...environment, DM_DATABASE_URL: 'private-database-secret', DM_OBJECT_SECRET_KEY: 'private-object-secret', VITE_UNEXPECTED: 'private-build-secret' })
    const json = serializePublicRuntimeConfiguration(config)
    expect(json).not.toMatch(/private-|DM_DATABASE_URL|DM_OBJECT_SECRET_KEY|VITE_UNEXPECTED/)
    expect(Object.keys(config.environment)).toHaveLength(6)
    expect(Object.isFrozen(config.environment)).toBe(true)
    expect(() => validatePublicRuntimeConfiguration({ ...config, password: 'private' })).toThrow('schema')
    expect(() => validatePublicRuntimeConfiguration({ ...config, environment: { ...config.environment, DM_OBJECT_SECRET_KEY: 'private' } })).toThrow('schema')
  })

  it.each(['http://sync.draftmatter.eu', 'https://user:private@sync.draftmatter.eu', 'https://sync.draftmatter.eu?token=private', 'https://sync.draftmatter.eu/#private'])('rejects an unsafe public service URL (%s)', (url) => {
    expect(() => publicConfigurationFromEnvironment({ ...environment, DM_PUBLIC_COLLABORATION_URL: url })).toThrow(/HTTPS/)
  })

  it('fails closed for missing settings, placeholders, wrong schema, invalid email and excessive text', () => {
    expect(() => publicConfigurationFromEnvironment({})).toThrow('Complete')
    expect(() => publicConfigurationFromEnvironment({ ...environment, DM_LEGAL_HOSTING_DETAILS: 'REPLACE_HOST' })).toThrow('placeholder')
    expect(() => publicConfigurationFromEnvironment({ ...environment, DM_LEGAL_CONTACT_EMAIL: 'bad\naddress' })).toThrow('contact email')
    expect(() => publicConfigurationFromEnvironment({ ...environment, DM_LEGAL_DATA_LOCATION: 'x'.repeat(4001) })).toThrow('Complete')
    expect(() => validatePublicRuntimeConfiguration({ ...payload(), schemaVersion: 2 })).toThrow('schema')
  })

  it('safely serializes unicode and script-like text as inert JSON', () => {
    const content = 'Rémi — </script><script>alert("é")</script> & \u2028 line \u2029 text'
    const config = publicConfigurationFromEnvironment({ ...environment, DM_LEGAL_HOSTING_DETAILS: content })
    const json = serializePublicRuntimeConfiguration(config)
    expect(json).not.toContain('<script>')
    expect(json).not.toContain('</script>')
    expect(JSON.parse(json).environment.VITE_DM_LEGAL_HOSTING_DETAILS).toBe(content)
  })

  it('leaves desktop and ordinary browser builds independent of a runtime fetch', async () => {
    const request = vi.fn()
    await initializePublicRuntimeConfiguration(false, request)
    expect(request).not.toHaveBeenCalled()
    expect(publicRuntimeEnvironment()).toBeUndefined()
  })

  it('loads no-store JSON without credentials before legal configuration is imported', async () => {
    const request = vi.fn().mockResolvedValue(Response.json(payload()))
    await initializePublicRuntimeConfiguration(true, request)
    expect(request).toHaveBeenCalledExactlyOnceWith('/draftmatter-public-config.json', expect.objectContaining({ cache: 'no-store', credentials: 'omit', redirect: 'error' }))
    expect(publicRuntimeEnvironment()?.VITE_DRAFTMATTER_COLLABORATION_URL).toBe(environment.DM_PUBLIC_COLLABORATION_URL)
    const { legalConfiguration } = await import('./legalConfig')
    expect(legalConfiguration).toMatchObject({ ready: true, contactEmail: 'contact@draftmatter.eu', hostingDetails: environment.DM_LEGAL_HOSTING_DETAILS })
  })

  it('rejects missing/HTML/error responses and clears any prior runtime state', async () => {
    await initializePublicRuntimeConfiguration(true, vi.fn().mockResolvedValue(Response.json(payload())))
    await expect(initializePublicRuntimeConfiguration(true, vi.fn().mockResolvedValue(new Response('<html>SPA fallback</html>', { headers: { 'content-type': 'text/html' } })))).rejects.toThrow('unavailable')
    expect(publicRuntimeEnvironment()).toBeUndefined()
    await expect(initializePublicRuntimeConfiguration(true, vi.fn().mockResolvedValue(Response.json(payload(), { status: 404 })))).rejects.toThrow('unavailable')
    await expect(initializePublicRuntimeConfiguration(true, vi.fn().mockResolvedValue(new Response('invalid', { headers: { 'content-type': 'application/json' } })))).rejects.toThrow('invalid JSON')
  })

  it('stops an oversized response while reading, even without Content-Length', async () => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(128 * 1024 + 1)) }, cancel }), { headers: { 'content-type': 'application/json' } })
    await expect(initializePublicRuntimeConfiguration(true, vi.fn().mockResolvedValue(response))).rejects.toThrow('size limit')
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(publicRuntimeEnvironment()).toBeUndefined()
  })
})
