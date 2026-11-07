/** Shared with src-tauri/src/project_transactions.rs. Local filesystems only.
 * Each bakery-lock claim has a unique pathname, so reclaiming a dead process
 * never removes a newer owner's lock. All changes and recovery hold this lock.
 */
import { lstat, mkdir, open, opendir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { normalizeProjectRelativePath } from './projectPaths'

const LOCK_TIMEOUT_MS = 15_000
const MAX_FILES = 512
const MAX_TRANSACTION_BYTES = 128 * 1024 * 1024
const CLAIM_NAME = /^(\d+)-([0-9a-f-]{36})\.json$/
const TRANSACTION_NAME = /^v2-[0-9a-f-]{36}$/

export class ProjectTransactionError extends Error {
  constructor(readonly code: 'path-symlink-escape' | 'transaction-failed' | 'project-busy', message: string) {
    super(message)
  }
}

function missing(error: unknown) { return (error as NodeJS.ErrnoException)?.code === 'ENOENT' }
async function boundedBytes(path: string, limit: number) {
  const handle = await open(path, 'r')
  try {
    if ((await handle.stat()).size > limit) throw new ProjectTransactionError('transaction-failed', 'Project coordination or recovery data exceeds its size limit; it was preserved.')
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
      const buffer = new Uint8Array(Math.min(65_536, limit + 1 - total))
      const { bytesRead } = await handle.read(buffer)
      if (!bytesRead) break
      total += bytesRead
      if (total > limit) throw new ProjectTransactionError('transaction-failed', 'Project coordination or recovery data exceeds its size limit; it was preserved.')
      chunks.push(buffer.subarray(0, bytesRead))
    }
    return Buffer.concat(chunks)
  } finally { await handle.close() }
}

export function transactionHash(bytes: Uint8Array) { return `sha256:${createHash('sha256').update(bytes).digest('hex')}` }

export async function confinedProjectPath(root: string, relative: string) {
  const normalized = normalizeProjectRelativePath(relative)
  if (!normalized) throw new ProjectTransactionError('path-symlink-escape', 'A transaction path must stay inside the project.')
  let candidate = root
  for (const component of normalized.split('/')) {
    candidate = join(candidate, component)
    try {
      const metadata = await lstat(candidate)
      if (metadata.isSymbolicLink()) throw new ProjectTransactionError('path-symlink-escape', `Project transaction paths cannot contain links: ${relative}.`)
    } catch (error) { if (!missing(error)) throw error }
  }
  return candidate
}

async function directory(root: string, relative: string) {
  const path = await confinedProjectPath(root, relative)
  const created = await mkdir(path, { recursive: true })
  await confinedProjectPath(root, relative)
  if (created) {
    let current = path
    while (current !== root) { await syncDirectory(dirname(current)); current = dirname(current) }
  }
  return path
}

async function syncDirectory(path: string) {
  // Windows does not expose directory fsync through Node. File handles are
  // flushed before rename on every platform; POSIX also flushes parent entries.
  if (process.platform === 'win32') return
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

export async function atomicTransactionWrite(path: string, bytes: Uint8Array | string) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
  try { await rename(temporary, path); await syncDirectory(dirname(path)) }
  finally { await rm(temporary, { force: true }) }
}

interface Claim { schemaVersion: 1; pid: number; nonce: string; choosing: boolean; ticket: number }
function alive(pid: number) {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}

export async function withProjectWriteLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const locks = await directory(root, '.draftmatter/write-locks')
  const nonce = randomUUID()
  const claimPath = join(locks, `${process.pid}-${nonce}.json`)
  const claim: Claim = { schemaVersion: 1, pid: process.pid, nonce, choosing: true, ticket: 0 }
  const started = Date.now()
  const readClaims = async () => {
    const claims: Claim[] = []
    let count = 0
    for await (const entry of await opendir(locks)) {
      if (++count > 4096) throw new ProjectTransactionError('transaction-failed', 'The project has too many lock records; coordination files were preserved.')
      const name = entry.name
      const match = CLAIM_NAME.exec(name)
      if (!match) continue
      const path = await confinedProjectPath(root, `.draftmatter/write-locks/${name}`)
      if (!alive(Number(match[1]))) { await rm(path, { force: true }); continue }
      let record: Claim
      try { record = JSON.parse((await boundedBytes(path, 4096)).toString()) as Claim }
      catch (error) { if (missing(error)) continue; throw new ProjectTransactionError('transaction-failed', 'A live project lock is invalid; close other DraftMatter clients and retry.') }
      if (record.schemaVersion !== 1 || record.pid !== Number(match[1]) || record.nonce !== match[2] || typeof record.choosing !== 'boolean' || !Number.isSafeInteger(record.ticket) || record.ticket < 0) {
        throw new ProjectTransactionError('transaction-failed', 'The project lock metadata is invalid; it has been preserved for inspection.')
      }
      claims.push(record)
    }
    return claims
  }
  await atomicTransactionWrite(claimPath, JSON.stringify(claim))
  try {
    claim.ticket = 1 + Math.max(0, ...(await readClaims()).map((record) => record.ticket))
    if (!Number.isSafeInteger(claim.ticket)) throw new ProjectTransactionError('transaction-failed', 'The project lock ticket range is exhausted.')
    claim.choosing = false
    await atomicTransactionWrite(claimPath, JSON.stringify(claim))
    while (true) {
      const blocked = (await readClaims()).some((other) => other.nonce !== nonce && (other.choosing || (other.ticket > 0 && (other.ticket < claim.ticket || (other.ticket === claim.ticket && other.nonce < nonce)))))
      if (!blocked) return await action()
      if (Date.now() - started >= LOCK_TIMEOUT_MS) throw new ProjectTransactionError('project-busy', 'Another DraftMatter client is writing this project. Wait for it to finish, or close that client and retry. No files were overwritten.')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  } finally { await rm(claimPath, { force: true }); await syncDirectory(locks) }
}

