#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { request as httpsRequest } from 'node:https'
import { chmod, copyFile, lstat, mkdir, readdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { resolve, dirname, join, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { readSingleHostEnvironment, validateSingleHostEnvironment, repositoryRoot } from './single-host-config.mjs'
import { serializeEnvironment } from './init-single-host.mjs'
import { assertRestoreTarget } from '../deploy/single-host/backup/backup.mjs'

class RehearsalError extends Error {
  constructor(message) { super(message); this.name = 'RehearsalError' }
}

const composeFile = join(repositoryRoot, 'deploy/single-host/compose.yaml')
const rehearsalFile = join(repositoryRoot, 'deploy/single-host/rehearsal.yaml')
const backupScript = join(repositoryRoot, 'deploy/single-host/backup/backup.mjs')
const smokeScript = join(repositoryRoot, 'scripts/smoke-single-host.mjs')

/** The mutating exercise is restricted to a loopback-only, private fixture. */
export function rehearsalSettings(environment, file) {
  if (environment.DM_SINGLE_HOST_MODE !== 'rehearsal' || environment.BIND_ADDRESS !== '127.0.0.1' ||
      environment.HTTP_PORT !== '8088' || environment.HTTPS_PORT !== '8443') {
    throw new RehearsalError('Only the isolated loopback rehearsal mode can run the end-to-end exercise.')
  }
  if (!/^draftmatter-rehearsal-[a-z0-9-]+$/.test(environment.COMPOSE_PROJECT_NAME ?? '')) {
    throw new RehearsalError('The source project must have a dedicated draftmatter-rehearsal-<suffix> name.')
  }
  for (const name of ['APP_HOST', 'COLLABORATION_HOST', 'AUTH_HOST']) {
    if (!/^[a-z0-9.-]+\.localhost$/.test(environment[name] ?? '')) throw new RehearsalError('Rehearsal hosts must remain under .localhost.')
  }
  const envFile = resolve(file)
  const directory = resolve(environment.DM_SINGLE_HOST_DIR)
  const targetProject = environment.COMPOSE_PROJECT_NAME.replace(/^draftmatter-rehearsal-/, 'draftmatter-restore-')
  assertRestoreTarget(targetProject, targetProject)
  return {
    envFile, environment, directory, project: environment.COMPOSE_PROJECT_NAME,
    restoreDirectory: `${directory}-restore`, restoreProject: targetProject,
    reportFile: join(directory, 'end-to-end-rehearsal-report.json'),
  }
}

async function run(program, args, { signal, env = process.env, capture = false, label } = {}) {
  const child = spawn(program, args, { cwd: repositoryRoot, env, signal, stdio: ['ignore', 'pipe', 'pipe'] })
  const chunks = []
  let captured = 0, spawnFailed = false, exceeded = false
  child.on('error', () => { spawnFailed = true })
  child.stdout.on('data', (bytes) => {
    if (!capture || exceeded) return
    captured += bytes.length
    if (captured > 64 * 1024) { exceeded = true; child.kill(); return }
    chunks.push(bytes)
  })
  // No resolved Compose config, Docker diagnostics, OAuth responses or tokens
  // are copied into the sanitized orchestration report or console output.
  child.stderr.resume()
  const exit = await new Promise((done) => child.once('close', done))
  if (spawnFailed || exit !== 0 || exceeded) throw new RehearsalError(`${label ?? 'Rehearsal command'} failed; run that phase directly for private diagnostics.`)
  return capture ? Buffer.concat(chunks).toString('utf8').trim() : undefined
}

function composeArgs(settings, args) {
  return ['compose', '--env-file', settings.envFile, '--project-name', settings.project, '-f', composeFile, '-f', rehearsalFile, ...args]
}

function loopbackLookup(_hostname, options, callback) {
  callback(null, ...(options?.all ? [[{ address: '127.0.0.1', family: 4 }]] : ['127.0.0.1', 4]))
}

function probe(url, ca, timeoutMs, check) {
  return new Promise((done) => {
    const request = httpsRequest(url, { ca, lookup: loopbackLookup, rejectUnauthorized: true, agent: false }, (response) => {
      const chunks = []
      let size = 0
      response.on('data', (bytes) => {
        size += bytes.length
        if (size > 256 * 1024) { response.destroy(); done(false) }
        else chunks.push(bytes)
      })
      response.on('error', () => done(false))
      response.on('end', () => {
        try { done(response.statusCode === 200 && check(Buffer.concat(chunks).toString('utf8'))) }
        catch { done(false) }
      })
    })
    request.setTimeout(timeoutMs, () => { request.destroy(); done(false) })
    request.on('error', () => done(false))
    request.end()
  })
}

async function waitReady(settings, signal) {
  const ca = await readFile(join(settings.directory, 'tls/ca.crt'))
  const deadline = Date.now() + 120_000
  const probes = [
    [settings.environment.APP_ORIGIN, (text) => text.includes('id="root"')],
    [`${settings.environment.COLLABORATION_ORIGIN}/health/ready`, (text) => JSON.parse(text).status === 'ready'],
    [`${settings.environment.DM_OIDC_ISSUER}/.well-known/openid-configuration`, (text) => JSON.parse(text).issuer === settings.environment.DM_OIDC_ISSUER],
  ]
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new RehearsalError('Rehearsal was interrupted while waiting for readiness.')
    let ready = true
    for (const [url, check] of probes) {
      const left = deadline - Date.now()
      if (left <= 0 || !await probe(url, ca, Math.min(5_000, left), check)) { ready = false; break }
    }
    if (ready) return
    await new Promise((done) => setTimeout(done, Math.min(1_000, Math.max(0, deadline - Date.now()))))
  }
  throw new RehearsalError('Rehearsal did not become ready through verified HTTPS within 120 seconds.')
}

async function copyPrivateTree(source, target) {
  const info = await lstat(source)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new RehearsalError('Rehearsal TLS input must be a real directory without links.')
  await mkdir(target, { mode: 0o700 })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name), to = join(target, entry.name)
    if (entry.isDirectory()) await copyPrivateTree(from, to)
    else {
      const file = await lstat(from)
      if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1) throw new RehearsalError('Rehearsal configuration cannot copy linked or non-file TLS inputs.')
      await copyFile(from, to)
      await chmod(to, file.mode & 0o777)
    }
  }
}

