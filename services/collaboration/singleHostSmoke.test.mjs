import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertMissingPkceRejected, smokeSettings } from '../../scripts/smoke-single-host.mjs'

const environment = () => ({
  DM_SINGLE_HOST_MODE: 'rehearsal',
  BIND_ADDRESS: '127.0.0.1',
  APP_HOST: 'app.draftmatter.localhost',
  COLLABORATION_HOST: 'sync.draftmatter.localhost',
  AUTH_HOST: 'auth.draftmatter.localhost',
  HTTPS_PORT: '8443',
  COMPOSE_PROJECT_NAME: 'draftmatter-rehearsal-local',
  REHEARSAL_ALICE_PASSWORD: 'fake-private-test-password-alice',
  REHEARSAL_BOB_PASSWORD: 'fake-private-test-password-bob',
  REHEARSAL_EVE_PASSWORD: 'fake-private-test-password-eve',
})

describe('real OAuth missing-PKCE rejection', () => {
  const origin = 'https://app.draftmatter.localhost:8443'
  const state = 'private-browser-state'
  const callback = () => new URL(`${origin}/smoke-auth-callback?error=invalid_request&state=${state}`)
  const response = (url) => ({ status: 302, headers: { location: url.toString() } })

  it('accepts a direct HTTP rejection or an invalid_request redirect to the exact approved callback', () => {
    expect(() => assertMissingPkceRejected({ status: 400 }, origin, state)).not.toThrow()
    expect(() => assertMissingPkceRejected(response(callback()), origin, state)).not.toThrow()
  })

  it('rejects a redirect to another origin, callback path, state, or error', () => {
    for (const alter of [
      (url) => { url.hostname = 'attacker.invalid' },
      (url) => { url.pathname = '/other-callback' },
      (url) => { url.searchParams.set('state', 'different-state') },
      (url) => { url.searchParams.delete('error') },
      (url) => { url.searchParams.set('error', 'access_denied') },
      (url) => { url.hash = 'access_token=unsafe' },
    ]) {
      const url = callback()
      alter(url)
      expect(() => assertMissingPkceRejected(response(url), origin, state)).toThrow()
    }
  })

  it('rejects authorization codes or tokens even when an error is also present', () => {
    for (const name of ['code', 'access_token', 'id_token', 'refresh_token']) {
      const url = callback()
      url.searchParams.set(name, 'unexpected-issued-credential')
      expect(() => assertMissingPkceRejected(response(url), origin, state)).toThrow(/must not issue/)
    }
    expect(() => assertMissingPkceRejected({ status: 200 }, origin, state)).toThrow(/must be rejected/)
  })
})

describe('isolated single-host smoke safety', () => {
  it('uses one local TLS port consistently for app, identity and WebSocket requests', () => {
    const directory = resolve('/tmp/draftmatter-rehearsal')
    const settings = smokeSettings(environment(), join(directory, 'runtime.env'))
    expect(settings.appOrigin).toBe('https://app.draftmatter.localhost:8443')
    expect(settings.issuer).toBe('https://auth.draftmatter.localhost:8443/realms/draftmatter')
    expect(settings.websocketUrl).toBe('wss://sync.draftmatter.localhost:8443')
    expect(settings.reportFile).toBe(join(directory, 'rehearsal-report.json'))
  })

  it.each(['APP_HOST', 'COLLABORATION_HOST', 'AUTH_HOST'])('refuses fixture account provisioning against a public %s', (name) => {
    expect(() => smokeSettings({ ...environment(), [name]: 'draftmatter.fr' }, '/tmp/runtime.env')).toThrow(/isolated/)
    expect(() => smokeSettings({ ...environment(), [name]: 'app.draftmatter.localhost.attacker.fr' }, '/tmp/runtime.env')).toThrow(/isolated/)
    expect(() => smokeSettings({ ...environment(), [name]: 'http://app.draftmatter.localhost' }, '/tmp/runtime.env')).toThrow(/isolated/)
  })

  it.each(['443', '0', '65536', '8443/path', 'NaN', '8444'])('refuses a public, invalid or injected HTTPS port %s', (HTTPS_PORT) => {
    expect(() => smokeSettings({ ...environment(), HTTPS_PORT }, '/tmp/runtime.env')).toThrow(/HTTPS_PORT/)
  })

  it('requires distinct local hosts and explicit compose ownership', () => {
    expect(() => smokeSettings({ ...environment(), AUTH_HOST: environment().APP_HOST }, '/tmp/runtime.env')).toThrow(/differ/)
    expect(() => smokeSettings({ ...environment(), COMPOSE_PROJECT_NAME: '' }, '/tmp/runtime.env')).toThrow(/COMPOSE_PROJECT_NAME/)
    expect(() => smokeSettings({ ...environment(), COMPOSE_PROJECT_NAME: 'rehearsal;echo injected' }, '/tmp/runtime.env')).toThrow(/COMPOSE_PROJECT_NAME/)
    expect(() => smokeSettings({ ...environment(), COMPOSE_PROJECT_NAME: 'draftmatter-alpha-production' }, '/tmp/runtime.env')).toThrow(/COMPOSE_PROJECT_NAME/)
    expect(() => smokeSettings({ ...environment(), DM_SINGLE_HOST_MODE: 'production' }, '/tmp/runtime.env')).toThrow(/DM_SINGLE_HOST_MODE/)
    expect(() => smokeSettings({ ...environment(), BIND_ADDRESS: '0.0.0.0' }, '/tmp/runtime.env')).toThrow(/BIND_ADDRESS/)
  })

  it('requires independently supplied private fixture passwords without repeating them in errors', () => {
    for (const name of ['ALICE', 'BOB', 'EVE']) {
      const shortPassword = `short-${name}`
      try {
        smokeSettings({ ...environment(), [`REHEARSAL_${name}_PASSWORD`]: shortPassword }, '/tmp/runtime.env')
        throw new Error('Expected invalid fixture credentials to be rejected')
      } catch (error) {
        expect(error.message).toContain(`REHEARSAL_${name}_PASSWORD`)
        expect(error.message).not.toContain(shortPassword)
      }
    }
  })
})