interface TransactionFile { target: string; backup: string | null; beforeHash: string | null; afterHash: string | null }
interface TransactionManifest { schemaVersion: 2; engine: 'draftmatter'; state: 'prepared' | 'committed'; files: TransactionFile[] }
export interface TransactionChange { path: string; content: Uint8Array | null }
async function optionalBytes(path: string, limit = MAX_TRANSACTION_BYTES) {
  try { return await boundedBytes(path, limit) } catch (error) { if (missing(error)) return null; throw error }
}

function allowedTarget(path: string) {
  const normalized = normalizeProjectRelativePath(path)
  const lower = path.toLowerCase()
  return normalized === path && !path.split('/').some((part) => part.toLowerCase() === '.git')
    && !['.draftmatter/write-locks', '.draftmatter/transactions'].some((reserved) => lower === reserved || lower.startsWith(`${reserved}/`))
}

async function rollback(root: string, transaction: string, manifest: TransactionManifest) {
  if (manifest.schemaVersion !== 2 || manifest.engine !== 'draftmatter' || !['prepared', 'committed'].includes(manifest.state) || !Array.isArray(manifest.files) || manifest.files.length > MAX_FILES) throw new ProjectTransactionError('transaction-failed', 'Unsupported project recovery journal; no files were changed.')
  const seen = new Set<string>()
  let bytes = 0
  // Validate every target and backup before the first write. Retain backups until
  // the whole rollback finishes, making another crash during recovery harmless.
  const replacements: Array<{ target: string; backup: Buffer | null }> = []
  for (const [index, file] of manifest.files.entries()) {
    const validHash = (value: unknown) => value === null || (typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value))
    if (!allowedTarget(file.target) || seen.has(file.target.toLowerCase()) || !validHash(file.beforeHash) || !validHash(file.afterHash) || file.backup !== (file.beforeHash === null ? null : `backup-${index}.bin`)) throw new ProjectTransactionError('transaction-failed', 'Invalid project recovery target or backup; the journal was preserved.')
    seen.add(file.target.toLowerCase())
    const target = await confinedProjectPath(root, file.target)
    const backup = file.backup === null ? null : await boundedBytes(await confinedProjectPath(root, `${transaction}/${file.backup}`), MAX_TRANSACTION_BYTES - bytes)
    bytes += backup?.length ?? 0
    if (backup !== null && transactionHash(backup) !== file.beforeHash) throw new ProjectTransactionError('transaction-failed', 'A project recovery backup is invalid; the journal was preserved.')
    const current = await optionalBytes(target)
    const currentHash = current === null ? null : transactionHash(current)
    if (currentHash !== file.beforeHash && currentHash !== file.afterHash) throw new ProjectTransactionError('transaction-failed', `“${file.target}” changed after an interrupted transaction. Its current file and recovery backup were preserved; resolve this conflict before reopening the project.`)
    replacements.push({ target, backup })
  }
  for (const { target, backup } of replacements.reverse()) {
    if (backup === null) { await rm(target, { force: true }); await syncDirectory(dirname(target)) }
    else await atomicTransactionWrite(target, backup)
  }
}

