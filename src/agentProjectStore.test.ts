import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NodeAgentProjectStore } from './agentProjectStore'
import { withProjectWriteLock } from './projectTransactions'

const children = new Set<ChildProcessWithoutNullStreams>()
let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'draftmatter-transactions-'))
  await writeFile(join(root, 'paper.qmd'), 'old-paper')
  await writeFile(join(root, 'references.json'), 'old-references')
})
afterEach(async () => {
  for (const child of children) { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit') } }
  children.clear()
  await rm(root, { recursive: true, force: true })
})
function child(mode: string) {
  const process_ = spawn(process.execPath, ['src/fixtures/transactions/process.mjs', root, mode], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] })
  children.add(process_)
  const records: Record<string, unknown>[] = []
  const waiters: Array<{ kind: string; resolve: (record: Record<string, unknown>) => void }> = []
  let stderr = ''
  process_.stderr.on('data', (data) => { stderr += String(data) })
  const lines = createInterface({ input: process_.stdout })
  lines.on('line', (line) => {
    let record: Record<string, unknown>
    try { record = JSON.parse(line) as Record<string, unknown> } catch { return }
    const index = waiters.findIndex((waiter) => waiter.kind === record.kind)
    if (index >= 0) waiters.splice(index, 1)[0].resolve(record)
    else records.push(record)
  })
  const waitFor = (kind: string) => {
    const index = records.findIndex((record) => record.kind === kind)
    if (index >= 0) return Promise.resolve(records.splice(index, 1)[0])
    return Promise.race([
      new Promise<Record<string, unknown>>((resolve) => waiters.push({ kind, resolve })),
      once(process_, 'exit').then(([code]) => { throw new Error(`Transaction child exited ${code} before ${kind}: ${stderr}`) }),
    ])
  }
  return { process: process_, waitFor }
}

