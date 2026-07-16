import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const packageLock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'))
const tauri = JSON.parse(readFileSync(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8'))
const cargo = readFileSync(resolve(root, 'src-tauri/Cargo.toml'), 'utf8')
const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
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

if (failures.length) {
  console.error('Release identity verification failed:')
  for (const [source, version] of failures) console.error(`- ${source}: ${version ?? 'missing'}`)
  process.exitCode = 1
} else {
  console.log(`Release identity verified: DraftMatter v${expected} across npm, Cargo, and Tauri.`)
}