export async function prepareRestoreConfiguration(source) {
  const directory = source.restoreDirectory
  // Refuse even an existing empty directory: it may belong to another run.
  await mkdir(directory, { mode: 0o700 }).catch(() => { throw new RehearsalError('Restore runtime directory already exists or cannot be created; use a fresh isolated source fixture.') })
  await copyPrivateTree(join(source.directory, 'tls'), join(directory, 'tls'))
  for (const name of ['realm.json', 'Caddyfile', 's3.json', 'rehearsal-report.json']) {
    const input = join(source.directory, name)
    const info = await lstat(input)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new RehearsalError('Rehearsal configuration must use regular files without links.')
    await copyFile(input, join(directory, name))
    await chmod(join(directory, name), name === 'rehearsal-report.json' ? 0o600 : info.mode & 0o777)
  }
  const environment = { ...source.environment, DM_SINGLE_HOST_DIR: directory, COMPOSE_PROJECT_NAME: source.restoreProject }
  const envFile = join(directory, 'runtime.env')
  await writeFile(envFile, serializeEnvironment(environment), { mode: 0o600, flag: 'wx' })
  validateSingleHostEnvironment(readSingleHostEnvironment(envFile))
  return { envFile, directory, project: source.restoreProject, environment }
}

/** Kept separate so cleanup behaviour can be tested without starting Docker. */
export async function executeRehearsalPlan(settings, actions, { skipBuild = false, keepRunning = false } = {}) {
  let target, success = false
  const cleanup = []
  try {
    await actions.phase('compose-validation', () => actions.validate(settings))
    if (skipBuild) await actions.skip('build')
    else await actions.phase('build', () => actions.build(settings))
    await actions.phase('source-start', () => actions.start(settings))
    await actions.phase('source-readiness', () => actions.ready(settings))
    await actions.phase('initial-smoke', () => actions.smoke(settings, false))
    await actions.phase('source-restart', () => actions.restart(settings))
    await actions.phase('restart-readiness', () => actions.ready(settings))
    await actions.phase('restart-persistence', () => actions.smoke(settings, true))
    const archive = await actions.phase('encrypted-full-backup', () => actions.backup(settings))
    target = await actions.phase('prepare-isolated-restore', () => actions.prepare(settings))
    await actions.phase('restore-full-backup', () => actions.restore(target, archive, settings))
    await actions.phase('source-stop-before-target-start', () => actions.stop(settings))
    await actions.phase('target-start', () => actions.start(target))
    await actions.phase('target-readiness', () => actions.ready(target))
    await actions.phase('restored-persistence', () => actions.smoke(target, true))
    success = true
    return { status: 'passed', targetProject: target.project, keptRunning: keepRunning, cleanup }
  } finally {
    // Keep-running is honoured only on success, and only the target can still be
    // running because the source was explicitly stopped before target startup.
    if (!success || !keepRunning) {
      for (const item of [target, settings].filter(Boolean)) {
        try { await actions.phase(`final-stop-${item === target ? 'target' : 'source'}`, () => actions.stop(item, true)); cleanup.push({ project: item.project, stopped: true }) }
        catch { cleanup.push({ project: item.project, stopped: false }) }
      }
      if (cleanup.some((item) => !item.stopped)) throw new RehearsalError('Rehearsal cleanup could not stop every dedicated project; inspect the private report before retrying.')
    }
  }
}

