import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseMailConfiguration, createAlphaMailer, keycloakSmtpConfiguration, readPrivateFile, emailAddress } from '../../deploy/single-host/keycloak/alpha-mail.mjs'
import { approveAlphaAccount, notificationReceipts, findAccount, assertApprovalIsPrivate, createIdentityAdmin, enableAlphaRegistration, verifyLiveApprovalGate } from '../../deploy/single-host/keycloak/alpha-admin.mjs'

const mailSource = 'DM_SMTP_HOST=smtp.mail.ovh.net\nDM_SMTP_PORT=465\nDM_SMTP_USER=contact@draftmatter.eu\nDM_SMTP_FROM=contact@draftmatter.eu\nDM_SMTP_PASSWORD="private-fixture-password"\n'
const appOrigin = 'https://app.draftmatter.eu'
const role = { id: 'alpha-role', name: 'draftmatter-alpha', composite: false, clientRole: false }

function fakeAdmin({ approved = false, verified = true, defaultApproval = false } = {}) {
  let granted = approved
  const admin = vi.fn(async (path, options = {}) => {
    if (path === '/admin/realms/draftmatter') return { defaultRole: { id: 'defaults' }, smtpServer: { host: 'smtp.mail.ovh.net', auth: 'true', ssl: 'true' } }
    if (path.endsWith('/roles-by-id/defaults/composites')) return defaultApproval ? [role] : []
    if (path.endsWith('/default-groups')) return []
    if (path.endsWith('/roles/draftmatter-alpha')) return role
    if (path.includes('/users?email=')) return [{ id: 'alice', email: 'alice@example.test', enabled: true, emailVerified: verified }]
    if (path.endsWith('/users/alice/role-mappings/realm/composite')) return granted ? [role] : []
    if (path.endsWith('/users/alice/role-mappings/realm') && options.method === 'POST') { granted = true; return null }
    throw new Error(`Unexpected mocked admin operation: ${path}`)
  })
  return { admin, granted: () => granted }
}

