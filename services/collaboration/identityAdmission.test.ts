import { describe, expect, it } from 'vitest'
import { IdentityAdmission, IDENTITY_ADMISSION_PATH } from './identityAdmission'

const token = '4'.repeat(64)
const HOUR = 60 * 60_000
const DAY = 24 * HOUR

function request(kind = 'registration', address = '192.0.2.1', overrides: Record<string, string> = {}) {
  return new Request(`http://collaboration:1234${IDENTITY_ADMISSION_PATH}?kind=${kind}`, {
    headers: { 'x-dm-identity-admission': token, 'x-dm-identity-ip': address, ...overrides },
  })
}

describe('private identity action admission', () => {
  it('closes registration independently of recovery and never accepts a missing or forged shared token', () => {
    const admission = new IdentityAdmission({ token, registrationEnabled: false })
    expect(admission.check(request())).toMatchObject({ allowed: false, status: 403, code: 'alpha_registration_closed' })
    expect(admission.check(request('account'))).toEqual({ allowed: true })
    for (const supplied of ['', 'wrong', '5'.repeat(64), token + '0']) {
      expect(admission.check(request('account', '192.0.2.1', { 'x-dm-identity-admission': supplied }))).toMatchObject({ allowed: false, status: 404 })
    }
  })

  it('rejects request bodies, cookies and bearer credentials without reading them', () => {
    const admission = new IdentityAdmission({ token, registrationEnabled: true })
    const forbiddenHeaders: Array<Record<string, string>> = [{ 'content-length': '1' }, { 'transfer-encoding': 'chunked' }, { cookie: 'identity=private' }, { authorization: 'Bearer private' }]
    for (const header of forbiddenHeaders) {
      expect(admission.check(request('registration', '192.0.2.1', header))).toMatchObject({ allowed: false, status: 400 })
    }
    const posted = new Request(request(), { method: 'POST', body: 'password=must-never-be-read' })
    expect(admission.check(posted)).toMatchObject({ allowed: false, status: 405 })
    expect(posted.bodyUsed).toBe(false)
    for (const url of [`${IDENTITY_ADMISSION_PATH}?kind=unknown`, `${IDENTITY_ADMISSION_PATH}?kind=registration&kind=account`, `${IDENTITY_ADMISSION_PATH}?kind=account&secret=private`]) {
      expect(admission.check(new Request(`http://collaboration:1234${url}`, { headers: request().headers }))).toMatchObject({ allowed: false, status: 400 })
    }
  })

  it('enforces a rolling hourly address budget with a useful retry deadline', () => {
    let now = DAY
    const admission = new IdentityAdmission({ token, registrationEnabled: true, clock: () => now, policies: { registration: { perAddressHour: 2, globalDay: 10 } } })
    expect(admission.check(request())).toEqual({ allowed: true })
    now += 10_000
    expect(admission.check(request())).toEqual({ allowed: true })
    expect(admission.check(request())).toMatchObject({ allowed: false, status: 429, retryAfterSeconds: 3590 })
    expect(admission.check(request('registration', '192.0.2.2'))).toEqual({ allowed: true })
    now += HOUR - 10_000
    expect(admission.check(request())).toEqual({ allowed: true })
  })

  it('cannot bypass daily global limits by rotating IPs and keeps password recovery independent', () => {
    let now = DAY
    const admission = new IdentityAdmission({ token, registrationEnabled: true, clock: () => now, policies: {
      registration: { perAddressHour: 20, globalDay: 2 }, account: { perAddressHour: 20, globalDay: 3 },
    } })
    expect(admission.check(request('registration', '192.0.2.1'))).toEqual({ allowed: true })
    now += 1_000
    expect(admission.check(request('registration', '192.0.2.2'))).toEqual({ allowed: true })
    expect(admission.check(request('registration', '192.0.2.3'))).toMatchObject({ allowed: false, status: 429, retryAfterSeconds: 86399 })
    for (let index = 1; index <= 3; index++) expect(admission.check(request('account', `192.0.2.${index}`))).toEqual({ allowed: true })
    expect(admission.check(request('account', '192.0.2.4'))).toMatchObject({ allowed: false, status: 429 })
    now += DAY - 1_000
    expect(admission.check(request('registration', '192.0.2.3'))).toEqual({ allowed: true })
  })

  it('fails closed when the bounded address map is full, then releases expired addresses', () => {
    let now = DAY
    const admission = new IdentityAdmission({ token, registrationEnabled: true, clock: () => now, maxAddresses: 2 })
    expect(admission.check(request('registration', '192.0.2.1'))).toEqual({ allowed: true })
    expect(admission.check(request('registration', '192.0.2.2'))).toEqual({ allowed: true })
    expect(admission.check(request('registration', '192.0.2.3'))).toMatchObject({ allowed: false, status: 429, retryAfterSeconds: 3600 })
    now += HOUR
    expect(admission.check(request('registration', '192.0.2.3'))).toEqual({ allowed: true })
  })

  it('normalizes IPv6 aliases and IPv4-mapped IPv6 without trusting forwarded address lists', () => {
    const admission = new IdentityAdmission({ token, registrationEnabled: true, policies: { registration: { perAddressHour: 1, globalDay: 100 } } })
    expect(admission.check(request('registration', '2001:db8::1'))).toEqual({ allowed: true })
    expect(admission.check(request('registration', '2001:0db8:0:0:0:0:0:1'))).toMatchObject({ allowed: false, status: 429 })
    expect(admission.check(request('registration', '192.0.2.1'))).toEqual({ allowed: true })
    expect(admission.check(request('registration', '::ffff:192.0.2.1'))).toMatchObject({ allowed: false, status: 429 })
    for (const value of ['', 'not-an-address', '192.0.2.1, 192.0.2.2', 'https://192.0.2.1', 'fe80::1%lo0']) {
      expect(admission.check(request('registration', value))).toMatchObject({ allowed: false, status: 400 })
    }
  })

  it('requires strong private configuration and bounded budgets', () => {
    for (const supplied of ['', 'a'.repeat(32), 'g'.repeat(64), token + '\n']) expect(() => new IdentityAdmission({ token: supplied, registrationEnabled: true })).toThrow(/hexadecimal/)
    expect(() => new IdentityAdmission({ token, registrationEnabled: true, maxAddresses: 0 })).toThrow(/bounded/)
    expect(() => new IdentityAdmission({ token, registrationEnabled: true, policies: { registration: { perAddressHour: 1, globalDay: 100_000 } } })).toThrow(/bounded/)
  })
})
