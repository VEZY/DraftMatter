#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

class ServerReleaseError extends Error {}

export const serverImageKinds = ['collaboration', 'web', 'operator']
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const command = (program, args, cwd = process.cwd()) => execFileSync(program, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim()

export function serverReleaseIdentity({ version, commit, repository = 'VEZY/DraftMatter', ref = 'refs/heads/main' }) {
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:alpha|beta|rc)\.\d+)?$/.test(version ?? '')) throw new ServerReleaseError('Use a server version such as 0.1.0-alpha.1, without a v prefix.')
  if (!/^[a-f0-9]{40}$/.test(commit ?? '')) throw new ServerReleaseError('A full lowercase source commit is required.')
  if (repository !== 'VEZY/DraftMatter' || ref !== 'refs/heads/main') throw new ServerReleaseError('Server releases may only be published from VEZY/DraftMatter main.')
  return { version, commit, repository, tag: `server-v${version}`, platform: 'linux/amd64' }
}

export function serverImageRepository(kind) {
  if (!serverImageKinds.includes(kind)) throw new ServerReleaseError('Unknown server image kind.')
  return `ghcr.io/vezy/draftmatter-${kind}`
}

export function createServerManifest(identity, images) {
  for (const kind of serverImageKinds) {
    if (!new RegExp(`^${serverImageRepository(kind)}@sha256:[a-f0-9]{64}$`).test(images?.[kind] ?? '')) throw new ServerReleaseError(`An immutable ${kind} image digest is required.`)
  }
  return { schemaVersion: 1, version: identity.version, commit: identity.commit, platform: identity.platform, images: Object.fromEntries(serverImageKinds.map((kind) => [kind, images[kind]])) }
}

export function testedImageRecord(kind, commit, image) {
  const tag = `draftmatter-${kind}:${commit}`
  if (!/^[a-f0-9]{40}$/.test(commit) || image?.Os !== 'linux' || image?.Architecture !== 'amd64' ||
      !/^sha256:[a-f0-9]{64}$/.test(image?.Id ?? '') ||
      image?.Config?.Labels?.['org.opencontainers.image.revision'] !== commit ||
      image?.Config?.Labels?.['org.opencontainers.image.source'] !== 'https://github.com/VEZY/DraftMatter') {
    throw new ServerReleaseError(`The ${kind} image does not match the tested Linux amd64 source revision.`)
  }
  return { tag, id: image.Id }
}

/** Only public, committed deployment sources can enter the server archive. */
export function serverDeploymentPaths(treeEntries) {
  const files = new Set([
    'LICENSE', 'compliance/THIRD_PARTY_NOTICES.md', '.node-version',
    'scripts/init-single-host.mjs', 'scripts/check-single-host.mjs', 'scripts/single-host-config.mjs',
    'scripts/check-production-config.mjs', 'scripts/renew-single-host-tls.mjs',
    'scripts/check-server-release.mjs', 'scripts/install-server-release.mjs', 'scripts/server-operator.sh',
    'scripts/server-backup.sh', 'scripts/server-alpha.sh', 'scripts/stage-alpha-registration.mjs', 'deploy/offhost-mac/pull.mjs', 'deploy/offhost-mac/install.mjs',
    'services/collaboration/config.ts', 'src/legalConfig.ts',
    'docs/alpha-operations.md', 'docs/single-host-backups.md', 'docs/server-releases.md',
    'docs/offhost-mac-backups.md', 'docs/alpha-registration.md',
  ])
  return treeEntries.filter(({ path, mode }) => {
    if (!files.has(path) && !path.startsWith('deploy/single-host/')) return false
    if (mode !== '100644' && mode !== '100755') throw new ServerReleaseError('Server deployment sources must be ordinary committed files, without symlinks.')
    if (path.split('/').some((part) => !part || part === '.' || part === '..' || /[\r\n\0]/.test(part) || /^(?:secrets|tls|runtime\.env|release\.env|mail\.env|alpha-notifications|backup\.key|\.env(?:\..*)?)$/i.test(part)) || /\.(?:pem|key|crt|dmbackup)$/i.test(path)) {
      throw new ServerReleaseError('Private runtime files cannot be included in a server release.')
    }
    return true
  }).sort((left, right) => left.path.localeCompare(right.path))
}

