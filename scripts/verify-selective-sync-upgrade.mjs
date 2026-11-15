#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes, X509Certificate } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { chromium } from '@playwright/test'
import { outsideCheckout, readSingleHostEnvironment, repositoryRoot, validateSingleHostEnvironment } from './single-host-config.mjs'
import { collaborationBundle, rehearsalDocumentPeer, rehearsalLogin, rehearsalRequest, smokeSettings } from './smoke-single-host.mjs'

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
let phase = 'configuration validation'
const privateFile = (path, data, exclusive = false) => {
  outsideCheckout(path)
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, ...(exclusive ? { flag: 'wx' } : {}) })
  chmodSync(path, 0o600)
}

/** Counts only: no manuscript paths, account identities, or file bytes leave SQL. */
export const migration012Sql = `BEGIN READ ONLY;
SELECT json_build_object(
  'migration012', EXISTS(SELECT 1 FROM draftmatter_schema_migrations WHERE version = '012'),
  'expectedVersionColumn', (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'draftmatter_project_files' AND column_name = 'expected_version_id' AND data_type = 'text'),
  'heads', (SELECT COUNT(*) FROM draftmatter_project_file_heads),
  'tombstones', (SELECT COUNT(*) FROM draftmatter_project_file_heads WHERE deleted),
  'danglingLiveHeads', (SELECT COUNT(*) FROM draftmatter_project_file_heads h LEFT JOIN draftmatter_project_files f ON f.workspace_id = h.workspace_id AND f.project_id = h.project_id AND f.id = h.version_id WHERE NOT h.deleted AND (f.id IS NULL OR f.state <> 'ready' OR f.path <> h.path)),
  'readyPathsWithoutHead', (SELECT COUNT(*) FROM (SELECT DISTINCT f.workspace_id, f.project_id, f.path FROM draftmatter_project_files f LEFT JOIN draftmatter_project_file_heads h ON h.workspace_id = f.workspace_id AND h.project_id = f.project_id AND h.path = f.path WHERE f.state = 'ready' AND h.path IS NULL) absent)
);
ROLLBACK;`