describe('private alpha SMTP delivery', () => {
  it('preserves punctuation and Unicode in a privately prompted password', () => {
    const password = 'Example\'"# $\\` é漢字'
    const source = mailSource.replace(/^DM_SMTP_PASSWORD=.*$/m, `DM_SMTP_PASSWORD_BASE64=${Buffer.from(password, 'utf8').toString('base64')}`)
    expect(parseMailConfiguration(source).password).toBe(password)
    expect(keycloakSmtpConfiguration(parseMailConfiguration(source)).password).toBe(password)
  })

  it.each(['not base64!', 'YQ', '/w==', 'Cg==', 'AA=='])('rejects malformed encoding or invalid password bytes (%s)', (encoded) => {
    const source = mailSource.replace(/^DM_SMTP_PASSWORD=.*$/m, `DM_SMTP_PASSWORD_BASE64=${encoded}`)
    expect(() => parseMailConfiguration(source)).toThrow(/private SMTP|private SMTP mailbox/)
  })

  it('rejects ambiguous raw and encoded passwords without printing either', () => {
    expect(() => parseMailConfiguration(`${mailSource}DM_SMTP_PASSWORD_BASE64=YQ==\n`)).toThrow('exactly one SMTP password field')
  })

  it('uses mandatory authenticated, certificate-verified TLS and safe transport options', async () => {
    const mail = parseMailConfiguration(mailSource)
    const verify = vi.fn(async () => true)
    const sendMail = vi.fn(async () => ({ accepted: ['alice@example.test'], rejected: [] }))
    const factory = vi.fn(() => ({ verify, sendMail, close: vi.fn() }))
    const mailer = createAlphaMailer(mail, factory)
    await mailer.verify()
    await expect(mailer.send({ email: 'alice@example.test', appOrigin })).resolves.toEqual({ accepted: true })
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ secure: true, requireTLS: true, logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true, tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2', servername: 'smtp.mail.ovh.net' } }))
    const message = sendMail.mock.calls[0][0]
    expect(message.text).toContain(`${appOrigin}/`)
    expect(message.text).not.toMatch(/token=|execute-actions|UPDATE_PASSWORD|private-fixture/)
    expect(message.subject).toBe('Your DraftMatter alpha invitation')
    expect(keycloakSmtpConfiguration(mail)).toMatchObject({ ssl: 'true', starttls: 'false', auth: 'true', port: '465' })
  })

  it('requires STARTTLS on port 587, with no plaintext fallback', () => {
    const mail = parseMailConfiguration(mailSource.replace('PORT=465', 'PORT=587'))
    const factory = vi.fn(() => ({}))
    createAlphaMailer(mail, factory)
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ secure: false, requireTLS: true }))
    expect(keycloakSmtpConfiguration(mail)).toMatchObject({ ssl: 'false', starttls: 'true' })
  })

  it.each(['25', '2525', '0', 'NaN'])('rejects an unencrypted or unsupported SMTP port %s', (port) => {
    expect(() => parseMailConfiguration(mailSource.replace('PORT=465', `PORT=${port}`))).toThrow('SMTP must use')
  })

  it('rejects header injection, non-mailbox senders and malformed invitation origins', async () => {
    expect(() => emailAddress('alice@example.test\r\nBcc: victim@example.test')).toThrow()
    expect(() => parseMailConfiguration(mailSource.replace('FROM=contact@draftmatter.eu', 'FROM=other@draftmatter.eu'))).toThrow('authenticated mailbox')
    const sendMail = vi.fn()
    const mailer = createAlphaMailer(parseMailConfiguration(mailSource), () => ({ sendMail }))
    for (const bad of ['http://app.draftmatter.eu', 'https://app.draftmatter.eu/path', 'https://user:password@app.draftmatter.eu']) await expect(mailer.send({ email: 'alice@example.test', appOrigin: bad })).rejects.toThrow()
    expect(sendMail).not.toHaveBeenCalled()
  })

  it('does not expose SMTP credentials/replies through thrown errors', async () => {
    const unsafe = new Error('AUTH failed private-fixture-password and full SMTP server response')
    const mailer = createAlphaMailer(parseMailConfiguration(mailSource), () => ({ verify: async () => { throw unsafe }, sendMail: async () => { throw unsafe } }))
    await expect(mailer.verify()).rejects.toThrow('private server details were suppressed')
    await expect(mailer.send({ email: 'alice@example.test', appOrigin })).rejects.toThrow('private server details were suppressed')
  })

  // This Linux VPS operator enforces POSIX ownership/modes. Windows chmod does
  // not provide those semantics; transport and configuration tests still run.
  it.skipIf(process.platform === 'win32')('requires private regular configuration files and rejects symlinks', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dm-alpha-mail-'))
    try {
      const file = join(directory, 'mail.env')
      writeFileSync(file, mailSource, { mode: 0o600 })
      expect(readPrivateFile(file)).toBe(mailSource)
      chmodSync(file, 0o644)
      expect(() => readPrivateFile(file)).toThrow('mode 600')
      chmodSync(file, 0o600)
      symlinkSync(file, join(directory, 'linked'))
      expect(() => readPrivateFile(join(directory, 'linked'))).toThrow()
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})

