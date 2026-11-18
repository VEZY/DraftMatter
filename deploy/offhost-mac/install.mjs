import { constants } from 'node:fs'
import { access, copyFile, lstat, mkdir, readFile, readlink, realpath, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { readPullConfiguration } from './pull.mjs'
import { readBackupKey } from '../single-host/backup/crypto.mjs'

const sourceDirectory = dirname(fileURLToPath(import.meta.url))
export const BACKUP_AGENT_LABEL = 'fr.draftmatter.backup'
const xml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
const shell = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'"

export function backupLaunchAgent(runner, stdout, stderr) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${BACKUP_AGENT_LABEL}</string>
<key>ProgramArguments</key><array><string>/bin/sh</string><string>${xml(runner)}</string></array>
<key>RunAtLoad</key><true/>
<key>StartCalendarInterval</key><array>${[0, 4, 8, 12, 16, 20].map((hour) => `<dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>20</integer></dict>`).join('')}</array>
<key>ProcessType</key><string>Background</string>
<key>LowPriorityIO</key><true/>
<key>Nice</key><integer>10</integer>
<key>ThrottleInterval</key><integer>300</integer>
<key>StandardOutPath</key><string>${xml(stdout)}</string>
<key>StandardErrorPath</key><string>${xml(stderr)}</string>
</dict></plist>
`
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077) throw new Error('Choose a private directory without symbolic links (chmod 700).')
}

async function writeNew(path, content, mode = 0o600) {
  await writeFile(path, content, { flag: 'wx', mode })
}

/** Resolve existing ancestors too: the final private directory may not exist. */
async function canonicalProspectivePath(path) {
  const selected = resolve(path)
  try { return await realpath(selected) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    // A dangling ancestor symlink still has a destination. Treating it as a
    // missing ordinary directory would permit a later mkdir through iCloud.
    try {
      if ((await lstat(selected)).isSymbolicLink()) return canonicalProspectivePath(resolve(dirname(selected), await readlink(selected)))
    } catch (details) { if (details.code !== 'ENOENT') throw details }
    const parent = dirname(selected)
    if (parent === selected) throw error
    return join(await canonicalProspectivePath(parent), basename(selected))
  }
}

function isInside(path, parent) {
  // Conservatively cover the default case-insensitive macOS filesystem, even
  // for not-yet-created paths and when these checks run on case-sensitive CI.
  const child = resolve(path).normalize('NFC').toLowerCase()
  const root = resolve(parent).normalize('NFC').toLowerCase()
  return child === root || child.startsWith(root + sep)
}

async function privateLocations(home, paths) {
  const cloudRoots = [join(home, 'Library', 'Mobile Documents'), join(home, 'Library', 'CloudStorage'), join(home, 'Desktop'), join(home, 'Documents')]
  const canonicalRoots = await Promise.all(cloudRoots.map(canonicalProspectivePath))
  const result = []
  for (const path of paths) {
    const canonical = await canonicalProspectivePath(path)
    if (cloudRoots.some((root) => isInside(path, root)) || canonicalRoots.some((root) => isInside(canonical, root))) throw new Error('Keep backup archives, keys and private configuration outside Desktop, Documents, iCloud Drive and cloud-provider folders.')
    result.push(canonical)
  }
  return result
}

/** Prepare files only. The operator verifies a real pull before enabling launchd. */
export async function prepareMacBackup(configFile, options = {}) {
  const run = options.run ?? ((program, args) => spawnSync(program, args, { encoding: 'utf8', timeout: 20_000, maxBuffer: 16 * 1024 }))
  if ((options.platform ?? process.platform) !== 'darwin') throw new Error('This installer is for the backup Mac.')
  const home = options.homeDirectory ?? homedir()
  const node = options.nodeExecutable ?? process.execPath
  if (!isAbsolute(node) || !isAbsolute(home)) throw new Error('Use absolute installation and Node paths.')
  await access(node, constants.X_OK)
  const version = run(node, ['--version'])
  const number = /^v(\d+)\.(\d+)\.(\d+)\s*$/.exec(version.stdout ?? '')?.slice(1).map(Number)
  if (version.status !== 0 || !number || number[0] !== 24 || number[1] < 22 || number[1] === 22 && number[2] < 3) {
    throw new Error('Install Node.js 24.22.3 or a newer Node 24 patch before scheduling backups.')
  }
  const fileVault = run('/usr/bin/fdesetup', ['status'])
  if (fileVault.status !== 0 || !/^FileVault is On\./m.test(fileVault.stdout ?? '')) throw new Error('Enable FileVault on the backup Mac before copying research archives or recovery keys.')
  const configPath = resolve(configFile)
  const supportPath = join(home, 'Library', 'Application Support', 'DraftMatter Backup')
  const agentsPath = join(home, 'Library', 'LaunchAgents')
  const [canonicalConfigPath, support, agents] = await privateLocations(home, [configPath, supportPath, agentsPath])
  const config = await readPullConfiguration(configPath)
  const originalInputs = [config.identityFile, config.knownHostsFile, config.keyFile]
  const [destination, identityFile, knownHostsFile, keyFile] = await privateLocations(home, [config.directory, ...originalInputs])
  const installedConfig = join(support, 'config.json')
  if (canonicalConfigPath === installedConfig && (config.directory !== destination || originalInputs.some((path, index) => path !== [identityFile, knownHostsFile, keyFile][index]))) {
    throw new Error('Use physical paths in the existing installed configuration, or move the source configuration outside Application Support before installing. The existing file was preserved.')
  }
  for (const path of originalInputs) {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.mode & 0o077) throw new Error('Private backup inputs must be regular files without links (chmod 600).')
  }
  for (const path of [config.directory, supportPath]) {
    try { if ((await lstat(path)).isSymbolicLink()) throw new Error('Choose a private directory without symbolic links (chmod 700).') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  for (const path of [identityFile, knownHostsFile, keyFile, canonicalConfigPath]) {
    if (isInside(path, destination)) throw new Error('Keep SSH and decryption keys and private configuration outside the archive directory.')
  }
  const helper = join(support, 'deploy', 'offhost-mac')
  const crypto = join(support, 'deploy', 'single-host', 'backup')
  const physicalHelpers = await privateLocations(home, [helper, crypto])
  if (physicalHelpers[0] !== helper || physicalHelpers[1] !== crypto) throw new Error('Use a dedicated backup support directory without symbolic links inside it.')
  // Pin installed paths to the checked physical locations; do not later reuse
  // an alias whose ancestor could be redirected by a synchronisation utility.
  Object.assign(config, { directory: destination, identityFile, knownHostsFile, keyFile })
  await readBackupKey(config.keyFile)
  await privateDirectory(support)
  await privateDirectory(destination)
  await mkdir(agents, { recursive: true, mode: 0o700 })
  const plist = join(agents, `${BACKUP_AGENT_LABEL}.plist`)
  try { await lstat(plist); throw new Error('The backup agent already exists. Inspect the existing installation before replacing it.') }
  catch (error) { if (error.code !== 'ENOENT') throw error }

  // Exclude archives and decryption material before any archive can be pulled.
  for (const path of new Set([destination, support, config.keyFile, config.identityFile])) {
    const excluded = run('/usr/bin/tmutil', ['addexclusion', path])
    const status = excluded.status === 0 ? run('/usr/bin/tmutil', ['isexcluded', path]) : excluded
    if (status.status !== 0 || !/\[Excluded\]/.test(status.stdout ?? '')) throw new Error('Time Machine exclusion could not be confirmed. No backup schedule was enabled.')
  }

  await privateDirectory(helper)
  await privateDirectory(crypto)
  await copyFile(join(sourceDirectory, 'pull.mjs'), join(helper, 'pull.mjs'), constants.COPYFILE_EXCL)
  await copyFile(join(sourceDirectory, '../single-host/backup/crypto.mjs'), join(crypto, 'crypto.mjs'), constants.COPYFILE_EXCL)
  if (canonicalConfigPath !== installedConfig) await writeNew(installedConfig, JSON.stringify(config, null, 2) + '\n')
  const output = join(support, 'last-run.json')
  const errors = join(support, 'last-error.log')
  await writeNew(output, '')
  await writeNew(errors, '')
  const runner = join(support, 'run.sh')
  await writeNew(runner, `#!/bin/sh
umask 077
dm_notify_failure() {
  /usr/bin/osascript -e 'display notification "La sauvegarde DraftMatter a échoué. Consultez le dernier contrôle de sauvegarde." with title "DraftMatter Backup"' >/dev/null 2>&1 || true
}
dm_guard_failure() {
  printf '%s\\n' '{"status":"failed","error":"Backup safeguards could not be confirmed. Check FileVault, required paths and Time Machine exclusions."}' > ${shell(output)}
  printf '%s\\n' 'Backup safeguards could not be confirmed. Check FileVault, required paths and Time Machine exclusions.' > ${shell(errors)}
  dm_notify_failure
  exit 1
}
if ${shell(node)} ${shell(join(helper, 'pull.mjs'))} --prune --config ${shell(installedConfig)} > ${shell(output)} 2> ${shell(errors)}; then
  :
else
  dm_prune_status=$?
  dm_notify_failure
  exit "$dm_prune_status"
fi
if ! dm_filevault_status=$(/usr/bin/fdesetup status 2>/dev/null); then
  dm_guard_failure
fi
case "$dm_filevault_status" in
  'FileVault is On.') ;;
  *) dm_guard_failure ;;