function smokeChildEnvironment(settings) {
  return { ...process.env, NODE_EXTRA_CA_CERTS: join(settings.directory, 'tls/ca.crt') }
}

async function noExistingTarget(source) {
  try { await lstat(source.restoreDirectory) }
  catch (error) { if (error.code === 'ENOENT') return; throw error }
  throw new RehearsalError('Restore runtime directory already exists; use a fresh isolated source fixture.')
}

export async function rehearseSingleHost(options) {
  if (!options.envFile) throw new RehearsalError('--env-file is required.')
  const envFile = resolve(options.envFile)
  const environment = readSingleHostEnvironment(envFile)
  const settings = rehearsalSettings(environment, envFile)
  validateSingleHostEnvironment(environment)
  if (await realpath(dirname(envFile)) !== await realpath(settings.directory)) throw new RehearsalError('Rehearsal environment must be inside its own runtime directory.')
  await noExistingTarget(settings)
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), status: 'running', sourceProject: settings.project, targetProject: settings.restoreProject, skipBuild: Boolean(options.skipBuild), phases: [], cleanup: [] }
  const log = options.log ?? ((message) => process.stdout.write(`${message}\n`))
  let outcome, failure
  const phase = async (name, action) => {
    const entry = { name, status: 'running', startedAt: new Date().toISOString() }
    report.phases.push(entry)
    const started = Date.now()
    log(`Rehearsal: ${name} started.`)
    const heartbeat = setInterval(() => log(`Rehearsal: ${name} is still running.`), 30_000)
    try { const result = await action(); entry.status = 'passed'; return result }
    catch (error) { entry.status = 'failed'; throw error }
    finally { clearInterval(heartbeat); entry.durationMs = Date.now() - started; log(`Rehearsal: ${name} ${entry.status} (${entry.durationMs} ms).`) }
  }
  const docker = (value, args, label, cleanup = false, capture = false) => run('docker', composeArgs(value, args), { signal: cleanup ? undefined : options.signal, capture, label })
  const stop = async (value, cleanup = false) => {
    await docker(value, ['stop', '--timeout', '60'], 'Stop dedicated rehearsal project', cleanup)
    if (await docker(value, ['ps', '--status', 'running', '-q'], 'Verify dedicated rehearsal stopped', cleanup, true)) throw new RehearsalError('A dedicated rehearsal project still has running containers.')
  }
  const node = (args, value, capture = false) => run(process.execPath, args, { env: smokeChildEnvironment(value), signal: options.signal, capture, label: 'Rehearsal Node phase' })
  try {
    outcome = await executeRehearsalPlan(settings, {
      phase,
      skip: async (name) => { report.phases.push({ name, status: 'skipped', durationMs: 0 }); log(`Rehearsal: ${name} skipped explicitly.`) },
      validate: (value) => docker(value, ['config', '--quiet'], 'Validate resolved rehearsal Compose'),
      build: (value) => docker(value, ['build'], 'Build rehearsal images'),
      start: (value) => docker(value, ['up', '-d', '--wait', '--wait-timeout', '180'], 'Start dedicated rehearsal project'),
      ready: (value) => waitReady(value, options.signal),
      smoke: (value, verify) => node([smokeScript, '--env-file', value.envFile, ...(verify ? ['--verify-report'] : [])], value),
      restart: (value) => docker(value, ['restart', '--timeout', '60', 'postgres', 'object-storage', 'keycloak', 'edge', 'collaboration'], 'Restart rehearsal services'),
      backup: async (value) => {
        const output = await node([backupScript, 'create', '--env-file', value.envFile, '--project', value.project, '--directory', join(value.directory, 'backups'), '--key-file', join(value.directory, 'backup.key')], value, true)
        let result
        try { result = JSON.parse(output) } catch { throw new RehearsalError('Backup did not return its expected machine-readable result.') }
        if (result.status !== 'created' || !result.archive || resolve(dirname(result.archive)) !== resolve(value.directory, 'backups')) throw new RehearsalError('Backup result does not identify an archive in its private staging directory.')
        report.backup = { encrypted: result.encrypted, archive: basename(result.archive), databases: result.databases, objectVolumeIncluded: result.objectVolumeIncluded }
        return result.archive
      },
      prepare: prepareRestoreConfiguration,
      restore: (target, archive, source) => node([backupScript, 'restore', '--env-file', target.envFile, '--project', target.project, '--confirm-empty-target', target.project, '--archive', archive, '--key-file', join(source.directory, 'backup.key')], target),
      stop,
    }, options)
    report.status = outcome.status
    report.keptRunning = outcome.keptRunning
    report.cleanup = outcome.cleanup
  } catch (error) {
    report.status = 'failed'
    failure = error instanceof RehearsalError ? error : new RehearsalError('Rehearsal failed; inspect the phase statuses and run the failing phase directly for private diagnostics.')
  } finally {
    if (report.status === 'failed') report.cleanup = report.phases
      .filter((entry) => entry.name.startsWith('final-stop-'))
      .map((entry) => ({ project: entry.name === 'final-stop-target' ? settings.restoreProject : settings.project, stopped: entry.status === 'passed' }))
    report.finishedAt = new Date().toISOString()
    report.durationMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt)
    // This report intentionally contains no child command output, environment,
    // tokens, account identifiers, manuscript markers or fixture file contents.
    const temporary = `${settings.reportFile}.partial`
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, settings.reportFile)
  }
  if (failure) throw new RehearsalError(`${failure.message} Sanitized report: ${settings.reportFile}`)
  return { status: report.status, reportFile: settings.reportFile, sourceProject: settings.project, targetProject: settings.restoreProject, keptRunning: report.keptRunning }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController()
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort())
  try {
    const { values } = parseArgs({ options: { 'env-file': { type: 'string' }, 'skip-build': { type: 'boolean' }, 'keep-running': { type: 'boolean' } }, allowPositionals: false })
    const result = await rehearseSingleHost({ envFile: values['env-file'], skipBuild: values['skip-build'], keepRunning: values['keep-running'], signal: controller.signal })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof RehearsalError ? error.message : 'Rehearsal configuration or arguments are invalid; run the configuration checker for private diagnostics.'}\n`)
    process.exitCode = 1
  }
}