export async function prepareServerAssets({ directory, output, identity, images }) {
  const root = resolve(directory)
  if (command('git', ['rev-parse', `${identity.commit}^{commit}`], root) !== identity.commit) throw new ServerReleaseError('The release commit is not available in this checkout.')
  const entries = command('git', ['ls-tree', '-r', '-z', '--full-tree', identity.commit], root).split('\0').filter(Boolean).map((entry) => {
    const match = /^(\d+) blob [a-f0-9]+\t(.+)$/.exec(entry)
    return match ? { mode: match[1], path: match[2] } : { mode: '', path: entry.slice(entry.indexOf('\t') + 1) }
  })
  const selected = serverDeploymentPaths(entries)
  for (const required of ['deploy/single-host/compose.yaml', 'deploy/single-host/prebuilt.yaml', 'scripts/server-operator.sh', 'scripts/install-server-release.mjs', 'scripts/check-server-release.mjs']) {
    if (!selected.some(({ path }) => path === required)) throw new ServerReleaseError(`Missing committed server deployment source: ${required}`)
  }
  const manifest = createServerManifest(identity, images)
  await mkdir(output, { recursive: true, mode: 0o700 })
  const staging = await mkdtemp(join(tmpdir(), 'draftmatter-server-release-'))
  try {
    const bundle = join(staging, 'draftmatter-server')
    await mkdir(bundle)
    for (const { path, mode } of selected) {
      const target = join(bundle, path)
      await mkdir(dirname(target), { recursive: true })
      const bytes = execFileSync('git', ['show', `${identity.commit}:${path}`], { cwd: root, maxBuffer: 8 * 1024 * 1024 })
      await writeFile(target, bytes, { mode: mode === '100755' ? 0o755 : 0o644, flag: 'wx' })
    }
    const manifestBytes = JSON.stringify(manifest, null, 2) + '\n'
    await writeFile(join(bundle, 'server-release.json'), manifestBytes, { flag: 'wx' })
    const archiveName = `draftmatter-server-${identity.version}.tar.gz`
    const archivePath = join(output, archiveName)
    // Exclusive creation prevents a local retry from replacing previous assets.
    await writeFile(archivePath, '', { flag: 'wx' })
    command('tar', ['-czf', archivePath, '-C', staging, 'draftmatter-server'])
    await writeFile(join(output, 'server-release.json'), manifestBytes, { flag: 'wx' })
    const checksums = `${sha256(Buffer.from(manifestBytes))}  server-release.json\n${sha256(await readFile(archivePath))}  ${archiveName}\n`
    await writeFile(join(output, 'SHA256SUMS'), checksums, { flag: 'wx' })
    const notes = `DraftMatter server ${identity.version}\n\nSource: https://github.com/${identity.repository}/commit/${identity.commit}\nPlatform: linux/amd64\n\nDownload the deployment archive and SHA256SUMS, verify the checksums, then follow docs/server-releases.md in the archive. The images in server-release.json are immutable digests promoted from the exact tested images. No DraftMatter compilation is required on the VPS. Configure the three GHCR packages as public before using anonymous docker pull.\n\nThis is a server release, separate from desktop installers. It contains code and deployment templates, never manuscripts, user data, runtime environments or secrets.\n`
    await writeFile(join(output, 'server-release-notes.md'), notes, { flag: 'wx' })
    return { manifest, archiveName, files: selected.map(({ path }) => path) }
  } finally { await rm(staging, { recursive: true, force: true }) }
}