/** Caller holds the shared write lock, including when merely opening a project. */
export async function recoverProjectTransactions(root: string) {
  const transactions = await confinedProjectPath(root, '.draftmatter/transactions')
  let entries: Awaited<ReturnType<typeof opendir>>
  try { entries = await opendir(transactions) } catch (error) { if (missing(error)) return; throw error }
  let count = 0
  for await (const entry of entries) {
    if (++count > 4096) throw new ProjectTransactionError('transaction-failed', 'The project has too many recovery records; recovery files were preserved.')
    const name = entry.name
    const relative = `.draftmatter/transactions/${name}`
    const path = await confinedProjectPath(root, relative)
    if (!(await lstat(path)).isDirectory()) continue
    if (!TRANSACTION_NAME.test(name)) {
      // Older Node journals have no PID/lock ownership and cannot safely be
      // distinguished from an active old client. Preserve rather than delete.
      const legacy = await optionalBytes(await confinedProjectPath(root, `${relative}/journal.json`), 1024 * 1024)
      if (legacy) {
        const value = JSON.parse(legacy.toString()) as { state?: string }
        if (value.state === 'staged' || value.state === 'recovery-required') throw new ProjectTransactionError('transaction-failed', `An older interrupted AI transaction needs recovery at ${relative}. Close old clients and recover its backup before continuing; no recovery files were removed.`)
      }
      const citation = await optionalBytes(await confinedProjectPath(root, `${relative}/manifest.json`), 1024 * 1024)
      if (citation) {
        const value = JSON.parse(citation.toString()) as { state?: string; schemaVersion?: number; files?: unknown[] }
        if (value.schemaVersion === undefined && value.state === 'prepared' && Array.isArray(value.files)) throw new ProjectTransactionError('transaction-failed', `An older citation transaction needs desktop recovery at ${relative}. Close old clients and open the project in DraftMatter before continuing; all recovery files were preserved.`)
      }
      continue
    }
    const raw = await optionalBytes(await confinedProjectPath(root, `${relative}/manifest.json`), 1024 * 1024)
    if (raw === null) {
      // Only our explicit owner marker permits removing pre-prepare debris.
      const owner = await optionalBytes(await confinedProjectPath(root, `${relative}/owner.json`), 128)
      if (owner && owner.toString() === '{"engine":"draftmatter","schemaVersion":2}') await rm(path, { recursive: true })
      continue
    }
    if (raw.length > 1024 * 1024) throw new ProjectTransactionError('transaction-failed', 'The project recovery journal exceeds its size limit.')
    const manifest = JSON.parse(raw.toString()) as TransactionManifest
    if (manifest.schemaVersion !== 2 || manifest.engine !== 'draftmatter') throw new ProjectTransactionError('transaction-failed', 'Unknown project recovery journal; it was preserved.')
    if (manifest.state === 'prepared') await rollback(root, relative, manifest)
    else if (manifest.state !== 'committed') throw new ProjectTransactionError('transaction-failed', 'Unknown project recovery state; it was preserved.')
    await rm(path, { recursive: true })
  }
  await syncDirectory(transactions)
}

export async function applyProjectTransaction(root: string, changes: TransactionChange[], afterReplacement?: (count: number) => Promise<void>) {
  if (!changes.length || changes.length > MAX_FILES || new Set(changes.map((change) => change.path.toLowerCase())).size !== changes.length) throw new ProjectTransactionError('transaction-failed', 'A transaction requires 1–512 distinct project paths.')
  if (changes.some((change) => !allowedTarget(change.path))) throw new ProjectTransactionError('transaction-failed', 'A transaction cannot replace Git, lock, or recovery metadata.')
  const transactionId = randomUUID()
  const relative = `.draftmatter/transactions/v2-${transactionId}`
  const transaction = await directory(root, relative)
  await atomicTransactionWrite(join(transaction, 'owner.json'), '{"engine":"draftmatter","schemaVersion":2}')
  const manifest: TransactionManifest = { schemaVersion: 2, engine: 'draftmatter', state: 'prepared', files: [] }
  let total = 0
  for (const [index, change] of changes.entries()) {
    const target = await confinedProjectPath(root, change.path)
    const before = await optionalBytes(target)
    total += (before?.length ?? 0) + (change.content?.length ?? 0)
    if (total > MAX_TRANSACTION_BYTES) throw new ProjectTransactionError('transaction-failed', 'The project transaction exceeds the 128 MB limit.')
    const backup = before === null ? null : `backup-${index}.bin`
    if (before !== null) await atomicTransactionWrite(join(transaction, backup!), before)
    if (change.content !== null) await atomicTransactionWrite(join(transaction, `staged-${index}.bin`), change.content)
    manifest.files.push({ target: change.path, backup, beforeHash: before === null ? null : transactionHash(before), afterHash: change.content === null ? null : transactionHash(change.content) })
  }
  const manifestPath = join(transaction, 'manifest.json')
  await atomicTransactionWrite(manifestPath, JSON.stringify(manifest))
  try {
    for (const [index, change] of changes.entries()) {
      const target = await confinedProjectPath(root, change.path)
      if (change.content === null) { await rm(target, { force: true }); await syncDirectory(dirname(target)) }
      else {
        await mkdir(dirname(target), { recursive: true })
        await rename(join(transaction, `staged-${index}.bin`), target)
        await syncDirectory(dirname(target))
      }
      await afterReplacement?.(index + 1)
    }
  } catch (error) {
    await rollback(root, relative, manifest)
    await rm(transaction, { recursive: true })
    throw error
  }
  // Once publishing the commit marker begins, never roll targets back in this
  // process: rename may have succeeded even if the directory flush then failed.
  // The next opener can safely decide from the marker actually present on disk.
  try { await atomicTransactionWrite(manifestPath, JSON.stringify({ ...manifest, state: 'committed' })) }
  catch { throw new ProjectTransactionError('transaction-failed', 'All transaction files were written, but commit finalization could not be confirmed. Reopen the project to recover the complete revision; the journal was preserved.') }
  // Cleanup failure cannot turn a durably committed operation into a failed
  // mutation. The next guarded opening retries the committed journal cleanup.
  try { await rm(transaction, { recursive: true }); await syncDirectory(dirname(transaction)) } catch { /* committed recovery evidence remains */ }
  return transactionId
}
