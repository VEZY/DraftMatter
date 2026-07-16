/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync('.github/workflows/desktop-release.yml', 'utf8')
const portabilityWorkflow = readFileSync('.github/workflows/desktop-portability.yml', 'utf8')
const version = JSON.parse(readFileSync('package.json', 'utf8')).version as string

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
    expect(workflow).toContain('codesign --verify --deep --strict')
    expect(workflow).toContain('spctl --assess --type execute')
    expect(workflow).toContain('xcrun stapler validate')
    expect(workflow).toContain('signtool verify /pa /all /v')
    expect(workflow).toContain('release-metadata/SHA256SUMS')
    for (const secret of [
      'APPLE_CERTIFICATE',
      'APPLE_SIGNING_IDENTITY',
      'APPLE_ID',
      'APPLE_TEAM_ID',
      'WINDOWS_CERTIFICATE',
      'WINDOWS_CERTIFICATE_THUMBPRINT',
    ]) expect(workflow).toContain(`secrets.${secret}`)
  })

  it('builds production bundles for every supported desktop architecture', () => {
    for (const target of [
      'x86_64-unknown-linux-gnu',
      'x86_64-pc-windows-msvc',
      'aarch64-apple-darwin',
      'x86_64-apple-darwin',
    ]) expect(workflow).toContain(target)
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
    expect(workflow).toContain("-name 'draftmatter-*.tgz'")
    expect(workflow).toContain('needs: [build, cli]')
  })
})
