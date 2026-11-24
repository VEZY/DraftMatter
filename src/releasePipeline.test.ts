/// <reference types="node" />

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync('.github/workflows/desktop-release.yml', 'utf8').replace(/\r\n/g, '\n')
const tagWorkflow = readFileSync('.github/workflows/desktop-tag.yml', 'utf8').replace(/\r\n/g, '\n')
const portabilityWorkflow = readFileSync('.github/workflows/desktop-portability.yml', 'utf8').replace(/\r\n/g, '\n')
const desktopMain = readFileSync('src-tauri/src/main.rs', 'utf8')
const windowsInstallerHooks = readFileSync('src-tauri/windows/installer-hooks.nsh', 'utf8')
const tauriConfig = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')) as {
  bundle?: { windows?: { nsis?: { installerHooks?: string } } }
}
const version = JSON.parse(readFileSync('package.json', 'utf8')).version as string
const targets = ['x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu', 'x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc', 'aarch64-apple-darwin', 'x86_64-apple-darwin']

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
    expect(tagWorkflow).toContain("tags:\n      - 'v*.*.*'")
    expect(tagWorkflow).toContain('uses: ./.github/workflows/desktop-release.yml')
    expect(workflow).toContain('workflow_call:')
    expect(workflow).not.toContain('contents: write')
    expect(workflow).toContain('Build unsigned release candidate bundles')
    expect(tagWorkflow).toContain('--verify-tag --draft')
    expect(tagWorkflow).toContain('docs/installation.md')
    expect(tagWorkflow).toContain('Windows installers are unsigned')
    expect(workflow).toContain("if: runner.os == 'macOS'\n        shell: bash\n        run: bash scripts/verify-release-dmg.sh")
    expect(workflow).toContain("if: runner.os == 'Windows'\n        shell: pwsh\n        run: ./scripts/verify-release-windows.ps1")
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
      mkdir -p "$5/DraftMatter.app/Contents/MacOS"
      for name in draftmatter draftmatter-agent-host draftmatter-mcp; do
        if [[ "$CASE" == missing-host && "$name" == draftmatter-agent-host ]]; then continue; fi
        printf payload > "$5/DraftMatter.app/Contents/MacOS/$name"
        chmod +x "$5/DraftMatter.app/Contents/MacOS/$name"
      done
      ;;
    detach) rm -rf "$2/DraftMatter.app" ;;
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
      expect(check('missing-host').stderr).toContain('Contents/MacOS/draftmatter-agent-host')
      expect(readdirSync(root).sort()).toEqual(['DraftMatter.dmg', 'mac-tools.sh'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== 'win32')('requires both unsigned Windows formats and one copy of each expected MSI executable', () => {
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
      const msi = join(root, 'msi', 'DraftMatter.msi')
      const fileRows = [
        'App\tMain\tDRAFTM~1.EXE|draftmatter.exe\t128',
        'Host\tHost\tDMHOST~1.EXE|draftmatter-agent-host.exe\t64',
        'Mcp\tMcp\tDMMCP~1.EXE|draftmatter-mcp.exe\t96',
      ]
      const createMsi = (rows: string[]) => {
        rmSync(msi, { force: true })
        writeFileSync(join(root, 'File.idt'), [
          'File\tComponent_\tFileName\tFileSize', 's72\ts72\tl255\ti4', 'File\tFile', ...rows, '',
        ].join('\r\n'), 'ascii')
        const created = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `
          $ErrorActionPreference = 'Stop'
          $engine = New-Object -ComObject WindowsInstaller.Installer
          $db = $engine.OpenDatabase($env:TEST_MSI, 3)
          $db.Import($env:TEST_BUNDLE, 'File.idt')
          $db.Commit()
        `], { env: { ...process.env, TEST_BUNDLE: root, TEST_MSI: msi }, encoding: 'utf8' })
        expect(created.status, created.stderr).toBe(0)
      }
      createMsi(fileRows)
      const valid = check('NotSigned')
      expect(valid.status, valid.stderr).toBe(0)
      expect(valid.stdout).toContain('DraftMatter-setup.exe: NotSigned')
      expect(valid.stdout).toContain('DraftMatter.msi: NotSigned')
      expect(valid.stdout).toContain('MSI component Host: draftmatter-agent-host.exe (64 bytes)')
      for (const status of ['Valid', 'UnknownError']) expect(check(status).status).toBe(1)
      createMsi([...fileRows, 'Duplicate\tOtherHost\tDMHOST~2.EXE|draftmatter-agent-host.exe\t64'])
      expect(check('NotSigned').stderr).toContain('found 2 entries')
      createMsi(fileRows.filter((row) => !row.startsWith('Host\t')))
      expect(check('NotSigned').stderr).toContain('found 0 entries')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 45_000)

  it('builds production bundles for every supported desktop architecture', () => {
    for (const target of targets) expect(workflow).toContain(target)
    expect(workflow).toContain('--bundles deb,appimage')
    expect(workflow).toContain('--bundles nsis,msi')
    expect(workflow).toContain('--bundles app,dmg')
  })

  it('stages alpha identity, increasing native build numbers and versioned ARM installer names in a disposable checkout', () => {
    const root = mkdtempSync(join(tmpdir(), 'draftmatter-desktop-stage-'))
    try {
      for (const path of ['scripts/prepare-desktop-release.mjs', 'scripts/verify-release.mjs', 'package.json', 'package-lock.json',
        'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/tauri.conf.json', 'compliance/security-exceptions.json',
        'src-tauri/windows/installer-hooks.nsh', 'integrations/plugins/draftmatter/.codex-plugin/plugin.json']) {
        mkdirSync(dirname(join(root, path)), { recursive: true })
        copyFileSync(path, join(root, path))
      }
      const run = (command: string, args: string[], release: string) => {
        const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', env: {
          ...process.env, GITHUB_REF_TYPE: 'branch', RELEASE_TAG: '', DESKTOP_RELEASE_VERSION: release,
        } })
        expect(result.status, result.stderr).toBe(0)
        return result.stdout
      }
      run('git', ['init', '--quiet'], '')
      const revisions = []
      for (const release of ['0.1.0-alpha.9', '0.1.0-alpha.10']) {
        run('git', ['-c', 'user.name=builder', '-c', 'user.email=build@example.test', 'commit', '--quiet', '--allow-empty', '-m', release], '')
        run(process.execPath, ['scripts/prepare-desktop-release.mjs', 'stage-version'], release)
        expect(run(process.execPath, ['scripts/verify-release.mjs'], release)).toContain('v' + release)
        expect(readFileSync(join(root, 'src-tauri/Cargo.lock'), 'utf8')).toContain(`name = "draftmatter"\nversion = "${release}"`)
        run(process.execPath, ['scripts/prepare-desktop-release.mjs', 'config'], release)
        const { bundle } = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.release.conf.json'), 'utf8'))
        revisions.push([bundle.windows.wix.version, bundle.macOS.bundleVersion])
      }
      expect(revisions).toEqual([['0.1.1', '1.0.1'], ['0.1.2', '1.0.2']])
      const bundle = join(root, 'src-tauri/target/aarch64-unknown-linux-gnu/release/bundle')
      for (const [folder, file] of [['deb', 'DraftMatter_arm64.deb'], ['appimage', 'app_arm64.AppImage']]) {
        mkdirSync(join(bundle, folder), { recursive: true })
        writeFileSync(join(bundle, folder, file), 'test payload')
      }
      run(process.execPath, ['scripts/prepare-desktop-release.mjs', 'stage-installers', 'aarch64-unknown-linux-gnu', 'installers'], '0.1.0-alpha.10')
      expect(readdirSync(join(root, 'installers')).sort()).toEqual([
        'DraftMatter_0.1.0-alpha.10_linux_arm64_appimage.AppImage', 'DraftMatter_0.1.0-alpha.10_linux_arm64_deb.deb',
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('tests the standalone CLI on every platform and attaches one platform-neutral package', () => {
    expect(portabilityWorkflow).toContain('Build standalone clean-export CLI')
    expect(portabilityWorkflow).toContain('Test standalone clean-export CLI')
    expect(portabilityWorkflow).toContain('npm run test:cli')
    expect(workflow).toContain('Package platform-neutral CLI')
    expect(workflow).toContain('npm pack ./dist-cli --pack-destination release-cli')
    expect(workflow).toContain('needs: [build, cli]')
  })

  it('checksums the release downloads without requiring standalone execution hosts', () => {
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
    const commit = 'c'.repeat(40)
    const prepare = () => spawnSync(process.execPath, ['scripts/prepare-release-metadata.mjs', artifacts, installers, output], {
      encoding: 'utf8', env: { ...process.env, GITHUB_SHA: commit, DESKTOP_RELEASE_VERSION: version },
    })
    try {
      for (const target of targets) {
        const inventory = `draftmatter-${target}-compliance`
        for (const filename of ['THIRD_PARTY_NOTICES.md', 'sbom.cdx.json']) {
          addArtifact(join(artifacts, inventory), filename, `${inventory}-${filename}`)
        }
      }
      const cli = `draftmatter-${version}.tgz`
      addArtifact(join(artifacts, 'draftmatter-cli'), cli, cli)
      const installerNames = [
        'darwin_x64_dmg.dmg', 'darwin_aarch64_dmg.dmg', 'windows_x64_nsis.exe', 'windows_x64_msi.msi',
        'windows_arm64_nsis.exe', 'linux_amd64_deb.deb', 'linux_amd64_appimage.AppImage', 'linux_arm64_deb.deb', 'linux_arm64_appimage.AppImage',
        'darwin_aarch64_app.app.tar.gz', 'darwin_x64_app.app.tar.gz',
      ].map((suffix) => `DraftMatter_${version}_${suffix}`)
      for (const name of installerNames.slice(1)) addArtifact(installers, name, name)
      expect(prepare().stderr).toContain(`Missing installer in the candidate: ${installerNames[0]}`)
      addArtifact(installers, installerNames[0], installerNames[0])
      const result = prepare()
      expect(result.status, result.stderr).toBe(0)
      const manifest = readFileSync(join(output, 'desktop-release.json'), 'utf8')
      expect(JSON.parse(manifest)).toEqual({ version, commit, installers: expect.arrayContaining(installerNames.filter((name) => !name.endsWith('.tar.gz'))) })
      expected.set('desktop-release.json', manifest)
      const checksums = readFileSync(join(output, 'SHA256SUMS-desktop'), 'utf8').trimEnd().split('\n')
      expect(checksums).toHaveLength(expected.size)
      for (const [releaseName, bytes] of expected) {
        expect(checksums).toContain(`${createHash('sha256').update(bytes).digest('hex')}  ${releaseName}`)
        expect(readFileSync(join(output, releaseName), 'utf8')).toBe(bytes)
      }
      expect(readdirSync(output)).toHaveLength(expected.size + 1)
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
    expect(workflow).toContain('scripts/prepare-desktop-release.mjs config')
  })
})