esac
for dm_private_path in ${[destination, support, config.keyFile, config.identityFile].map(shell).join(' ')}; do
  if [ ! -e "$dm_private_path" ] || [ -L "$dm_private_path" ]; then
    dm_guard_failure
  fi
  if ! dm_exclusion_status=$(/usr/bin/tmutil isexcluded "$dm_private_path" 2>/dev/null); then
    dm_guard_failure
  fi
  case "$dm_exclusion_status" in
    '[Excluded]'*) ;;
    *) dm_guard_failure ;;
  esac
done
if ${shell(node)} ${shell(join(helper, 'pull.mjs'))} --config ${shell(installedConfig)} > ${shell(output)} 2> ${shell(errors)}; then
  exit 0
else
  dm_pull_status=$?
fi
dm_notify_failure
exit "$dm_pull_status"
`, 0o700)
  await writeNew(plist, backupLaunchAgent(runner, output, errors))
  return { status: 'prepared', enabled: false, node, support, config: installedConfig, helper: join(helper, 'pull.mjs'), plist,
    next: 'Run the installed helper once and verify a successful authenticated copy before enabling this launch agent.' }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2)
    if (args.length !== 2 && args.length !== 4 || args[0] !== '--config' || args.length === 4 && args[2] !== '--node') throw new Error('Usage: install.mjs --config PRIVATE_CONFIG.json [--node ABSOLUTE_NODE_PATH]')
    const result = await prepareMacBackup(args[1], { nodeExecutable: args[3] })
    process.stdout.write(JSON.stringify(result) + '\n')
  } catch (error) {
    const controlled = error instanceof Error && !error.code ? error.message : 'Preparation failed. Check private input files and the existing installation; no schedule was enabled.'
    process.stderr.write(JSON.stringify({ status: 'failed', error: controlled }) + '\n')
    process.exitCode = 1
  }
}
