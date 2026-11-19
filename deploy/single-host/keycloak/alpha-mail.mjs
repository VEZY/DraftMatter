import { lstatSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import nodemailer from 'nodemailer'

export function emailAddress(value) {
  if (typeof value !== 'string' || value.length > 254 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(value)) {
    throw new Error('Provide one plain email address, without a display name or header characters.')
  }
  return value.toLowerCase()
}

/** Read only a private regular file, never an executable/sourced shell script. */
export function readPrivateFile(path) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536 || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error('The private configuration must be a regular file owned by this user with mode 600.')
  }
  return readFileSync(path, 'utf8')
}

export function parseMailConfiguration(source) {
  const env = parseEnv(source)
  const host = env.DM_SMTP_HOST
  if (typeof host !== 'string' || host.length > 253 || !/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,}$/.test(host)) throw new Error('DM_SMTP_HOST must be the confirmed SMTP DNS host.')
  const port = Number(env.DM_SMTP_PORT)
  if (port !== 465 && port !== 587) throw new Error('SMTP must use port 465 with TLS or port 587 with required STARTTLS.')
  const user = emailAddress(env.DM_SMTP_USER)
  const from = emailAddress(env.DM_SMTP_FROM)
  if (user !== from) throw new Error('Use the authenticated mailbox as the sender.')
  if (env.DM_SMTP_PASSWORD !== undefined && env.DM_SMTP_PASSWORD_BASE64 !== undefined) throw new Error('Configure exactly one SMTP password field.')
  let password = env.DM_SMTP_PASSWORD
  if (env.DM_SMTP_PASSWORD_BASE64 !== undefined) {
    const encoded = env.DM_SMTP_PASSWORD_BASE64
    const bytes = Buffer.from(encoded, 'base64')
    if (!encoded || encoded.length > 5464 || bytes.toString('base64') !== encoded) throw new Error('The private SMTP password encoding is invalid.')
    try { password = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    catch { throw new Error('The private SMTP password encoding is invalid.') }
  }
  if (typeof password !== 'string' || !password || password.length > 1024 || /[\r\n\0]/.test(password)) throw new Error('A private SMTP mailbox password is required.')
  return { host, port, user, from, password }
}

export function keycloakSmtpConfiguration(mail) {
  return { host: mail.host, port: String(mail.port), from: mail.from, fromDisplayName: 'DraftMatter',
    auth: 'true', user: mail.user, password: mail.password,
    ssl: String(mail.port === 465), starttls: String(mail.port === 587) }
}

export function createAlphaMailer(mail, createTransport = nodemailer.createTransport) {
  const transport = createTransport({
    host: mail.host, port: mail.port, secure: mail.port === 465,
    requireTLS: true, auth: { user: mail.user, pass: mail.password },
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2', servername: mail.host },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
    logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true,
  })
  return {
    async verify() {
      try { await transport.verify() } catch { throw new Error('The SMTP connection or authentication check failed; private server details were suppressed.') }
    },
    async send({ email, appOrigin, test = false }) {
      const recipient = emailAddress(email)
      const origin = new URL(appOrigin)
      if (origin.protocol !== 'https:' || origin.origin !== appOrigin || origin.username || origin.password) throw new Error('The invitation must link to the configured HTTPS application origin.')
      let result
      try { result = await transport.sendMail({
        from: { name: 'DraftMatter', address: mail.from }, to: recipient,
        subject: test ? 'DraftMatter email delivery check' : 'Your DraftMatter alpha invitation',
        text: test
          ? `This is the DraftMatter operator email delivery check. No account access has changed.\n\n${origin.origin}/\n`
          : `You have been invited to the DraftMatter alpha.\n\nSign in with the email address and password you used to register:\n${origin.origin}/\n\nDraftMatter is in pre-production. Keep your own backups of your work.\n\nIf you did not request an account, you can ignore this message.\n`,
        disableFileAccess: true, disableUrlAccess: true,
      }) } catch { throw new Error('SMTP delivery failed; private server details were suppressed.') }
      if (result.rejected?.length || !result.accepted?.some((address) => String(address).toLowerCase() === recipient)) throw new Error('The SMTP server did not accept the recipient.')
      // Accepted by SMTP is not proof of inbox delivery.
      return { accepted: true }
    },
    close: () => transport.close(),
  }
}