async function verifySql(settings) {
  const args = ['compose', '--project-name', settings.project, '--env-file', settings.envFile,
    '-f', join(repositoryRoot, 'deploy/single-host/compose.yaml'), '-f', join(repositoryRoot, 'deploy/single-host/rehearsal.yaml'),
    'exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'draftmatter', '-qAt', '--set', 'ON_ERROR_STOP=1']
  const raw = await new Promise((fulfil, reject) => {
    const child = spawn('docker', args, { cwd: repositoryRoot, stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks = []; let bytes = 0
    const timeout = setTimeout(() => child.kill('SIGTERM'), 30_000).unref()
    child.stdout.on('data', (part) => { bytes += part.length; if (bytes > 16_384) child.kill('SIGTERM'); else chunks.push(part) })
    child.stderr.resume()
    child.on('error', () => reject(new Error('The read-only migration SQL could not start.')))
    child.on('close', (code) => { clearTimeout(timeout); code === 0 ? fulfil(Buffer.concat(chunks).toString('utf8').trim()) : reject(new Error('The read-only migration SQL failed.')) })
    child.stdin.on('error', () => {})
    child.stdin.end(migration012Sql)
  })
  const result = JSON.parse(raw)
  assert.equal(result.migration012, true)
  assert.equal(Number(result.expectedVersionColumn), 1)
  assert.equal(Number(result.danglingLiveHeads), 0)
  assert.equal(Number(result.readyPathsWithoutHead), 0)
  return result
}

async function verifyBytes(settings, token, base, file, expectedSha) {
  assert(file && Array.isArray(file.parts), 'The retained immutable version is missing.')
  const hash = createHash('sha256'); let size = 0
  for (const part of file.parts) {
    const response = await rehearsalRequest(settings, `${base}/files/${encodeURIComponent(file.id)}/parts/${part.partNumber}`, { token })
    assert.equal(response.bytes.length, part.size)
    assert.equal(sha(response.bytes), part.sha256)
    assert.equal(response.headers['x-draftmatter-sha256'], part.sha256)
    size += response.bytes.length; hash.update(response.bytes)
  }
  assert.equal(size, file.size)
  assert.equal(hash.digest('hex'), expectedSha)
}

async function retainedData(settings, token) {
  assert(existsSync(settings.reportFile), 'The old rehearsal report is required to verify retained data.')
  const old = JSON.parse(readFileSync(settings.reportFile, 'utf8'))
  assert.equal(old.schemaVersion, 1)
  const base = `/api/workspaces/${encodeURIComponent(old.workspaceId)}/projects/${encodeURIComponent(old.projectId)}`
  const catalogue = (await rehearsalRequest(settings, `${base}/files`, { token })).data
  assert(Array.isArray(catalogue.heads), 'The upgraded API did not expose synchronization heads.')
  const file = catalogue.files.find((value) => value.id === old.file.id)
  assert(file, 'The upgrade lost the old rehearsal file descriptor.')
  assert(catalogue.heads.some((head) => head.path === old.file.path && !head.deleted), 'The old file path did not receive a live migration head.')
  await verifyBytes(settings, token, base, file, old.file.sha256)
  return { existingFileRetained: true, immutableBytesVerified: file.size }
}

async function exerciseCas(settings, alice, bob) {
  const workspaceId = `sync-upgrade-${randomBytes(6).toString('hex')}`, projectId = 'cas-paper'
  await rehearsalRequest(settings, '/api/workspaces', { method: 'POST', token: alice.token, expected: 201, json: { id: workspaceId, name: 'Disposable selective sync upgrade verification' } })
  const workspace = `/api/workspaces/${workspaceId}`
  for (const id of [projectId, 'native-paper']) await rehearsalRequest(settings, `${workspace}/projects`, { method: 'POST', token: alice.token, expected: 201, json: { id, name: id === 'native-paper' ? 'Selective sync native verification' : 'Selective sync CAS verification' } })
  const invitation = (await rehearsalRequest(settings, `${workspace}/invitations`, { method: 'POST', token: alice.token, expected: 201, json: { role: 'editor' } })).data
  await rehearsalRequest(settings, '/api/invitations/accept', { method: 'POST', token: bob.token, json: { token: invitation.token } })
  const base = `${workspace}/projects/${projectId}`, path = 'figures/sync-cas.svg'
  const start = async (token, filePath, bytes, expectedVersionId) => {
    assert(bytes.length < 4096)
    const upload = (await rehearsalRequest(settings, `${base}/files/uploads`, { method: 'POST', token, expected: 201, json: { path: filePath, size: bytes.length, mediaType: 'image/svg+xml', expectedVersionId } })).data
    if (bytes.length) await rehearsalRequest(settings, `${base}/files/uploads/${upload.id}/parts/1`, { method: 'PUT', token, bytes, headers: { 'content-type': 'application/octet-stream', 'x-draftmatter-sha256': sha(bytes) } })
    return upload
  }
  const complete = (token, upload, expected = 200) => rehearsalRequest(settings, `${base}/files/uploads/${upload.id}/complete`, { method: 'POST', token, expected })
  const content = (title) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="20"><title>${title}</title></svg>`)
  const originalBytes = content('Original retained version')
  const original = (await complete(alice.token, await start(alice.token, path, originalBytes, null))).data
  const contestants = [alice, bob]
  const bytes = [content('Alice competing version'), content('Bob competing version')]
  const uploads = await Promise.all(contestants.map((user, index) => start(user.token, path, bytes[index], original.id)))
  const results = await Promise.all(contestants.map((user, index) => complete(user.token, uploads[index], [200, 409])))
  assert.equal(results.filter((result) => result.status === 200).length, 1)
  assert.equal(results.filter((result) => result.status === 409).length, 1)
  const winner = results.findIndex((result) => result.status === 200), loser = 1 - winner
  assert.equal(results[loser].data?.error?.code, 'file-version-conflict')
  const winnerFile = results[winner].data
  const losingUpload = (await rehearsalRequest(settings, `${base}/files/uploads/${uploads[loser].id}`, { token: contestants[loser].token })).data
  assert.equal(losingUpload.parts.length, 1)
  assert.equal(losingUpload.parts[0].sha256, sha(bytes[loser]))
  let catalogue = (await rehearsalRequest(settings, `${base}/files`, { token: bob.token })).data
  assert.deepEqual(catalogue.heads.find((head) => head.path === path), { path, versionId: winnerFile.id, deleted: false })
  await verifyBytes(settings, bob.token, base, original, sha(originalBytes))
  await verifyBytes(settings, alice.token, base, winnerFile, sha(bytes[winner]))
  await complete(alice.token, original)
  catalogue = (await rehearsalRequest(settings, `${base}/files`, { token: bob.token })).data
  assert.equal(catalogue.heads.find((head) => head.path === path)?.versionId, winnerFile.id, 'An idempotent old completion moved the current head backwards.')
  const deletedPath = 'figures/deletion-guard.svg'
  const deleted = (await complete(alice.token, await start(alice.token, deletedPath, content('Deleted version'), null))).data
  const pending = await start(bob.token, deletedPath, content('Stale before deletion'), deleted.id)
  await rehearsalRequest(settings, `${base}/files/${deleted.id}`, { method: 'DELETE', token: alice.token, expected: 204 })
  const rejected = await complete(bob.token, pending, 409)
  assert.equal(rejected.data?.error?.code, 'file-version-conflict')
  catalogue = (await rehearsalRequest(settings, `${base}/files`, { token: alice.token })).data
  const tombstone = catalogue.heads.find((head) => head.path === deletedPath)
  assert(tombstone?.deleted && tombstone.versionId !== deleted.id)
  for (const blocked of ['.env', '.git/config', '.draftmatter/state.json', 'node_modules/private.txt']) await rehearsalRequest(settings, `${base}/files/uploads`, { method: 'POST', token: alice.token, expected: 400, json: { path: blocked, size: 0, mediaType: 'text/plain', expectedVersionId: null } })
  await rehearsalRequest(settings, `${base}/files`, { expected: 401 })
  return { workspaceId, projectId, nativeProjectId: 'native-paper', winnerId: winnerFile.id, originalId: original.id, winnerSha256: sha(bytes[winner]), originalSha256: sha(originalBytes), path,
    checks: ['authenticated-catalogue-heads', 'independent-publisher-head-cas', 'losing-upload-retained', 'immutable-previous-bytes', 'idempotent-old-completion', 'fresh-deletion-tombstone', 'stale-upload-rejected-after-deletion', 'private-and-dependency-paths-rejected'] }
}

async function seedNativeProject(browser, settings, tokens, report) {
  const source = '# Selective synchronization verification\n\nWrite locally and online without losing either version.\n'
  const bundle = await collaborationBundle()
  const owner = await rehearsalDocumentPeer(browser, settings, bundle, tokens[0].token, report.workspaceId, report.nativeProjectId)
  const editor = await rehearsalDocumentPeer(browser, settings, bundle, tokens[1].token, report.workspaceId, report.nativeProjectId)
  try {
    await owner.page.evaluate((source) => {
      const document = window.__dmSmoke.document
      document.transact(() => { document.getMap('draftmatter:meta').set('schemaVersion', 1); document.getText('draftmatter:document').insert(0, source) })
    }, source)
    await editor.page.waitForFunction((source) => window.__dmSmoke.document.getText('draftmatter:document').toString() === source, source, { timeout: 20_000 })
  } finally { await Promise.all([owner.close(), editor.close()]) }
  return source
}

async function main() {
  const { values } = parseArgs({ options: { 'env-file': { type: 'string' }, 'sql-only': { type: 'boolean', default: false }, 'handoff-file': { type: 'string' } } })
  assert(values['env-file'], 'Provide --env-file pointing to the existing isolated rehearsal.')
  const envFile = resolve(values['env-file']), environment = readSingleHostEnvironment(envFile)
  const settings = smokeSettings(environment, envFile)
  validateSingleHostEnvironment(environment)
  phase = 'read-only migration and head SQL'
  const sql = await verifySql(settings)
  if (values['sql-only']) { console.log(JSON.stringify({ migration012: 'verified', invariants: sql })); return }
  assert(process.env.NODE_EXTRA_CA_CERTS, 'Launch Node with NODE_EXTRA_CA_CERTS pointing to the rehearsal CA.')
  const certificate = new X509Certificate(readFileSync(join(dirname(envFile), 'tls/public.crt')))
  const pin = createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64')
  const browser = await chromium.launch({ headless: true, args: [`--host-resolver-rules=${settings.hosts.map((host) => `MAP ${host} 127.0.0.1`).join(',')}`, `--ignore-certificate-errors-spki-list=${pin}`] })
  try {
    phase = 'real browser S256 authentication'
    const [alice, bob] = await Promise.all(['alice', 'bob'].map((name) => rehearsalLogin(browser, settings, name)))
    phase = 'retained pre-upgrade file verification'
    const retained = await retainedData(settings, alice.token)
    phase = 'authenticated head CAS and tombstone checks'
    const cas = await exerciseCas(settings, alice, bob)
    const report = { schemaVersion: 1, verifiedAt: new Date().toISOString(), migration012: sql, retained, ...cas }
    if (values['handoff-file']) {
      phase = 'native project and private session handoff'
      const source = await seedNativeProject(browser, settings, [alice, bob], cas)
      privateFile(resolve(values['handoff-file']), { schemaVersion: 1, createdAt: report.verifiedAt, seedSource: source, manuscriptPath: 'paper.qmd', serviceOrigin: settings.serviceOrigin, websocketUrl: settings.websocketUrl, appOrigin: settings.appOrigin, authOrigin: settings.authOrigin,
        workspaceId: cas.workspaceId, nativeProjectId: cas.nativeProjectId, nativeProjectName: 'Selective sync native verification', aliceToken: alice.token, bobToken: bob.token }, true)
    }
    const reportPath = join(dirname(envFile), 'selective-sync-upgrade-report.json')
    phase = 'private verification report'
    privateFile(reportPath, report)
    console.log(`Migration012, retained bytes, and authenticated selective sync CAS verified. Private report: ${reportPath}`)
  } finally { await browser.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error(`Selective sync upgrade verification failed during ${phase}. No credentials or server response bodies are printed.`); process.exitCode = 1 })
}