async function registryToken(repository, token, actor, request) {
  const query = new URLSearchParams({ service: 'ghcr.io', scope: `repository:${repository}:pull,push` })
  const response = await request(`https://ghcr.io/token?${query}`, { signal: AbortSignal.timeout(30_000), headers: { Authorization: `Basic ${Buffer.from(`${actor}:${token}`).toString('base64')}` } })
  if (!response.ok) throw new ServerReleaseError(`Cannot authenticate to GHCR (HTTP ${response.status}); no tags were changed.`)
  const body = await response.json()
  if (typeof body.token !== 'string' || !body.token) throw new ServerReleaseError('GHCR did not return a registry token.')
  return body.token
}

async function registryManifest(repository, tag, token, actor, request) {
  const bearer = await registryToken(repository, token, actor, request)
  return request(`https://ghcr.io/v2/${repository}/manifests/${tag}`, { signal: AbortSignal.timeout(30_000), headers: {
    Authorization: `Bearer ${bearer}`,
    Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json',
  } })
}

/** Verify the platform child rather than mistaking a provenance index for an image. */
export async function verifyPublishedServerImage(response, { expectedId, readManifest }) {
  const read = async (value, expectedDigest) => {
    if (!value.ok || Number(value.headers.get('content-length') ?? 0) > 4 * 1024 * 1024) throw new ServerReleaseError('The published registry manifest could not be read within its safety limit.')
    const bytes = Buffer.from(await value.arrayBuffer())
    const digest = `sha256:${sha256(bytes)}`
    if (bytes.length > 4 * 1024 * 1024 || value.headers.get('docker-content-digest') !== digest || (expectedDigest && expectedDigest !== digest)) throw new ServerReleaseError('The registry manifest digest does not match its bytes.')
    let document
    try { document = JSON.parse(bytes.toString('utf8')) } catch { throw new ServerReleaseError('The registry returned an unreadable manifest.') }
    if (document.schemaVersion !== 2) throw new ServerReleaseError('An OCI or Docker schema 2 image manifest is required.')
    return { digest, document }
  }
  let image = await read(response)
  if (Array.isArray(image.document.manifests)) {
    const platformImages = image.document.manifests.filter((entry) => entry.platform?.os === 'linux' && entry.platform?.architecture === 'amd64' &&
      (!entry.platform.variant || entry.platform.variant === 'v1') && entry.annotations?.['vnd.docker.reference.type'] !== 'attestation-manifest')
    if (platformImages.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(platformImages[0].digest ?? '')) throw new ServerReleaseError('The registry index must identify exactly one Linux amd64 image.')
    const child = platformImages[0].digest
    image = await read(await readManifest(child), child)
  }
  if (Array.isArray(image.document.manifests) || image.document.config?.digest !== expectedId) throw new ServerReleaseError('The registry image configuration differs from the exact tested image ID.')
  return image.digest
}

/** Fail closed on authentication/network errors; only a genuine 404 is absent. */
export async function assertServerReleaseUnused(identity, { token, actor, request = fetch, registry = true }) {
  if (!token || !actor) throw new ServerReleaseError('Authenticated release preflight is required.')
  for (const path of [`releases/tags/${identity.tag}`, `git/ref/tags/${identity.tag}`]) {
    const response = await request(`https://api.github.com/repos/${identity.repository}/${path}`, { signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } })
    if (response.status !== 404) throw new ServerReleaseError(response.ok ? `The release/tag ${identity.tag} already exists; choose a new version.` : `Cannot verify release availability (HTTP ${response.status}); publication refused.`)
  }
  if (!registry) return
  for (const kind of serverImageKinds) {
    const repository = serverImageRepository(kind).slice('ghcr.io/'.length)
    for (const tag of [`sha-${identity.commit}`, identity.version]) {
      const response = await registryManifest(repository, tag, token, actor, request)
      if (response.status !== 404) throw new ServerReleaseError(response.ok ? `The ${kind} image tag already exists; server images are never overwritten.` : `Cannot verify the ${kind} image tag (HTTP ${response.status}); publication refused.`)
    }
  }
}

