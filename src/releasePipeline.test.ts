/// <reference types="node" />

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync('.github/workflows/desktop-release.yml', 'utf8').replace(/\r\n/g, '\n')
const portabilityWorkflow = readFileSync('.github/workflows/desktop-portability.yml', 'utf8').replace(/\r\n/g, '\n')
const desktopMain = readFileSync('src-tauri/src/main.rs', 'utf8')
const windowsInstallerHooks = readFileSync('src-tauri/windows/installer-hooks.nsh', 'utf8')
const tauriConfig = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')) as {
  bundle?: { windows?: { nsis?: { installerHooks?: string } } }
}
const version = JSON.parse(readFileSync('package.json', 'utf8')).version as string
const targets = ['x86_64-unknown-linux-gnu', 'x86_64-pc-windows-msvc', 'aarch64-apple-darwin', 'x86_64-apple-darwin']

describe('DM-P5-08 production release pipeline', () => {
  it('keeps npm, Cargo, Tauri, and a matching release tag on one version', () => {
    const matching = spawnSync(process.execPath, ['scripts/verify-release.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, RELEASE_TAG: `v${version}` },
      encoding: 'utf8',
    })
    expect(matching.status).toBe(0)
    expect(matching.stdout).toContain(`DraftMatter v${version}`)

    const mismatched = spawnSync(process.execPath, ['scripts/verify-release.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, RELEASE_TAG: 'v999.999.999' },
      encoding: 'utf8',
    })
    expect(mismatched.status).toBe(1)
    expect(mismatched.stderr).toContain(`expected v${version}`)
  })

  it('separates unsigned candidates from signed draft releases and verifies every signature class', () => {
    expect(workflow).toContain("tags:\n      - 'v*.*.*'")
    expect(workflow).toContain('Manual build: unsigned release-candidate policy applies.')
    expect(workflow).toContain('Build unsigned release candidate bundles')
    expect(workflow).toContain('Build signed release bundles into a draft release')
    expect(workflow).toContain('releaseDraft: true')
    expect(workflow).toContain('bash scripts/notarize-release-dmg.sh')
    expect(workflow).toContain('verify /pa /all /tw /v')
    expect(workflow).toContain('GH_REPO: ${{ github.repository }}')
    for (const secret of [
      'APPLE_CERTIFICATE',
      'APPLE_SIGNING_IDENTITY',
      'APPLE_ID',
      'APPLE_TEAM_ID',
      'WINDOWS_CERTIFICATE',
      'WINDOWS_CERTIFICATE_THUMBPRINT',
    ]) expect(workflow).toContain(`secrets.${secret}`)
  })

  it.skipIf(process.platform === 'win32')('publishes only an accepted, stapled DMG and verifies its downloaded bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'draftmatter-notary-'))
    const bin = join(root, 'bin')
    const remote = join(root, 'remote')
    const asset = `DraftMatter_${version}_darwin_x64_dmg.dmg`
    const localDmg = join(root, 'dmg', `DraftMatter_${version}_x64.dmg`)
    const verify = (env: Record<string, string> = {}) => {
      writeFileSync(localDmg, 'signed')
      return spawnSync('bash', ['scripts/notarize-release-dmg.sh', 'x86_64-apple-darwin', root], {
        env: { PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: root, GITHUB_REF_NAME: `v${version}`,
          APPLE_ID: 'test', APPLE_TEAM_ID: 'test', APPLE_PASSWORD: 'test', FAKE_REMOTE: remote, ...env },
        encoding: 'utf8',
      })
    }
    const mock = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o755 })
    try {
      for (const dir of [bin, remote, dirname(localDmg), join(root, 'macos/DraftMatter.app')]) mkdirSync(dir, { recursive: true })
      mock('codesign', 'test -e "${!#}"')
      mock('spctl', 'test -d "${!#}"')
      mock('xcrun', `case "$1 $2" in
  'notarytool submit') printf '{"id":"test","status":"%s"}' "\${NOTARY_STATUS:-Accepted}" ;;
  'stapler staple') printf '+ticket' >> "$3" ;;
  'stapler validate') [[ "$3" == *.app ]] || grep -q '+ticket' "$3" ;;
  *) exit 1 ;;
esac`)
      mock('gh', `case "$2" in
  view) echo "\${DRAFT:-true}" ;;
  upload) cp "$4" "$FAKE_REMOTE/" ;;
  download) mkdir "$7"; cp "$FAKE_REMOTE/$5" "$7/$5"; if [[ -n "\${CORRUPT:-}" ]]; then echo corrupt >> "$7/$5"; fi ;;
  *) exit 1 ;;
esac`)
      const rejectedEnvironments: Record<string, string>[] = [{ NOTARY_STATUS: 'Invalid' }, { DRAFT: 'false' }]
      for (const env of rejectedEnvironments) {
        const result = verify(env)
        expect(result.status).not.toBe(0)
        expect(existsSync(join(remote, asset))).toBe(false)
      }
      const accepted = verify()
      expect(accepted.status, accepted.stderr).toBe(0)
      expect(readFileSync(join(remote, asset), 'utf8')).toBe('signed+ticket')
      expect(verify({ CORRUPT: 'true' }).status).not.toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('builds production bundles for every supported desktop architecture', () => {
    for (const target of targets) expect(workflow).toContain(target)
    expect(workflow).toContain('--bundles deb,appimage')
    expect(workflow).toContain('--bundles nsis,msi')
    expect(workflow).toContain('--bundles app,dmg')
  })

  it('tests the standalone CLI on every platform and attaches one platform-neutral package', () => {
    expect(portabilityWorkflow).toContain('Build standalone clean-export CLI')
    expect(portabilityWorkflow).toContain('Test standalone clean-export CLI')
    expect(portabilityWorkflow).toContain('npm run test:cli')
    expect(workflow).toContain('Package platform-neutral CLI')
    expect(workflow).toContain('npm pack ./dist-cli --pack-destination release-cli')
    expect(workflow).toContain('needs: [build, cli]')
  })

  it('retains all platform files and checksums the bytes using final download names', () => {
    const root = mkdtempSync(join(tmpdir(), 'draftmatter-release-assets-'))
    const artifacts = join(root, 'artifacts')
    const installers = join(root, 'installers')
    const output = join(root, 'output')
    const expected = new Map<string, string>()
    const addArtifact = (directory: string, filename: string, releaseName: string) => {
      mkdirSync(directory, { recursive: true })
      const bytes = `fixture ${releaseName}\n`
      writeFileSync(join(directory, filename), bytes)
      expected.set(releaseName, bytes)
    }
    const prepare = () => spawnSync(process.execPath, ['scripts/prepare-release-metadata.mjs', artifacts, installers, output], { encoding: 'utf8' })
    try {
      for (const target of targets) {
        const inventory = `draftmatter-${target}-compliance`
        for (const filename of ['THIRD_PARTY_NOTICES.md', 'sbom.cdx.json']) {
          addArtifact(join(artifacts, inventory), filename, `${inventory}-${filename}`)
        }
        const host = `draftmatter-${target}-agent-host`
        const name = target.includes('windows') ? 'draftmatter-agent-host.exe' : 'draftmatter-agent-host'
        addArtifact(join(artifacts, host), name, `${host}-${name}`)
      }
      const cli = `draftmatter-${version}.tgz`
      addArtifact(join(artifacts, 'draftmatter-cli'), cli, cli)
      const installerNames = [
        'darwin_x64_dmg.dmg', 'darwin_aarch64_dmg.dmg', 'windows_x64_nsis.exe', 'windows_x64_msi.msi',
        'linux_amd64_deb.deb', 'linux_amd64_appimage.AppImage', 'darwin_aarch64_app.app.tar.gz',
      ].map((suffix) => `DraftMatter_${version}_${suffix}`)
      for (const name of installerNames.slice(1)) addArtifact(installers, name, name)
      expect(prepare().stderr).toContain(`Missing installer in the draft release: ${installerNames[0]}`)
      addArtifact(installers, installerNames[0], installerNames[0])
      const result = prepare()
      expect(result.status, result.stderr).toBe(0)
      const checksums = readFileSync(join(output, 'SHA256SUMS'), 'utf8').trimEnd().split('\n')
      expect(checksums).toHaveLength(expected.size)
      for (const [releaseName, bytes] of expected) {
        expect(checksums).toContain(`${createHash('sha256').update(bytes).digest('hex')}  ${releaseName}`)
        const dir = installerNames.includes(releaseName) ? installers : output
        expect(readFileSync(join(dir, releaseName), 'utf8')).toBe(bytes)
      }
      expect(readdirSync(output)).toHaveLength(14) // twelve platform assets, the CLI, and SHA256SUMS
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects an expired exception even when its severity, package and scope still match', () => {
    const root = mkdtempSync(join(tmpdir(), 'draftmatter-release-policy-'))
    try {
      for (const name of ['scripts/verify-release.mjs', 'package.json', 'package-lock.json',
        'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/windows/installer-hooks.nsh',
        'integrations/plugins/draftmatter/.codex-plugin/plugin.json']) {
        mkdirSync(dirname(join(root, name)), { recursive: true })
        copyFileSync(name, join(root, name))
      }
      const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
      const entry = {
        advisory: 'GHSA-xxxx-xxxx-xxxx', package: '@modelcontextprotocol/sdk',
        affectedInstalledVersion: lock.packages['node_modules/@modelcontextprotocol/sdk'].version,
        severity: 'moderate', scope: 'unused HTTP adapter', transportExposed: false,
        reviewedOn: '2000-01-01', reviewBy: '2000-01-02',
      }
      mkdirSync(join(root, 'compliance'))
      writeFileSync(join(root, 'compliance/security-exceptions.json'), JSON.stringify({ schemaVersion: 1, exceptions: [entry] }))
      const result = spawnSync(process.execPath, [join(root, 'scripts/verify-release.mjs')], { encoding: 'utf8' })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('expired review period')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('makes the installed application executable available from a terminal', () => {
    expect(desktopMain).toContain('run_cli_if_requested')
    expect(tauriConfig.bundle?.windows?.nsis?.installerHooks).toBe('./windows/installer-hooks.nsh')
    expect(windowsInstallerHooks).toContain('WriteRegExpandStr HKCU "Environment" "Path"')
    expect(windowsInstallerHooks).toContain('DeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\draftmatter.exe"')
    expect(workflow).toContain("installerHooks: './windows/installer-hooks.nsh'")
  })
})
