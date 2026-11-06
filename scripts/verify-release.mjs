import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const packageLock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'))
const tauri = JSON.parse(readFileSync(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8'))
const cargo = readFileSync(resolve(root, 'src-tauri/Cargo.toml'), 'utf8')
const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
const plugin = JSON.parse(readFileSync(resolve(root, 'integrations/plugins/draftmatter/.codex-plugin/plugin.json'), 'utf8'))
const sdkVersion = packageJson.dependencies?.['@modelcontextprotocol/sdk']
const securityExceptions = JSON.parse(readFileSync(resolve(root, 'compliance/security-exceptions.json'), 'utf8'))
const versions = new Map([
  ['package.json', packageJson.version],
  ['package-lock.json', packageLock.version],
  ['package-lock root package', packageLock.packages?.['']?.version],
  ['tauri.conf.json', tauri.version],
  ['Cargo.toml', cargoVersion],
])
const expected = packageJson.version
const failures = [...versions].filter(([, version]) => version !== expected)

const rawTag = process.env.RELEASE_TAG || (process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : '') || ''
if (rawTag && rawTag !== `v${expected}`) failures.push(['release tag', `${rawTag} (expected v${expected})`])
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expected)) failures.push(['application version', `${expected} (not SemVer)`])
if (tauri.bundle?.active !== true) failures.push(['Tauri bundle', 'disabled'])
if (tauri.bundle?.targets !== 'all') failures.push(['Tauri bundle targets', String(tauri.bundle?.targets)])
if (tauri.bundle?.windows?.nsis?.installerHooks !== './windows/installer-hooks.nsh') {
  failures.push(['Windows terminal launcher', 'NSIS installer hook is not configured'])
}
if (!existsSync(resolve(root, 'src-tauri/windows/installer-hooks.nsh'))) {
  failures.push(['Windows terminal launcher', 'installer hook file is missing'])
}
if (plugin.version !== expected) failures.push(['Codex plugin manifest', plugin.version])
const lockedSdk = packageLock.packages?.['node_modules/@modelcontextprotocol/sdk']?.version
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(sdkVersion) || lockedSdk !== sdkVersion) {
  failures.push(['MCP SDK pin', `package.json must pin the exact locked version (${lockedSdk ?? 'missing'})`])
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value)
}

const today = new Date().toISOString().slice(0, 10)
if (securityExceptions.schemaVersion !== 1 || !Array.isArray(securityExceptions.exceptions)) {
  failures.push(['Dependency security exceptions', 'invalid registry'])
} else {
  for (const entry of securityExceptions.exceptions) {
    const label = `Security exception ${entry?.advisory ?? '(missing advisory)'}`
    if (!entry?.advisory || !entry.package || !entry.scope?.trim() || entry.transportExposed !== false ||
        !['low', 'moderate'].includes(entry.severity)) {
      failures.push([label, 'must identify a scoped, unexposed, low or moderate advisory'])
      continue
    }
    const packagePath = `node_modules/${entry.package}`
    const affectedVersionInstalled = Object.entries(packageLock.packages).some(([path, pkg]) =>
      (path === packagePath || path.endsWith(`/${packagePath}`)) && pkg.version === entry.affectedInstalledVersion)
    if (!affectedVersionInstalled) failures.push([label, 'affected version is absent from the lockfile'])
    if (!validDate(entry.reviewedOn) || !validDate(entry.reviewBy) ||
        entry.reviewedOn > today || entry.reviewBy < entry.reviewedOn || today > entry.reviewBy) {
      failures.push([label, `invalid or expired review period (${entry.reviewedOn} to ${entry.reviewBy})`])
    }
  }
}

if (failures.length) {
  console.error('Release identity verification failed:')
  for (const [source, version] of failures) console.error(`- ${source}: ${version ?? 'missing'}`)
  process.exitCode = 1
} else {
  console.log(`Release identity verified: DraftMatter v${expected} across npm, Cargo, and Tauri.`)
}
