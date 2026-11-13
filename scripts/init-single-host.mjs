import { mkdirSync, writeFileSync, readdirSync, existsSync, chmodSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { buildSingleHostRealm } from '../deploy/single-host/keycloak/realm.mjs'
import { outsideCheckout, renderSingleHostCaddy, singleHostS3Identity } from './single-host-config.mjs'

export function createSingleHostEnvironment(options) {
  const rehearsal = Boolean(options.rehearsal)
  const appHost = rehearsal ? 'app.draftmatter.localhost' : options['app-host']
  const syncHost = rehearsal ? 'sync.draftmatter.localhost' : options['sync-host']
  const authHost = rehearsal ? 'auth.draftmatter.localhost' : options['auth-host']
  const httpsPort = rehearsal ? 8443 : 443
  // This checks untrusted hostname input before writing it into proxy/realm files.
  buildSingleHostRealm({ appHost, authHost, httpsPort })
  buildSingleHostRealm({ appHost: syncHost, authHost, httpsPort })
  if (new Set([appHost, syncHost, authHost]).size !== 3 || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(syncHost ?? '')) throw new Error('Provide three distinct DNS hosts.')
  const directory = outsideCheckout(options.directory)
  if (!/^[^\s@"\\$]+@[^\s@"\\$]+\.[^\s@"\\$]+$/.test(options.email ?? 'contact@draftmatter.eu')) throw new Error('Provide a valid certificate contact email.')
  const suffix = rehearsal ? ':8443' : ''
  const secret = () => randomBytes(32).toString('hex')
  const id = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)
  const env = {
    DM_SINGLE_HOST_MODE: rehearsal ? 'rehearsal' : 'production',
    // Forward slashes work in native Windows paths and quoted Compose env files.
    DM_SINGLE_HOST_DIR: directory.split(sep).join('/'),
    COMPOSE_PROJECT_NAME: options.project ?? `draftmatter-${rehearsal ? 'rehearsal' : 'alpha'}-${id}`,
    RELEASE_ID: options.release ?? `local-${rehearsal ? 'rehearsal' : 'prepared'}-${id}`,
    APP_HOST: appHost, COLLABORATION_HOST: syncHost, AUTH_HOST: authHost,
    APP_ORIGIN: `https://${appHost}${suffix}`, COLLABORATION_ORIGIN: `https://${syncHost}${suffix}`, AUTH_ORIGIN: `https://${authHost}${suffix}`,
    BIND_ADDRESS: rehearsal ? '127.0.0.1' : '0.0.0.0', HTTP_PORT: rehearsal ? '8088' : '80', HTTPS_PORT: String(httpsPort),
    ACME_EMAIL: options.email ?? 'contact@draftmatter.eu',
    DM_LEGAL_PUBLISHER_NAME: 'Rémi Vezy', DM_LEGAL_CONTACT_EMAIL: 'contact@draftmatter.eu',
    DM_LEGAL_HOSTING_DETAILS: rehearsal ? 'Local pre-production test operated by Rémi Vezy; no public hosting provider.' : 'REPLACE_CONFIRMED_HOSTING_PROVIDER_COORDINATES',
    DM_LEGAL_DATA_LOCATION: rehearsal ? 'Local testing only. Hosting for the hosted alpha is planned in France, with a French hosting company.' : 'REPLACE_CONFIRMED_SHORT_HOSTING_STATEMENT',
    DM_LEGAL_ADDITIONAL_PROCESSORS: rehearsal ? 'No email delivery or external service is enabled for this local test.' : 'REPLACE_ACTUAL_EMAIL_AND_OTHER_PROCESSORS',
    POSTGRES_PASSWORD: secret(), DM_DB_PASSWORD: secret(), KC_DB_PASSWORD: secret(), KC_BOOTSTRAP_ADMIN_PASSWORD: secret(),
    DM_DATABASE_TLS: 'verify-full', DM_DATABASE_URL: '',
    DM_OBJECT_BUCKET: 'draftmatter', DM_OBJECT_REGION: 'eu-local', DM_OBJECT_PREFIX: 'draftmatter',
    DM_OBJECT_ENDPOINT: 'https://object-storage:8334', DM_OBJECT_FORCE_PATH_STYLE: 'true',
    DM_OBJECT_ACCESS_KEY: secret(), DM_OBJECT_SECRET_KEY: secret(),
    DM_OIDC_ISSUER: `https://${authHost}${suffix}/realms/draftmatter`,
    DM_OIDC_JWKS_URI: `https://${authHost}${suffix}/realms/draftmatter/protocol/openid-connect/certs`,
    DM_OIDC_AUDIENCE: 'draftmatter-collaboration', DM_OIDC_CLIENT_ID: 'draftmatter-public',
    DM_ALLOWED_ORIGINS: `https://${appHost}${suffix},tauri://localhost,http://tauri.localhost`,
    DM_WEBHOOK_SECRET: secret(), DM_PROJECT_FILES_TOTAL_QUOTA_BYTES: '25000000000',
  }
  env.DM_DATABASE_URL = `postgresql://draftmatter:${env.DM_DB_PASSWORD}@postgres:5432/draftmatter`
  if (rehearsal) for (const user of ['ALICE', 'BOB', 'EVE']) env[`REHEARSAL_${user}_PASSWORD`] = secret()
  return env
}

export function serializeEnvironment(env) {
  return Object.entries(env).map(([name, value]) => {
    if (/[\r\n"\\$]/.test(value)) throw new Error(`${name} contains unsupported environment-file characters.`)
    return `${name}="${value}"`
  }).join('\n') + '\n'
}

export function initializeSingleHost(options) {
  const env = createSingleHostEnvironment(options)
  const directory = env.DM_SINGLE_HOST_DIR
  if (existsSync(directory) && readdirSync(directory).length) throw new Error('Refusing to overwrite an existing deployment directory or rotate its credentials.')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  const tls = resolve(directory, 'tls')
  mkdirSync(tls, { mode: 0o700 })
  const openssl = (args) => {
    const result = spawnSync('openssl', args, { cwd: tls, encoding: 'utf8' })
    if (result.status !== 0) throw new Error('Certificate generation failed; install OpenSSL and use a new empty deployment directory.')
  }
  openssl(['req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-sha256', '-days', '365', '-subj', '/CN=DraftMatter private infrastructure CA', '-keyout', 'ca.key', '-out', 'ca.crt', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'])
  function certificate(name, names) {
    openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${names[0]}`, '-keyout', `${name}.key`, '-out', `${name}.csr`])
    writeFileSync(resolve(tls, `${name}.ext`), `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${names.map((host) => `DNS:${host}`).join(',')}\n`, { mode: 0o600 })
    openssl(['x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${name}.crt`, '-days', '90', '-sha256', '-extfile', `${name}.ext`])
    chmodSync(resolve(tls, `${name}.key`), 0o600)
  }
  certificate('postgres', ['postgres'])
  certificate('objects', ['object-storage'])
  if (options.rehearsal) certificate('public', [env.APP_HOST, env.COLLABORATION_HOST, env.AUTH_HOST])
  chmodSync(resolve(tls, 'ca.key'), 0o600)
  writeFileSync(resolve(directory, 'runtime.env'), serializeEnvironment(env), { mode: 0o600 })
  writeFileSync(resolve(directory, 'backup.key'), randomBytes(32), { mode: 0o600 })
  writeFileSync(resolve(directory, 'realm.json'), JSON.stringify(buildSingleHostRealm({ appHost: env.APP_HOST, authHost: env.AUTH_HOST, httpsPort: Number(env.HTTPS_PORT) }), null, 2) + '\n', { mode: 0o644 })
  // The directory is private; these single-file mounts must be readable by UID 1000.
  writeFileSync(resolve(directory, 's3.json'), JSON.stringify(singleHostS3Identity(env), null, 2) + '\n', { mode: 0o644 })
  writeFileSync(resolve(directory, 'Caddyfile'), renderSingleHostCaddy(env), { mode: 0o644 })
  return { directory, rehearsal: options.rehearsal, projectName: env.COMPOSE_PROJECT_NAME }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: {
      directory: { type: 'string' }, rehearsal: { type: 'boolean' }, project: { type: 'string' }, release: { type: 'string' },
      'app-host': { type: 'string' }, 'sync-host': { type: 'string' }, 'auth-host': { type: 'string' }, email: { type: 'string' },
    } })
    if (!values.directory) throw new Error('Usage: node scripts/init-single-host.mjs --directory /absolute/private/path [--rehearsal | --app-host HOST --sync-host HOST --auth-host HOST]')
    const result = initializeSingleHost(values)
    process.stdout.write(`Created isolated ${result.rehearsal ? 'local rehearsal' : 'production preparation'} configuration (${result.projectName}). Credentials were written privately, never printed.\n`)
    if (!result.rehearsal) process.stdout.write('Fill the actual legal hosting/location/processors information and an exact reviewed RELEASE_ID before production validation.\n')
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
