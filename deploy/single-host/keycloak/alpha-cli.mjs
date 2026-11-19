import { parseArgs, parseEnv } from 'node:util'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { administratorSession, createIdentityAdmin, migrateAlphaIdentity, configureIdentityMail, enableAlphaRegistration, listPendingAccounts, approveAlphaAccount, notificationReceipts } from './alpha-admin.mjs'
import { configureOrcid } from './orcid.mjs'
import { createAlphaMailer, parseMailConfiguration, readPrivateFile } from './alpha-mail.mjs'

async function privatePassword(label = 'Keycloak administrator password') {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Run the operator interactively in a terminal. Never pass administrator passwords as command arguments.')
  process.stdout.write(`${label} (hidden): `)
  const input = process.stdin
  const wasRaw = input.isRaw
  input.setRawMode(true)
  input.resume()
  try {
    return await new Promise((resolvePassword, reject) => {
      let result = ''
      const cleanup = () => input.off('data', onData)
      const onData = (data) => {
        for (const character of data.toString('utf8')) {
          if (character === '\u0003' || character === '\u0004') { cleanup(); reject(new Error('Administrator authentication cancelled.')); return }
          if (character === '\r' || character === '\n') { cleanup(); resolvePassword(result); return }
          if (character === '\u007f' || character === '\b') result = result.slice(0, -1)
          else if (character >= ' ' && result.length < 1024) result += character
        }
      }
      input.on('data', onData)
    })
  } finally { input.setRawMode(Boolean(wasRaw)); input.pause(); process.stdout.write('\n') }
}

export async function runAlphaOperator(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    directory: { type: 'string', default: '/runtime' }, admin: { type: 'string', default: 'remi-admin' },
    'orcid-environment': { type: 'string' }, 'client-id': { type: 'string' },
    email: { type: 'string' }, 'owner-email': { type: 'string' }, resend: { type: 'boolean', default: false },
    'mail-delivery-confirmed': { type: 'boolean', default: false },
  } })
  const operation = positionals[0]
  if (positionals.length !== 1 || !['migrate', 'configure-mail', 'configure-orcid', 'test-mail', 'pending', 'approve', 'notify', 'enable-registration', 'close-registration'].includes(operation)) {
    throw new Error('Operations: migrate [--owner-email EMAIL], configure-mail, configure-orcid --orcid-environment sandbox|production --client-id ID, test-mail --email EMAIL, pending, approve --email EMAIL, notify --email EMAIL [--resend], enable-registration --mail-delivery-confirmed, close-registration.')
  }
  const directory = resolve(values.directory)
  const runtime = parseEnv(readPrivateFile(resolve(directory, 'runtime.env')))
  const mailOperation = ['configure-mail', 'test-mail', 'approve', 'notify', 'enable-registration'].includes(operation)
  const mail = mailOperation ? parseMailConfiguration(readPrivateFile(resolve(directory, 'mail.env'))) : null
  const mailer = mail ? createAlphaMailer(mail) : null
  let session
  try {
    session = await administratorSession({ username: values.admin, password: await privatePassword() })
    const admin = createIdentityAdmin(session.token)
    let result
    if (operation === 'migrate') result = await migrateAlphaIdentity(admin, { ownerEmail: values['owner-email'], orcidEnabled: runtime.DM_ORCID_LINKING_ENABLED === 'true' })
    if (operation === 'configure-orcid') result = await configureOrcid(admin, {
      environment: values['orcid-environment'], clientId: values['client-id'], clientSecret: await privatePassword('ORCID application client secret'),
    })
    if (operation === 'configure-mail') result = await configureIdentityMail(admin, mail, mailer)
    if (operation === 'test-mail') {
      await mailer.verify()
      result = await mailer.send({ email: values.email, appOrigin: runtime.APP_ORIGIN, test: true })
    }
    if (operation === 'pending') result = { pending: await listPendingAccounts(admin) }
    if (operation === 'approve' || operation === 'notify') result = await approveAlphaAccount(admin, {
      email: values.email, appOrigin: runtime.APP_ORIGIN, mailer, receipts: notificationReceipts(resolve(directory, 'alpha-notifications')),
      notifyOnly: operation === 'notify', resend: values.resend,
    })
    if (operation === 'enable-registration') result = await enableAlphaRegistration(admin, { mailer, mail, runtime, deliveryConfirmed: values['mail-delivery-confirmed'] })
    if (operation === 'close-registration') {
      await admin('/admin/realms/draftmatter', { method: 'PUT', body: { registrationAllowed: false } })
      result = { registrationEnabled: false }
    }
    process.stdout.write(JSON.stringify(result) + '\n')
  } finally { mailer?.close(); await session?.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await runAlphaOperator() } catch (error) {
    // SMTP errors may contain usernames/server replies. Report only our own
    // controlled messages; transport/auth details stay out of terminal logs.
    const message = error instanceof Error && error.constructor === Error ? error.message : 'The identity/mail operation failed. Check private configuration and connectivity; no credentials were printed.'
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  }
}
