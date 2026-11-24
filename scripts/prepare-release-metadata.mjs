import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { checkVersion, desktopInstallerNames, installers as platformInstallers } from './prepare-desktop-release.mjs'

const [artifactDir, installerDir, metadataDir] = process.argv.slice(2)
if (!metadataDir) throw new Error('Usage: prepare-release-metadata.mjs <workflow-artifacts> <release-installers> <output>')
const version = checkVersion(process.env.DESKTOP_RELEASE_VERSION || JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version)
const commit = process.env.GITHUB_SHA
if (!/^[a-f0-9]{40}$/.test(commit ?? '')) throw new Error('Expected the source commit of this build.')
const targets = Object.keys(platformInstallers)

const installers = await readdir(installerDir)
const expectedInstallers = desktopInstallerNames(version)
const appArchives = ['x64', 'aarch64'].map((arch) => `DraftMatter_${version}_darwin_${arch}_app.app.tar.gz`)
const expectedFiles = [...expectedInstallers, ...appArchives]
for (const name of expectedFiles) {
  if (!installers.includes(name)) throw new Error(`Missing installer in the candidate: ${name}`)
}
if (installers.length !== expectedFiles.length) throw new Error('Unexpected installer in the candidate.')
const files = new Map()
await mkdir(metadataDir)

async function stageFile(source, releaseName) {
  if (files.has(releaseName)) throw new Error(`Duplicate release asset: ${releaseName}`)
  if (!(await stat(source)).size) throw new Error(`Empty release asset: ${releaseName}`)
  const destination = join(metadataDir, releaseName)
  await copyFile(source, destination)
  files.set(releaseName, destination)
}
for (const name of installers) await stageFile(join(installerDir, name), name)

for (const target of targets) {
  const inventory = `draftmatter-${target}-compliance`
  for (const name of ['THIRD_PARTY_NOTICES.md', 'sbom.cdx.json']) {
    await stageFile(join(artifactDir, inventory, name), `${inventory}-${name}`)
  }
}
const cli = `draftmatter-${version}.tgz`
await stageFile(join(artifactDir, 'draftmatter-cli', cli), cli)
const manifest = 'desktop-release.json'
await writeFile(join(metadataDir, manifest), JSON.stringify({ version, commit, installers: expectedInstallers }, null, 2) + '\n')
files.set(manifest, join(metadataDir, manifest))

const checksums = []
for (const name of [...files.keys()].sort()) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(files.get(name))) hash.update(chunk)
  checksums.push(`${hash.digest('hex')}  ${name}\n`)
}
await writeFile(join(metadataDir, 'SHA256SUMS-desktop'), checksums.join(''), 'utf8')
