import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const [artifactDir, installerDir, metadataDir] = process.argv.slice(2)
if (!metadataDir) throw new Error('Usage: prepare-release-metadata.mjs <workflow-artifacts> <release-installers> <output>')
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const targets = ['x86_64-unknown-linux-gnu', 'x86_64-pc-windows-msvc', 'aarch64-apple-darwin', 'x86_64-apple-darwin']

// These files come from the draft release itself, where Tauri has already applied its naming pattern.
const installers = await readdir(installerDir)
for (const suffix of ['linux_amd64_deb.deb', 'linux_amd64_appimage.AppImage', 'windows_x64_nsis.exe', 'windows_x64_msi.msi', 'darwin_x64_dmg.dmg', 'darwin_aarch64_dmg.dmg']) {
  const name = `DraftMatter_${version}_${suffix}`
  if (!installers.includes(name)) throw new Error(`Missing installer in the draft release: ${name}`)
}
const files = new Map(installers.map((name) => [name, join(installerDir, name)]))
await mkdir(metadataDir)

async function stage(artifact, sourceName, releaseName) {
  if (files.has(releaseName)) throw new Error(`Duplicate release asset: ${releaseName}`)
  const destination = join(metadataDir, releaseName)
  await copyFile(join(artifactDir, artifact, sourceName), destination)
  files.set(releaseName, destination)
}

for (const target of targets) {
  const inventory = `draftmatter-${target}-compliance`
  for (const name of ['THIRD_PARTY_NOTICES.md', 'sbom.cdx.json']) {
    await stage(inventory, name, `${inventory}-${name}`)
  }
  const artifact = `draftmatter-${target}-agent-host`
  const host = target.includes('windows') ? 'draftmatter-agent-host.exe' : 'draftmatter-agent-host'
  await stage(artifact, host, `${artifact}-${host}`)
}
const cli = `draftmatter-${version}.tgz`
await stage('draftmatter-cli', cli, cli)

const checksums = []
for (const name of [...files.keys()].sort()) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(files.get(name))) hash.update(chunk)
  checksums.push(`${hash.digest('hex')}  ${name}\n`)
}
await writeFile(join(metadataDir, 'SHA256SUMS'), checksums.join(''), 'utf8')
