import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  assertServerReleaseUnused, createServerManifest, prepareServerAssets,
  serverDeploymentPaths, serverReleaseIdentity, testedImageRecord,
  verifyPublishedServerImage,
} from '../../scripts/prepare-server-release.mjs'

const commit = 'a'.repeat(40)
const identity = serverReleaseIdentity({ version: '0.1.0-alpha.1', commit })
const images = Object.fromEntries(['collaboration', 'web', 'operator'].map((kind, index) => [kind, `ghcr.io/vezy/draftmatter-${kind}@sha256:${String(index + 1).repeat(64)}`]))
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

describe('immutable server release publication boundary', () => {
  it('keeps the operator SMTP lock identical to the audited root dependency', async () => {
    const rootLock = JSON.parse(await readFile(new URL('../../package-lock.json', import.meta.url), 'utf8'))
    const operatorLock = JSON.parse(await readFile(new URL('../../deploy/single-host/operator-mail/package-lock.json', import.meta.url), 'utf8'))
    const operatorPackage = JSON.parse(await readFile(new URL('../../deploy/single-host/operator-mail/package.json', import.meta.url), 'utf8'))
    expect(operatorPackage.dependencies).toEqual({ nodemailer: rootLock.packages[''].dependencies.nodemailer })
    expect(operatorLock.packages['node_modules/nodemailer']).toEqual(rootLock.packages['node_modules/nodemailer'])
    expect(Object.keys(operatorLock.packages).sort()).toEqual(['', 'node_modules/nodemailer'])
  })

  it('requires a fixed main source and safe version before accepting image identities', () => {
    expect(identity.tag).toBe('server-v0.1.0-alpha.1')
    for (const override of [
      { version: 'latest' }, { version: 'v0.1.0' }, { version: '0.1.0; command' }, { version: '01.1.0' },
      { commit: 'a'.repeat(7) }, { ref: 'refs/heads/other' }, { repository: 'someone/DraftMatter' },
    ]) expect(() => serverReleaseIdentity({ ...identity, ...override })).toThrow()
    expect(createServerManifest(identity, images)).toMatchObject({ commit, platform: 'linux/amd64', images })
    expect(() => createServerManifest(identity, { ...images, web: 'ghcr.io/vezy/draftmatter-web:latest' })).toThrow('digest')
    expect(() => createServerManifest(identity, { ...images, operator: images.web })).toThrow('operator')
  })

  it('accepts only loaded image IDs built for the exact tested source and platform', () => {
    const image = { Id: `sha256:${'b'.repeat(64)}`, Os: 'linux', Architecture: 'amd64', Config: { Labels: { 'org.opencontainers.image.revision': commit, 'org.opencontainers.image.source': 'https://github.com/VEZY/DraftMatter' } } }
    expect(testedImageRecord('web', commit, image)).toEqual({ tag: `draftmatter-web:${commit}`, id: image.Id })
    for (const changed of [
      { ...image, Architecture: 'arm64' }, { ...image, Id: 'sha256:truncated' },
      { ...image, Config: { Labels: { ...image.Config.Labels, 'org.opencontainers.image.revision': 'c'.repeat(40) } } },
    ]) expect(() => testedImageRecord('web', commit, changed)).toThrow('tested')
  })

  it('refuses private runtime assets and symlinks even when accidentally committed under a deployment directory', () => {
    const publicHelpers = ['scripts/server-backup.sh', 'scripts/server-alpha.sh', 'scripts/stage-alpha-registration.mjs', 'docs/alpha-registration.md', 'deploy/offhost-mac/pull.mjs', 'deploy/offhost-mac/install.mjs', 'docs/offhost-mac-backups.md']
    expect(serverDeploymentPaths(publicHelpers.map((path) => ({ mode: '100644', path })))).toHaveLength(publicHelpers.length)
    expect(serverDeploymentPaths([{ mode: '100644', path: 'deploy/offhost-mac/config.json' }])).toEqual([])
    expect(serverDeploymentPaths([{ mode: '100644', path: 'papers/private-manuscript.md' }, { mode: '100644', path: 'deploy/single-host/compose.yaml' }])).toEqual([{ mode: '100644', path: 'deploy/single-host/compose.yaml' }])
    for (const path of ['deploy/single-host/runtime.env', 'deploy/single-host/tls/ca.key', 'deploy/single-host/secrets/password', 'deploy/single-host/backup.key', 'deploy/single-host/mail.env', 'deploy/single-host/alpha-notifications/receipt']) {
      expect(() => serverDeploymentPaths([{ mode: '100644', path }])).toThrow('Private')
    }
    expect(() => serverDeploymentPaths([{ mode: '120000', path: 'deploy/single-host/compose.yaml' }])).toThrow('symlinks')
  })

  it('verifies a single image and an OCI provenance index against the exact tested configuration ID', async () => {
    const expectedId = `sha256:${'d'.repeat(64)}`
    const image = { schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config: { digest: expectedId }, layers: [] }
    const response = (value, override) => {
      const bytes = JSON.stringify(value)
      return new Response(bytes, { headers: { 'docker-content-digest': override ?? `sha256:${digest(bytes)}` } })
    }
    const imageDigest = `sha256:${digest(JSON.stringify(image))}`
    await expect(verifyPublishedServerImage(response(image), { expectedId, readManifest: async () => { throw new Error('Unexpected child fetch') } })).resolves.toBe(imageDigest)
    const descriptor = { digest: imageDigest, platform: { os: 'linux', architecture: 'amd64' } }
    const attestation = { digest: `sha256:${'e'.repeat(64)}`, platform: { os: 'unknown', architecture: 'unknown' }, annotations: { 'vnd.docker.reference.type': 'attestation-manifest' } }
    const index = { schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [descriptor, attestation] }
    const children = []
    await expect(verifyPublishedServerImage(response(index), { expectedId, readManifest: async (reference) => { children.push(reference); return response(image) } })).resolves.toBe(imageDigest)
    expect(children).toEqual([imageDigest])
    await expect(verifyPublishedServerImage(response({ ...index, mediaType: 'application/vnd.docker.distribution.manifest.list.v2+json' }), { expectedId, readManifest: async () => response(image) })).resolves.toBe(imageDigest)
    for (const manifests of [[attestation], [descriptor, descriptor], [{ ...descriptor, platform: { os: 'linux', architecture: 'arm64' } }]]) {
      await expect(verifyPublishedServerImage(response({ ...index, manifests }), { expectedId, readManifest: async () => response(image) })).rejects.toThrow('exactly one')
    }
    await expect(verifyPublishedServerImage(response(index), { expectedId, readManifest: async () => response({ ...image, config: { digest: 'sha256:wrong' } }) })).rejects.toThrow('digest')
    await expect(verifyPublishedServerImage(response(image, 'sha256:wrong'), { expectedId })).rejects.toThrow('digest')
    await expect(verifyPublishedServerImage(response(image), { expectedId: `sha256:${'f'.repeat(64)}` })).rejects.toThrow('tested image ID')
  })

  it('treats only authenticated registry and GitHub 404 responses as absent releases', async () => {
    const visited = []
    const request = async (url) => {
      visited.push(url)
      return String(url).startsWith('https://ghcr.io/token?') ? Response.json({ token: 'registry-fixture-token' }) : new Response(null, { status: 404 })
    }
    await expect(assertServerReleaseUnused(identity, { token: 'workflow-token', actor: 'fixture', request })).resolves.toBeUndefined()
    expect(visited.filter((url) => String(url).includes('/manifests/'))).toHaveLength(6)
    visited.length = 0
    await expect(assertServerReleaseUnused(identity, { token: 'workflow-token', actor: 'fixture', request, registry: false })).resolves.toBeUndefined()
    expect(visited).toHaveLength(2)
    expect(visited.every(url => String(url).startsWith('https://api.github.com/'))).toBe(true)
    for (const status of [200, 401, 403, 500]) {
      await expect(assertServerReleaseUnused(identity, { token: 'workflow-token', actor: 'fixture', request: async () => new Response('private response must not be copied', { status }) })).rejects.not.toThrow('private response')
    }
    await expect(assertServerReleaseUnused(identity, { token: '', actor: 'fixture', request })).rejects.toThrow('Authenticated')
  })

  it('packages only allowlisted committed public bytes with digests and checksums, preserving previous assets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'draftmatter-server-package-test-'))
    const repo = join(directory, 'repository'), output = join(directory, 'release')
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Release fixture', GIT_AUTHOR_EMAIL: 'fixture@localhost', GIT_COMMITTER_NAME: 'Release fixture', GIT_COMMITTER_EMAIL: 'fixture@localhost' } }).trim()
    try {
      await mkdir(repo)
      git('init', '--quiet')
      const files = [
        'deploy/single-host/compose.yaml', 'deploy/single-host/prebuilt.yaml',
        'scripts/server-operator.sh', 'scripts/install-server-release.mjs', 'scripts/check-server-release.mjs',
        'papers/private-manuscript.md', 'data/private-data.csv',
      ]
      for (const path of files) { await mkdir(dirname(join(repo, path)), { recursive: true }); await writeFile(join(repo, path), `committed fixture ${path}\n`) }
      git('add', '.')
      git('-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Synthetic release source')
      const sourceCommit = git('rev-parse', 'HEAD')
      await writeFile(join(repo, 'scripts/server-operator.sh'), 'UNCOMMITTED_PRIVATE_CANARY\n')
      await writeFile(join(repo, 'deploy/single-host/runtime.env'), 'UNTRACKED_PRIVATE_CANARY\n')
      const releaseIdentity = serverReleaseIdentity({ version: identity.version, commit: sourceCommit })
      const result = await prepareServerAssets({ directory: repo, output, identity: releaseIdentity, images })
      expect(result.files).not.toContain('papers/private-manuscript.md')
      expect(result.files).not.toContain('data/private-data.csv')
      const archive = join(output, result.archiveName)
      const paths = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' })
      expect(paths).not.toMatch(/runtime\.env|private-manuscript|private-data/)
      expect(execFileSync('tar', ['-xOf', archive, 'draftmatter-server/scripts/server-operator.sh'], { encoding: 'utf8' })).toBe('committed fixture scripts/server-operator.sh\n')
      const manifestBytes = await readFile(join(output, 'server-release.json'))
      expect(JSON.parse(manifestBytes)).toMatchObject({ commit: sourceCommit, images })
      expect(execFileSync('tar', ['-xOf', archive, 'draftmatter-server/server-release.json'])).toEqual(manifestBytes)
      expect(await readFile(join(output, 'SHA256SUMS'), 'utf8')).toBe(`${digest(manifestBytes)}  server-release.json\n${digest(await readFile(archive))}  ${result.archiveName}\n`)
      await expect(prepareServerAssets({ directory: repo, output, identity: releaseIdentity, images })).rejects.toThrow()
      expect(await readFile(join(output, 'server-release.json'))).toEqual(manifestBytes)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
