import { readFileSync, statSync, realpathSync, existsSync, lstatSync } from 'node:fs'
import { resolve, dirname, relative, isAbsolute, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { isDeepStrictEqual } from 'node:util'
import { validateProductionEnvironment } from './check-production-config.mjs'
import { buildSingleHostRealm } from '../deploy/single-host/keycloak/realm.mjs'

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function isOutsideDirectory(parent, directory, paths = { relative, isAbsolute, sep }) {
  const relationship = paths.relative(parent, directory)
  return paths.isAbsolute(relationship) || relationship === '..' || relationship.startsWith(`..${paths.sep}`)
}

export function outsideCheckout(directory) {
  const absolute = resolve(directory)
  let existing = absolute
  while (!existsSync(existing)) existing = dirname(existing)
  const canonical = resolve(realpathSync(existing), relative(existing, absolute))
  if (!isOutsideDirectory(realpathSync(repositoryRoot), canonical)) throw new Error('Keep deployment secrets outside the checkout and build context.')
  return absolute
}

export function readSingleHostEnvironment(file) {
  const absolute = resolve(file)
  outsideCheckout(absolute)
  if (!lstatSync(absolute).isFile() || lstatSync(absolute).isSymbolicLink()) throw new Error('The deployment environment must be a regular file, without links.')
  if (process.platform !== 'win32' && (statSync(absolute).mode & 0o077)) throw new Error('The deployment environment must be private (chmod 600).')
  const env = parseEnv(readFileSync(absolute, 'utf8'))
  if (realpathSync(dirname(absolute)) !== realpathSync(env.DM_SINGLE_HOST_DIR)) throw new Error('runtime.env must reside inside its own deployment directory.')
  for (const name of Object.keys(env)) {
    if (process.env[name] !== undefined && process.env[name] !== env[name]) throw new Error(`${name} is exported with a conflicting value; unset it first.`)
  }
  return env
}

export function renderSingleHostCaddy(env) {
  const rehearsal = env.DM_SINGLE_HOST_MODE === 'rehearsal'
  const tls = rehearsal ? '\n\ttls /run/draftmatter-tls/public.crt /run/draftmatter-tls/public.key' : ''
  return `{
\temail ${env.ACME_EMAIL}
\thttp_port ${env.HTTP_PORT}
\thttps_port ${env.HTTPS_PORT}
\tadmin off
\tgrace_period 20s
\tservers {\n\t\tprotocols h1 h2\n\t}
}

import /etc/caddy/routes.caddy

${env.APP_ORIGIN} {${tls}
\timport draftmatter_app
}

${env.COLLABORATION_ORIGIN} {${tls}
\timport draftmatter_sync
}

${env.AUTH_ORIGIN} {${tls}
\theader {
\t\t-Server
\t\tX-Content-Type-Options nosniff
\t\tReferrer-Policy no-referrer
\t\tStrict-Transport-Security "max-age=31536000"
\t}
\t# The master realm, admin API/console and management endpoints stay private.
\t@identity path /realms/draftmatter/* /resources/* /robots.txt
\thandle @identity {
\t\treverse_proxy keycloak:8080
\t}
\thandle {\n\t\trespond "Not found" 404\n\t}
}
`
}

export function validateSingleHostEnvironment(env, { checkFiles = true } = {}) {
  if (!['production', 'rehearsal'].includes(env.DM_SINGLE_HOST_MODE)) throw new Error('DM_SINGLE_HOST_MODE must be production or rehearsal.')
  const rehearsal = env.DM_SINGLE_HOST_MODE === 'rehearsal'
  const settings = validateProductionEnvironment(env, { localRehearsal: rehearsal })
  if (!rehearsal && env.RELEASE_ID.startsWith('local-')) throw new Error('Set RELEASE_ID to the exact reviewed commit or release before production.')
  buildSingleHostRealm({ appHost: env.APP_HOST, authHost: env.AUTH_HOST, httpsPort: Number(env.HTTPS_PORT) })
  if (env.HTTP_PORT !== (rehearsal ? '8088' : '80') || env.HTTPS_PORT !== (rehearsal ? '8443' : '443') ||
      env.BIND_ADDRESS !== (rehearsal ? '127.0.0.1' : '0.0.0.0')) throw new Error('Unexpected binding or ports for this deployment mode.')
  if (rehearsal ? env.AUTH_HOST !== 'auth.draftmatter.localhost' : !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(env.AUTH_HOST ?? '') || /\.(localhost|test|invalid|example|local)$/.test(env.AUTH_HOST)) {
    throw new Error('AUTH_HOST must be a valid hostname for this deployment mode.')
  }
  if (new Set([env.APP_HOST, env.COLLABORATION_HOST, env.AUTH_HOST]).size !== 3) throw new Error('Application, collaboration and identity hosts must differ.')
  const suffix = rehearsal ? ':8443' : ''
  const expected = {
    APP_ORIGIN: `https://${env.APP_HOST}${suffix}`,
    COLLABORATION_ORIGIN: `https://${env.COLLABORATION_HOST}${suffix}`,
    AUTH_ORIGIN: `https://${env.AUTH_HOST}${suffix}`,
    DM_OIDC_ISSUER: `https://${env.AUTH_HOST}${suffix}/realms/draftmatter`,
    DM_OIDC_JWKS_URI: `https://${env.AUTH_HOST}${suffix}/realms/draftmatter/protocol/openid-connect/certs`,
    DM_DATABASE_URL: `postgresql://draftmatter:${env.DM_DB_PASSWORD}@postgres:5432/draftmatter`,
    DM_OBJECT_ENDPOINT: 'https://object-storage:8334',
    DM_OBJECT_BUCKET: 'draftmatter', DM_OBJECT_REGION: 'eu-local', DM_OBJECT_PREFIX: 'draftmatter',
    DM_DATABASE_TLS: 'verify-full', DM_OIDC_AUDIENCE: 'draftmatter-collaboration', DM_OIDC_CLIENT_ID: 'draftmatter-public',
    DM_OBJECT_FORCE_PATH_STYLE: 'true',
  }
  for (const [name, value] of Object.entries(expected)) if (env[name] !== value) throw new Error(`${name} differs from the single-host topology.`)
  for (const name of ['POSTGRES_PASSWORD', 'DM_DB_PASSWORD', 'KC_DB_PASSWORD', 'KC_BOOTSTRAP_ADMIN_PASSWORD', 'DM_OBJECT_ACCESS_KEY', 'DM_OBJECT_SECRET_KEY']) {
    if (!/^[a-f0-9]{48,128}$/.test(env[name] ?? '')) throw new Error(`${name} must be an independently generated hexadecimal secret.`)
  }
  const secrets = ['POSTGRES_PASSWORD', 'DM_DB_PASSWORD', 'KC_DB_PASSWORD', 'KC_BOOTSTRAP_ADMIN_PASSWORD', 'DM_OBJECT_ACCESS_KEY', 'DM_OBJECT_SECRET_KEY', 'DM_WEBHOOK_SECRET'].map((name) => env[name])
  if (new Set(secrets).size !== secrets.length) throw new Error('Do not reuse deployment secrets between services.')
  if (!/^draftmatter-(alpha|rehearsal|restore)-[a-z0-9-]+$/.test(env.COMPOSE_PROJECT_NAME ?? '')) throw new Error('Use a dedicated DraftMatter Compose project name.')
  const directory = outsideCheckout(env.DM_SINGLE_HOST_DIR)
  if (checkFiles) {
    const info = lstatSync(directory)
    if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077))) throw new Error('The deployment directory must be private (chmod 700), without links.')
    const realm = JSON.parse(readFileSync(resolve(directory, 'realm.json'), 'utf8'))
    if (!isDeepStrictEqual(realm, buildSingleHostRealm({ appHost: env.APP_HOST, authHost: env.AUTH_HOST, httpsPort: Number(env.HTTPS_PORT) }))) throw new Error('The realm import differs from the closed-alpha identity policy.')
    if (readFileSync(resolve(directory, 'Caddyfile'), 'utf8') !== renderSingleHostCaddy(env)) throw new Error('The proxy configuration differs from the checked deployment environment.')
    const storage = JSON.parse(readFileSync(resolve(directory, 's3.json'), 'utf8'))
    if (!isDeepStrictEqual(storage, singleHostS3Identity(env))) throw new Error('The object-storage credentials or bucket permissions differ from this deployment.')
  }
  return { ...settings, authOrigin: env.AUTH_ORIGIN, rehearsal, directory, projectName: env.COMPOSE_PROJECT_NAME }
}

export function singleHostS3Identity(env) {
  return { identities: [{ name: 'draftmatter-application', credentials: [{ accessKey: env.DM_OBJECT_ACCESS_KEY, secretKey: env.DM_OBJECT_SECRET_KEY }], actions: ['Read:draftmatter', 'Write:draftmatter', 'List:draftmatter'] }] }
}
