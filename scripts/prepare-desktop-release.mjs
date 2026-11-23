import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const installers = {
  'aarch64-apple-darwin': { dmg: 'darwin_aarch64_dmg.dmg' },
  'x86_64-apple-darwin': { dmg: 'darwin_x64_dmg.dmg' },
  'x86_64-pc-windows-msvc': { nsis: 'windows_x64_nsis.exe', msi: 'windows_x64_msi.msi' },
  'aarch64-pc-windows-msvc': { nsis: 'windows_arm64_nsis.exe' },
  'x86_64-unknown-linux-gnu': { deb: 'linux_amd64_deb.deb', appimage: 'linux_amd64_appimage.AppImage' },
  'aarch64-unknown-linux-gnu': { deb: 'linux_arm64_deb.deb', appimage: 'linux_arm64_appimage.AppImage' },
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const writeJson = (path, data) => writeFileSync(path, JSON.stringify(data, null, 2) + '\n')

export function desktopInstallerNames(version) {
  return Object.values(installers).flatMap((formats) =>
    Object.values(formats).map((suffix) => `DraftMatter_${version}_${suffix}`))
}

export function checkVersion(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$/.test(version) || version.length > 100) {
    throw new Error('Expected a desktop release version such as 0.1.0-alpha.8.')
  }
  return version
}

// Only run in a disposable build checkout. Keep the distribution and its
// bundled CLI on the same identity without committing version bumps to main.
export function stageVersion(root, version) {
  checkVersion(version)
  const npmPath = join(root, 'package.json')
  const lockPath = join(root, 'package-lock.json')
  const tauriPath = join(root, 'src-tauri/tauri.conf.json')
  const pluginPath = join(root, 'integrations/plugins/draftmatter/.codex-plugin/plugin.json')
  const npm = readJson(npmPath)
  const lock = readJson(lockPath)
  const old = npm.version
  const plugin = readJson(pluginPath)
  const tauri = readJson(tauriPath)
  if (![lock.version, lock.packages[''].version, tauri.version, plugin.version].every((v) => v === old)) {
    throw new Error('Desktop package inputs disagree on the source version.')
  }
  const rustFiles = ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock'].map((path) => {
    const fullPath = join(root, path)
    const contents = readFileSync(fullPath, 'utf8')
    const pattern = /(^name = "draftmatter"\r?\nversion = ")([^"]+)(")/gm
    const matches = [...contents.matchAll(pattern)]
    if (matches.length !== 1 || matches[0][2] !== old) throw new Error(`Unexpected package version in ${path}.`)
    return [fullPath, contents.replace(pattern, (_, prefix, _old, suffix) => prefix + version + suffix)]
  })
  npm.version = lock.version = lock.packages[''].version = tauri.version = plugin.version = version
  for (const [path, data] of [[npmPath, npm], [lockPath, lock], [tauriPath, tauri], [pluginPath, plugin]]) writeJson(path, data)
  for (const [path, contents] of rustFiles) writeFileSync(path, contents)
}

export function bundleConfig(version, revision) {
  const core = checkVersion(version).split('-')[0]
  const [major, minor, patch] = core.split('.').map(Number)
  if (major > 255 || minor > 255 || patch > 65535 || !Number.isInteger(revision) || revision < 1 || revision > 65535) {
    throw new Error('The desktop version exceeds native package limits.')
  }
  // MSI ignores a fourth field. Use main's first-parent commit height in
  // the third field so upgrades from one alpha to the next are recognized.
  return {
    bundle: {
      externalBin: ['binaries/draftmatter-mcp'],
      windows: { wix: { version: `${major}.${minor}.${revision}` } },
      macOS: {
        bundleVersion: `${1 + Math.floor(revision / 10000)}.${Math.floor(revision / 100) % 100}.${revision % 100}`,
        infoPlist: 'Info.release.plist',
      },
    },
  }
}

export function stageInstallers(root, target, version, output) {
  checkVersion(version)
  if (!Object.hasOwn(installers, target)) throw new Error('Unsupported desktop release target.')
  const bundle = join(root, 'src-tauri/target', target, 'release/bundle')
  mkdirSync(output)
  for (const [format, suffix] of Object.entries(installers[target])) {
    const dir = join(bundle, format)
    const extension = suffix.slice(suffix.lastIndexOf('.'))
    const matches = readdirSync(dir, { withFileTypes: true }).filter((file) => file.isFile() && file.name.endsWith(extension))
    if (matches.length !== 1) throw new Error(`Expected exactly one ${format} package in ${dir}.`)
    copyFileSync(join(dir, matches[0].name), join(output, `DraftMatter_${version}_${suffix}`))
  }
  if (target.endsWith('-apple-darwin')) {
    const arch = target.startsWith('aarch64') ? 'aarch64' : 'x64'
    execFileSync('tar', ['-czf', resolve(output, `DraftMatter_${version}_darwin_${arch}_app.app.tar.gz`), '-C', join(bundle, 'macos'), 'DraftMatter.app'])
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, target, output] = process.argv.slice(2)
  const root = process.cwd()
  const version = process.env.DESKTOP_RELEASE_VERSION || readJson(join(root, 'package.json')).version
  if (command === 'stage-version') stageVersion(root, version)
  else if (command === 'config') {
    if (execFileSync('git', ['rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).trim() !== 'false') throw new Error('Native versions require the complete commit history.')
    const revision = Number(execFileSync('git', ['rev-list', '--first-parent', '--count', 'HEAD'], { encoding: 'utf8' }).trim())
    const config = bundleConfig(version, revision)
    writeJson(join(root, 'src-tauri/tauri.release.conf.json'), config)
    const core = version.split('-')[0]
    writeFileSync(join(root, 'src-tauri/Info.release.plist'),
      `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${core}</string></dict></plist>\n`)
  } else if (command === 'stage-installers') stageInstallers(root, target, version, output)
  else throw new Error('Use stage-version, config or stage-installers <target> <output>.')
}
