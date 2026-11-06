/// <reference types="node" />

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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

  it('builds candidates and draft releases without paid publisher credentials', () => {
    expect(workflow).toContain("tags:\n      - 'v*.*.*'")
    expect(workflow).toContain('Build unsigned release candidate bundles')
    expect(workflow).toContain('Build release bundles without publisher signing into a draft release')
    expect(workflow).toContain('releaseDraft: true')
    expect(workflow).toContain('docs/installation.md')
    expect(workflow).toContain('Windows installers are unsigned')
    expect(workflow).toContain("if: matrix.platform == 'macos-latest'\n        shell: bash\n        run: bash scripts/verify-release-dmg.sh")
    expect(workflow).toContain("if: matrix.platform == 'windows-latest'\n        shell: pwsh\n        run: ./scripts/verify-release-windows.ps1")
    expect(workflow).not.toMatch(/signing-policy|notarize-release-dmg|signtool|notarytool/)
    expect(workflow).not.toMatch(/secrets\.(APPLE_|WINDOWS_CERTIFICATE)/)
    const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'))
    expect(config.bundle.macOS.signingIdentity).toBe('-')
    expect(config.bundle.windows.certificateThumbprint).toBeUndefined()
  })

  it.skipIf(process.platform === 'win32')('checks the app on the mounted DMG and detaches after success or failure', () => {
    const root = mkdtempSync(join(tmpdir(), 'draftmatter-dmg-check-'))
    try {
      const tools = join(root, 'mac-tools.sh')
      writeFileSync(tools, `stat() { if [[ -d "$3/DraftMatter.app" ]]; then echo 2; else echo 1; fi; }
hdiutil() {
  case "$1" in
    attach)
      [[ "$2 $3 $4" == '-readonly -nobrowse -mountpoint' && -f "$6" ]] || return 2
      mkdir "$5/DraftMatter.app"
      ;;
    detach) rmdir "$2/DraftMatter.app" ;;
    *) return 2 ;;
  esac
}
codesign() {
  if [[ "$1" == --verify ]]; then
    [[ "$2 $3" == '--deep --strict' && -d "$4" && "$4" == "$TMPDIR"/draftmatter-dmg.*/DraftMatter.app && "$CASE" != damaged ]]
  else
    [[ "$1 $2" == '--display --verbose=4' && -d "$3" ]] || return 2
    if [[ "$CASE" == signed ]]; then echo Authority=Developer-ID; else echo Signature=adhoc; fi
  fi
}
`)
      const check = (mode: string) => spawnSync('bash', ['scripts/verify-release-dmg.sh', root], {
        env: { ...process.env, TMPDIR: root, BASH_ENV: tools, CASE: mode }, encoding: 'utf8',
      })
      expect(check('valid').stderr).toContain('Expected one release DMG')
      writeFileSync(join(root, 'DraftMatter.dmg'), '')
      const valid = check('valid')
      expect(valid.status, valid.stderr).toBe(0)
      for (const invalid of ['damaged', 'signed']) expect(check(invalid).status).toBe(1)
      expect(readdirSync(root).sort()).toEqual(['DraftMatter.dmg', 'mac-tools.sh'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== 'win32')('requires both unsigned Windows formats and rejects other signature statuses', () => {
    const root = mkdtempSync(join(tmpdir(), 'draftmatter-windows-check-'))
    try {
      mkdirSync(join(root, 'nsis'))
      mkdirSync(join(root, 'msi'))
      writeFileSync(join(root, 'nsis', 'DraftMatter-setup.exe'), '')
      const check = (msiStatus: string) => spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `
        function Get-AuthenticodeSignature([string]$LiteralPath) {
          $status = if ($LiteralPath -like '*.msi') { $env:TEST_MSI_STATUS } else { 'NotSigned' }
          [pscustomobject]@{ Status = $status }
        }
        & ./scripts/verify-release-windows.ps1 -BundleRoot $env:TEST_BUNDLE
      `], { env: { ...process.env, TEST_BUNDLE: root, TEST_MSI_STATUS: msiStatus }, encoding: 'utf8' })
      expect(check('NotSigned').stderr).toContain('Expected one *.msi installer')
      writeFileSync(join(root, 'msi', 'DraftMatter.msi'), '')
      const valid = check('NotSigned')
      expect(valid.status, valid.stderr).toBe(0)
      expect(valid.stdout).toContain('DraftMatter-setup.exe: NotSigned')
      expect(valid.stdout).toContain('DraftMatter.msi: NotSigned')
      for (const status of ['Valid', 'UnknownError']) expect(check(status).status).toBe(1)
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