describe('durable project transactions across clients', () => {
  it('admits exactly one of two real processes that inspected the same revision', async () => {
    const a = child('race'), b = child('race')
    await Promise.all([a.waitFor('ready'), b.waitFor('ready')])
    a.process.stdin.write('go\n'); b.process.stdin.write('go\n')
    const results = await Promise.all([a.waitFor('result'), b.waitFor('result')])
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.find((result) => !result.ok)?.code).toBe('stale-revision')
    expect(await readFile(join(root, 'references.json'), 'utf8')).toBe('new-references')
  })

  it('recovers all files after SIGKILL between replacements and removes dead lock claims', async () => {
    const writer = child('hold')
    await writer.waitFor('held')
    expect(await readFile(join(root, 'paper.qmd'), 'utf8')).toMatch(/^new-paper-/)
    expect(await readFile(join(root, 'references.json'), 'utf8')).toBe('old-references')
    writer.process.kill('SIGKILL'); await once(writer.process, 'exit')
    const store = await NodeAgentProjectStore.open(root)
    expect((await store.readText('paper.qmd')).content).toBe('old-paper')
    expect((await store.readText('references.json')).content).toBe('old-references')
    expect(await readdir(join(root, '.draftmatter/transactions'))).toEqual([])
    expect((await readdir(join(root, '.draftmatter/write-locks'))).filter((name) => name.endsWith('.json'))).toEqual([])
  })

  it('can resume recovery after the recovering process is itself killed', async () => {
    const first = child('hold'); await first.waitFor('held')
    first.process.kill('SIGKILL'); await once(first.process, 'exit')
    const recovery = child('hold-recovery'); await recovery.waitFor('held')
    recovery.process.kill('SIGKILL'); await once(recovery.process, 'exit')
    const store = await NodeAgentProjectStore.open(root)
    expect((await store.readText('paper.qmd')).content).toBe('old-paper')
    expect((await store.readText('references.json')).content).toBe('old-references')
    expect(await readdir(join(root, '.draftmatter/transactions'))).toEqual([])
  })

  it('retains a durably committed pair when killed before journal cleanup', async () => {
    const writer = child('hold-committed'); await writer.waitFor('held')
    writer.process.kill('SIGKILL'); await once(writer.process, 'exit')
    const store = await NodeAgentProjectStore.open(root)
    expect((await store.readText('paper.qmd')).content).toMatch(/^new-paper-/)
    expect((await store.readText('references.json')).content).toBe('new-references')
    expect(await readdir(join(root, '.draftmatter/transactions'))).toEqual([])
  })

  it('does not start rollback after the commit marker rename succeeds but its finalization fails', async () => {
    const writer = child('fail-committed')
    const result = await writer.waitFor('result')
    expect(result).toMatchObject({ ok: false, code: 'transaction-failed', message: expect.stringContaining('finalization') })
    const store = await NodeAgentProjectStore.open(root)
    expect((await store.readText('paper.qmd')).content).toMatch(/^new-paper-/)
    expect((await store.readText('references.json')).content).toBe('new-references')
    expect(await readdir(join(root, '.draftmatter/transactions'))).toEqual([])
  })

  it('does not expose a partial snapshot while another process holds the transaction', async () => {
    const store = await NodeAgentProjectStore.open(root)
    const writer = child('hold')
    await writer.waitFor('held')
    let finished = false
    const read = store.readText('paper.qmd').then((value) => { finished = true; return value })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(finished).toBe(false)
    writer.process.kill('SIGKILL'); await once(writer.process, 'exit')
    expect((await read).content).toBe('old-paper')
  })

  it('rejects metadata symlinks before staging any manuscript bytes', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'draftmatter-outside-'))
    try {
      await mkdir(join(root, '.draftmatter'))
      await symlink(outside, join(root, '.draftmatter/transactions'))
      await expect(NodeAgentProjectStore.open(root)).rejects.toMatchObject({ code: 'path-symlink-escape' })
      expect(await readdir(outside)).toEqual([])
    } finally { await rm(outside, { recursive: true, force: true }) }
  })

  it('keeps completed transaction retention empty and preserves foreign recovery evidence', async () => {
    const foreign = join(root, '.draftmatter/transactions/foreign-engine')
    await mkdir(foreign, { recursive: true }); await writeFile(join(foreign, 'backup.bin'), 'foreign')
    const store = await NodeAgentProjectStore.open(root)
    for (let index = 0; index < 12; index++) {
      const paper = await store.readText('paper.qmd')
      await store.commit([{ path: 'paper.qmd', content: `revision ${index}`, expectedRevision: paper.revision }])
    }
    expect(await readdir(join(root, '.draftmatter/transactions'))).toEqual(['foreign-engine'])
    expect(await readFile(join(foreign, 'backup.bin'), 'utf8')).toBe('foreign')
  })

  it('keeps the current file and backups when an external edit follows a crashed transaction', async () => {
    const writer = child('hold'); await writer.waitFor('held')
    writer.process.kill('SIGKILL'); await once(writer.process, 'exit')
    await writeFile(join(root, 'paper.qmd'), 'external-revision')
    await expect(NodeAgentProjectStore.open(root)).rejects.toMatchObject({ code: 'transaction-failed', message: expect.stringContaining('preserved') })
    expect(await readFile(join(root, 'paper.qmd'), 'utf8')).toBe('external-revision')
    expect(await readdir(join(root, '.draftmatter/transactions'))).toHaveLength(1)
  })

  it('rejects an oversized recovery manifest while preserving its evidence and manuscript', async () => {
    const transaction = join(root, '.draftmatter/transactions/v2-00000000-0000-4000-8000-000000000001')
    await mkdir(transaction, { recursive: true })
    await writeFile(join(transaction, 'manifest.json'), '')
    await truncate(join(transaction, 'manifest.json'), 16 * 1024 * 1024)
    await expect(NodeAgentProjectStore.open(root)).rejects.toMatchObject({ code: 'transaction-failed', message: expect.stringContaining('size limit') })
    expect(await readFile(join(root, 'paper.qmd'), 'utf8')).toBe('old-paper')
    expect(await readdir(transaction)).toEqual(['manifest.json'])
  })

  it('serializes same-process independent callers without requiring a shared store instance', async () => {
    let active = 0, maximum = 0
    await Promise.all(Array.from({ length: 10 }, () => withProjectWriteLock(root, async () => {
      active++; maximum = Math.max(maximum, active)
      await new Promise((resolve) => setTimeout(resolve, 3)); active--
    })))
    expect(maximum).toBe(1)
  })
})