describe('reviewed alpha approval and notification', () => {
  async function withReceipts(callback) {
    const directory = mkdtempSync(join(tmpdir(), 'dm-alpha-receipts-'))
    chmodSync(directory, 0o700)
    try { await callback(notificationReceipts(directory)) } finally { rmSync(directory, { recursive: true, force: true }) }
  }

  // These four cases exercise the real private POSIX receipt store, rather than
  // an in-memory substitute. Pure admission/approval checks below stay portable.
  it.skipIf(process.platform === 'win32')('approves only one verified account, then sends a single ordinary invitation', async () => {
    await withReceipts(async (receipts) => {
      const { admin, granted } = fakeAdmin()
      const send = vi.fn(async () => ({ accepted: true }))
      const mailer = { verify: vi.fn(), send }
      const request = { email: 'alice@example.test', appOrigin, mailer, receipts }
      await expect(approveAlphaAccount(admin, request)).resolves.toEqual({ approved: true, notification: 'accepted-by-smtp' })
      expect(granted()).toBe(true)
      await expect(approveAlphaAccount(admin, request)).resolves.toEqual({ approved: true, notification: 'already-sent' })
      expect(send).toHaveBeenCalledTimes(1)
      expect(admin.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
    })
  })

  it.skipIf(process.platform === 'win32')('does not grant access to an unverified email or a failed SMTP preflight', async () => {
    await withReceipts(async (receipts) => {
      const { admin, granted } = fakeAdmin({ verified: false })
      const mailer = { verify: vi.fn(), send: vi.fn() }
      await expect(approveAlphaAccount(admin, { email: 'alice@example.test', appOrigin, mailer, receipts })).rejects.toThrow('verified email')
      expect(granted()).toBe(false)
      expect(mailer.send).not.toHaveBeenCalled()
      const second = fakeAdmin()
      mailer.verify.mockRejectedValueOnce(new Error('SMTP unavailable'))
      await expect(approveAlphaAccount(second.admin, { email: 'alice@example.test', appOrigin, mailer, receipts })).rejects.toThrow()
      expect(second.granted()).toBe(false)
    })
  })

  it.skipIf(process.platform === 'win32')('reports approval separately if delivery fails, and permits a notification-only retry', async () => {
    await withReceipts(async (receipts) => {
      const { admin, granted } = fakeAdmin()
      const send = vi.fn().mockRejectedValueOnce(new Error('private SMTP details')).mockResolvedValueOnce({ accepted: true })
      const mailer = { verify: vi.fn(), send }
      const request = { email: 'alice@example.test', appOrigin, mailer, receipts }
      await expect(approveAlphaAccount(admin, request)).rejects.toThrow('Account approved, but notification was not confirmed')
      expect(granted()).toBe(true)
      await expect(approveAlphaAccount(admin, { ...request, notifyOnly: true })).rejects.toThrow('may have succeeded')
      await expect(approveAlphaAccount(admin, { ...request, notifyOnly: true, resend: true })).resolves.toEqual({ approved: true, notification: 'accepted-by-smtp' })
      expect(admin.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
    })
  })

  it.skipIf(process.platform === 'win32')('will not notify an unapproved account or automatically resend an ambiguous delivery', async () => {
    await withReceipts(async (receipts) => {
      const { admin } = fakeAdmin()
      const mailer = { verify: vi.fn(), send: vi.fn() }
      const request = { email: 'alice@example.test', appOrigin, mailer, receipts }
      await expect(approveAlphaAccount(admin, { ...request, notifyOnly: true })).rejects.toThrow('not been approved')
      const lock = receipts.lock('alice')
      lock.write({ status: 'sending' }); lock.close()
      await expect(approveAlphaAccount(admin, request)).rejects.toThrow('may have succeeded')
      expect(mailer.send).not.toHaveBeenCalled()
    })
  })

  it('rejects approval roles granted through defaults', async () => {
    const { admin } = fakeAdmin({ defaultApproval: true })
    await expect(assertApprovalIsPrivate(admin)).rejects.toThrow('never be a default role')
  })

  it('refuses ambiguous accounts rather than choosing the first match', async () => {
    await expect(findAccount(async () => [{ email: 'alice@example.test' }, { email: 'alice@example.test' }], 'alice@example.test')).rejects.toThrow('exactly one')
  })

  it('requires explicit confirmed email delivery and configured gates before opening signup', async () => {
    const { admin } = fakeAdmin()
    const mailer = { verify: vi.fn() }
    await expect(enableAlphaRegistration(admin, { mailer, runtime: {}, deliveryConfirmed: true })).rejects.toThrow('approval/admission gate')
    expect(admin).not.toHaveBeenCalled()
  })

  it('requires proof from the running service, not just a new desired env file', async () => {
    const runtime = { DM_IDENTITY_ADMISSION_TOKEN: 'a'.repeat(64) }
    for (const proof of [null, {}, { gateVersion: 1, registrationEnabled: true, requiredAlphaRole: 'other', emailVerificationRequired: true }]) {
      const request = vi.fn(async () => proof === null ? new Response('', { status: 404 }) : Response.json(proof))
      await expect(verifyLiveApprovalGate(runtime, request)).rejects.toThrow('running collaboration service')
    }
    const request = vi.fn(async () => Response.json({ gateVersion: 1, registrationEnabled: true, requiredAlphaRole: 'draftmatter-alpha', emailVerificationRequired: true }))
    await expect(verifyLiveApprovalGate(runtime, request)).resolves.toBeUndefined()
    expect(request.mock.calls[0]).toMatchObject(['http://collaboration:1234/internal/identity-security', { redirect: 'error', headers: { 'X-DM-Identity-Admission': runtime.DM_IDENTITY_ADMISSION_TOKEN } }])
  })

  it('restricts private admin API to the application realm and suppresses server response bodies', async () => {
    const request = vi.fn(async () => new Response('private identity details', { status: 403 }))
    const admin = createIdentityAdmin('private-token', request)
    await expect(admin('/admin/realms/master')).rejects.toThrow('Only the DraftMatter')
    expect(request).not.toHaveBeenCalled()
    await expect(admin('/admin/realms/draftmatter')).rejects.toThrow('HTTP 403')
    expect(request.mock.calls[0][1]).toMatchObject({ redirect: 'error', headers: { authorization: 'Bearer private-token' } })
  })
})