async function main() {
  const [mode, fileOrDirectory, output] = process.argv.slice(2)
  const identity = serverReleaseIdentity({ version: process.env.RELEASE_VERSION, commit: process.env.RELEASE_COMMIT, repository: process.env.GITHUB_REPOSITORY, ref: process.env.GITHUB_REF })
  if (command('git', ['rev-parse', 'HEAD']) !== identity.commit) throw new ServerReleaseError('The checked-out source does not match the workflow commit.')
  const inspect = (tag) => JSON.parse(command('docker', ['image', 'inspect', tag]))[0]
  if (mode === 'preflight') {
    // A read-only job must not request push scope for a package that may not
    // exist yet. Registry collision checks run under packages:write below.
    await assertServerReleaseUnused(identity, { token: process.env.GH_TOKEN, actor: process.env.GITHUB_ACTOR, registry: false })
    console.log(`Server release preflight passed: ${identity.tag}, ${identity.commit}.`)
  } else if (mode === 'export-tested-images') {
    await mkdir(fileOrDirectory, { recursive: true })
    const images = Object.fromEntries(serverImageKinds.map((kind) => [kind, testedImageRecord(kind, identity.commit, inspect(`draftmatter-${kind}:${identity.commit}`))]))
    await writeFile(join(fileOrDirectory, 'tested-images.json'), JSON.stringify({ schemaVersion: 1, commit: identity.commit, platform: identity.platform, images }, null, 2) + '\n', { flag: 'wx' })
  } else if (mode === 'verify-tested-images' || mode === 'publish-images') {
    const tested = JSON.parse(await readFile(fileOrDirectory, 'utf8'))
    if (tested.schemaVersion !== 1 || tested.commit !== identity.commit || tested.platform !== identity.platform) throw new ServerReleaseError('The tested image artifact belongs to another source revision or platform.')
    for (const kind of serverImageKinds) {
      const actual = testedImageRecord(kind, identity.commit, inspect(`draftmatter-${kind}:${identity.commit}`))
      if (tested.images?.[kind]?.id !== actual.id || tested.images?.[kind]?.tag !== actual.tag) throw new ServerReleaseError('A loaded image differs from the verified artifact.')
    }
    if (mode === 'verify-tested-images') { console.log('All three loaded images match the exact tested source and image IDs.'); return }
    await assertServerReleaseUnused(identity, { token: process.env.GH_TOKEN, actor: process.env.GITHUB_ACTOR })
    const images = {}
    for (const kind of serverImageKinds) {
      const repository = serverImageRepository(kind)
      for (const tag of [`sha-${identity.commit}`, identity.version]) {
        command('docker', ['tag', tested.images[kind].tag, `${repository}:${tag}`])
        command('docker', ['push', `${repository}:${tag}`])
      }
      const response = await registryManifest(repository.slice('ghcr.io/'.length), `sha-${identity.commit}`, process.env.GH_TOKEN, process.env.GITHUB_ACTOR, fetch)
      const digest = await verifyPublishedServerImage(response, {
        expectedId: tested.images[kind].id,
        readManifest: (reference) => registryManifest(repository.slice('ghcr.io/'.length), reference, process.env.GH_TOKEN, process.env.GITHUB_ACTOR, fetch),
      })
      images[kind] = `${repository}@${digest}`
    }
    await prepareServerAssets({ directory: process.cwd(), output, identity, images })
    console.log(`Prepared server release assets for ${identity.tag}; no runtime secrets or research data were included.`)
  } else throw new ServerReleaseError('Use preflight, export-tested-images <directory>, verify-tested-images <metadata>, or publish-images <metadata> <output-directory>.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error instanceof ServerReleaseError ? error.message : 'Server release preparation failed. Publication must stop; inspect the failing phase without exposing registry credentials.'); process.exitCode = 1 })
}
