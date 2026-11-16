import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, symlinkSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { readServerRelease, serverReleaseEnvironment, validateServerRelease, writeServerReleaseEnvironment } from '../../scripts/check-server-release.mjs'
import { installServerRelease, checkInstalledServerRelease } from '../../scripts/install-server-release.mjs'

const folders = []
const digest = (name) => `ghcr.io/vezy/draftmatter-${name}@sha256:${'a'.repeat(64)}`
const release = () => ({ schemaVersion: 1, version: '0.1.0-alpha.1', commit: 'b'.repeat(40), platform: 'linux/amd64', images: { collaboration: digest('collaboration'), web: digest('web'), operator: digest('operator') } })
function folder() { const value = mkdtempSync(join(tmpdir(), 'draftmatter-server-release-')); chmodSync(value, 0o700); folders.push(value); return value }
afterEach(() => { for (const value of folders.splice(0)) rmSync(value, { recursive: true, force: true }) })

describe('prebuilt server release consumption', () => {
  it('emits exactly pinned public image references and the full source commit', () => {
    const value = release()
    expect(validateServerRelease(value)).toEqual(value)
    expect(serverReleaseEnvironment(value)).toBe(`RELEASE_ID="${value.commit}"\nDM_COLLABORATION_IMAGE="${value.images.collaboration}"\nDM_WEB_IMAGE="${value.images.web}"\nDM_OPERATOR_IMAGE="${value.images.operator}"\n`)
    value.images.web = `${value.images.web}\nDM_DATABASE_URL=not-an-image`
    expect(() => serverReleaseEnvironment(value)).toThrow('immutable SHA-256 digest')
  })

  it('rejects mutable tags, other registries, extra environment keys and unsupported platforms', () => {
    for (const reference of ['ghcr.io/vezy/draftmatter-web:latest', digest('operator'), 'https://ghcr.io/vezy/draftmatter-web@sha256:' + 'a'.repeat(64), 'ghcr.io/other/draftmatter-web@sha256:' + 'a'.repeat(64)]) {
      const value = release(); value.images.web = reference
      expect(() => validateServerRelease(value)).toThrow('expected registry repository')
    }
    expect(() => validateServerRelease({ ...release(), platform: 'linux/arm64' })).toThrow('linux/amd64')
    expect(() => validateServerRelease({ ...release(), commit: 'shortsha' })).toThrow('full source commit')
    expect(() => validateServerRelease({ ...release(), version: 'latest' })).toThrow('version')
    expect(() => validateServerRelease({ ...release(), POSTGRES_PASSWORD: 'do-not-copy' })).toThrow('Unsupported')
    expect(() => validateServerRelease({ ...release(), images: { ...release().images, attacker: 'shell' } })).toThrow('images only')
  })

  it('reads only bounded regular manifest files without symbolic links', () => {
    const directory = folder(), path = join(directory, 'server-release.json')
    writeFileSync(path, JSON.stringify(release()))
    expect(readServerRelease(path)).toEqual(release())
    symlinkSync(path, join(directory, 'linked.json'))
    expect(() => readServerRelease(join(directory, 'linked.json'))).toThrow('without links')
    writeFileSync(path, ' '.repeat(17 * 1024))
    expect(() => readServerRelease(path)).toThrow('bounded regular file')
  })

  it('creates a private release environment once and preserves existing deployment secrets', () => {
    const directory = folder(), output = join(directory, 'release.env'), runtime = join(directory, 'runtime.env')
    writeFileSync(runtime, 'POSTGRES_PASSWORD="keep-me"\n', { mode: 0o600 })
    writeServerReleaseEnvironment(release(), output)
    expect(statSync(output).mode & 0o777).toBe(0o600)
    expect(readFileSync(output, 'utf8')).toBe(serverReleaseEnvironment(release()))
    expect(() => writeServerReleaseEnvironment(release(), output)).toThrow('already exists')
    expect(() => writeServerReleaseEnvironment(release(), runtime)).toThrow('already exists')
    expect(readFileSync(runtime, 'utf8')).toBe('POSTGRES_PASSWORD="keep-me"\n')
    chmodSync(directory, 0o755)
    expect(() => writeServerReleaseEnvironment(release(), join(directory, 'another.env'))).toThrow('private directory')
  })

  it('removes every application build path in the prebuilt Compose override', () => {
    const source = readFileSync(new URL('../../deploy/single-host/prebuilt.yaml', import.meta.url), 'utf8')
    expect(source.match(/build: !reset null/g)).toHaveLength(2)
    expect(source).toContain('DM_COLLABORATION_IMAGE:?')
    expect(source).toContain('DM_WEB_IMAGE:?')
    expect(source.match(/platform: linux\/amd64/g)).toHaveLength(2)
    expect(source).not.toContain('context:')
    expect(source).toContain('  edge:')
    expect(source).not.toContain('  proxy:')
  })

  it('bootstraps only the official digest through Docker and never sources release environment files', () => {
    const directory = folder(), bin = join(directory, 'bin'), runtime = join(directory, 'runtime'), manifest = join(directory, 'server-release.json'), log = join(directory, 'docker-args.txt')
    const mkdir = spawnSync('mkdir', ['-p', bin, runtime]); expect(mkdir.status).toBe(0)
    writeFileSync(manifest, JSON.stringify(release(), null, 2) + '\n')
    writeFileSync(join(directory, 'SHA256SUMS'), 'published checksums are verified by the real sha256sum on the VPS\n')
    writeFileSync(join(runtime, 'release.env'), '$(touch should-never-run)\n')
    for (const [name, body] of Object.entries({
      id: '#!/bin/sh\nprintf "0\\n"\n',
      sha256sum: '#!/bin/sh\nexit 0\n',
      docker: '#!/bin/sh\nprintf "%s\\n" "$@" > "$DM_DOCKER_TEST_LOG"\n',
    })) writeFileSync(join(bin, name), body, { mode: 0o755 })
    const run = () => spawnSync('sh', [resolve('scripts/server-operator.sh'), directory, runtime, 'manifest'], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DM_DOCKER_TEST_LOG: log } })
    expect(run().status).toBe(0)
    const args = readFileSync(log, 'utf8')
    expect(args).toContain('--network\nnone')
    expect(args).toContain('--read-only')
    expect(args).toContain(release().images.operator)
    expect(args).toContain('scripts/check-server-release.mjs')
    expect(args).not.toContain('touch')
    writeFileSync(manifest, JSON.stringify({ ...release(), images: { ...release().images, operator: 'ghcr.io/vezy/draftmatter-operator:latest' } }, null, 2))
    expect(run().status).toBe(1)
    writeFileSync(manifest, JSON.stringify(release(), null, 2))
    writeFileSync(join(bin, 'sha256sum'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    expect(run().status).toBe(1)
  })

  it('initializes a matching release without touching an existing deployment or rotating credentials', () => {
    const directory = folder(), manifest = join(directory, 'server-release.json'), runtime = join(directory, 'runtime')
    writeFileSync(manifest, JSON.stringify(release()))
    const result = installServerRelease(manifest, { directory: runtime, rehearsal: true, project: 'draftmatter-rehearsal-release-test' })
    expect(result.commit).toBe(release().commit)
    expect(checkInstalledServerRelease(manifest, runtime)).toMatchObject({ rehearsal: true, commit: release().commit })
    const before = readFileSync(join(runtime, 'runtime.env'), 'utf8')
    expect(() => installServerRelease(manifest, { directory: runtime, rehearsal: true })).toThrow('Refusing to overwrite')
    expect(readFileSync(join(runtime, 'runtime.env'), 'utf8')).toBe(before)
    writeFileSync(join(runtime, 'release.env'), serverReleaseEnvironment(release()) + 'NODE_OPTIONS="--inspect"\n', { mode: 0o600 })
    expect(() => checkInstalledServerRelease(manifest, runtime)).toThrow('does not match')
    writeFileSync(join(runtime, 'release.env'), serverReleaseEnvironment(release()), { mode: 0o600 })
    writeFileSync(manifest, JSON.stringify({ ...release(), commit: 'c'.repeat(40) }))
    expect(() => checkInstalledServerRelease(manifest, runtime)).toThrow('another server release')
  })
})
