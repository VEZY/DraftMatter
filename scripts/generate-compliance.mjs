import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const verifyOnly = process.argv.includes('--verify')
const allowlist = new Set(JSON.parse(readFileSync(join(root, 'compliance/license-allowlist.json'), 'utf8')))
const licenseAliases = new Map([
  ['Public Domain', 'LicenseRef-Public-Domain'],
])

function command(commandName, args) {
  return execFileSync(commandName, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function rustHost() {
  const details = command('rustc', ['-vV'])
  const host = details.match(/^host:\s*(.+)$/m)?.[1]
  if (!host) throw new Error('rustc did not report its host target.')
  return host.trim()
}

function cargoMetadata(target) {
  const args = ['metadata', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--format-version', '1', '--filter-platform', target]
  try {
    return JSON.parse(command('cargo', [...args, '--offline']))
  } catch {
    return JSON.parse(command('cargo', args))
  }
}

function npmName(path, value) {
  if (value.name) return value.name
  const marker = 'node_modules/'
  const start = path.lastIndexOf(marker)
  return start >= 0 ? path.slice(start + marker.length) : path
}

function npmComponents() {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
  const unique = new Map()
  for (const [path, value] of Object.entries(lock.packages ?? {})) {
    if (!path || !value.version) continue
    const name = npmName(path, value)
    const key = `npm:${name}@${value.version}`
    if (!unique.has(key)) unique.set(key, {
      ecosystem: 'npm',
      name,
      version: value.version,
      license: value.license ?? 'NOASSERTION',
      scope: value.dev ? 'development' : 'required',
      source: value.resolved ?? 'package-lock.json',
      purl: `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(value.version)}`,
    })
  }
  return [...unique.values()]
}

function cargoComponents(target) {
  const metadata = cargoMetadata(target)
  const resolved = new Set(metadata.resolve?.nodes?.map((node) => node.id) ?? metadata.packages.map((pkg) => pkg.id))
  return metadata.packages
    .filter((pkg) => resolved.has(pkg.id) && pkg.name !== 'draftmatter')
    .map((pkg) => ({
      ecosystem: 'cargo',
      name: pkg.name,
      version: pkg.version,
      license: pkg.license ?? 'NOASSERTION',
      scope: 'required',
      source: pkg.source ?? relative(root, pkg.manifest_path),
      purl: `pkg:cargo/${encodeURIComponent(pkg.name)}@${encodeURIComponent(pkg.version)}`,
    }))
}

function licenseTokens(expression) {
  expression = normalizedLicense(expression)
  if (expression === 'NOASSERTION') return ['NOASSERTION']
  return expression
    .replaceAll('/', ' OR ')
    .match(/[A-Za-z0-9][A-Za-z0-9.+-]*/g)
    ?.filter((token) => !['AND', 'OR', 'WITH'].includes(token)) ?? []
}

function normalizedLicense(expression) {
  return (licenseAliases.get(expression) ?? expression).replaceAll('/', ' OR ')
}

function verifyLicenses(components) {
  const failures = []
  for (const component of components) {
    const rejected = licenseTokens(component.license).filter((license) => !allowlist.has(license))
    if (rejected.length) failures.push(`${component.ecosystem}:${component.name}@${component.version} — ${component.license} (unapproved: ${rejected.join(', ')})`)
  }
  if (failures.length) {
    throw new Error(`Dependency license review failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`)
  }
}

function notices(components, target) {
  const lines = [
    '# DraftMatter third-party notices',
    '',
    `Generated from locked dependency metadata for \`${target}\`.`,
    '',
    'DraftMatter is licensed under MIT. The following third-party packages retain their own licences. SPDX expressions are recorded exactly as supplied by their package metadata; distribution review must also retain any package-specific notice or attribution files.',
    '',
    '| Ecosystem | Package | Version | SPDX licence | Scope |',
    '| --- | --- | --- | --- | --- |',
    ...components.map((component) => `| ${component.ecosystem} | ${component.name.replaceAll('|', '\\|')} | ${component.version} | ${component.license.replaceAll('|', '\\|')} | ${component.scope} |`),
    '',
  ]
  return lines.join('\n')
}

function cyclonedx(components, target) {
  const bomComponents = components.map((component) => ({
    type: 'library',
    'bom-ref': component.purl,
    name: component.name,
    version: component.version,
    scope: component.scope,
    licenses: [{ expression: normalizedLicense(component.license) }],
    purl: component.purl,
    externalReferences: component.source.startsWith('http') ? [{ type: 'distribution', url: component.source }] : undefined,
    properties: [
      { name: 'draftmatter:ecosystem', value: component.ecosystem },
      { name: 'draftmatter:target', value: target },
    ],
  }))
  const fingerprint = createHash('sha256').update(JSON.stringify(bomComponents)).digest('hex')
  return `${JSON.stringify({
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      component: { type: 'application', name: 'DraftMatter', version: '0.1.0', licenses: [{ expression: 'MIT' }] },
      properties: [
        { name: 'draftmatter:target', value: target },
        { name: 'draftmatter:dependency-fingerprint', value: `sha256:${fingerprint}` },
      ],
    },
    components: bomComponents,
  }, null, 2)}\n`
}

const target = rustHost()
const components = [...npmComponents(), ...cargoComponents(target)]
  .sort((left, right) => left.ecosystem.localeCompare(right.ecosystem) || left.name.localeCompare(right.name) || left.version.localeCompare(right.version))
verifyLicenses(components)

if (!verifyOnly) {
  writeFileSync(join(root, 'compliance/THIRD_PARTY_NOTICES.md'), notices(components, target))
  writeFileSync(join(root, 'compliance/sbom.cdx.json'), cyclonedx(components, target))
}

process.stdout.write(`Compliance inventory verified: ${components.length} locked components for ${target}.\n`)
