import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const executable = process.env.DRAFTMATTER_AGENT_HOST
  || join(root, 'src-tauri', 'target', 'debug', process.platform === 'win32' ? 'draftmatter-agent-host.exe' : 'draftmatter-agent-host')
await access(executable)

const child = spawn(executable, ['--project-root', root], {
  cwd: root,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})
const pending = new Map()
let stderr = ''
child.stderr.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-16_000) })
createInterface({ input: child.stdout }).on('line', (line) => {
  const response = JSON.parse(line)
  const waiter = pending.get(response.id)
  if (!waiter) return
  pending.delete(response.id)
  clearTimeout(waiter.timeout)
  if (response.ok) waiter.resolve(response.result)
  else waiter.reject(new Error(JSON.stringify(response.error)))
})
child.once('exit', (code, signal) => {
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timeout)
    waiter.reject(new Error(`Execution host exited with ${code ?? signal}: ${stderr}`))
  }
  pending.clear()
})

function call(action, parameters = {}, timeoutMs = 120_000) {
  const id = `verify:${crypto.randomUUID()}`
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Timed out waiting for ${action}. ${stderr}`))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timeout })
    child.stdin.write(`${JSON.stringify({ id, action, ...parameters })}\n`)
  })
}

try {
  const hello = await call('hello')
  assert.equal(hello.protocolVersion, 1)
  assert.equal(hello.persistentKernels, true)
  const initialTrust = await call('trust-status')
  assert.equal(initialTrust.trusted, false)
  await assert.rejects(
    call('crossref-search', { approved: false, query: '10.1016/j.envsoft.2019.104609' }),
    /explicit approval/,
  )
  const inventory = await call('kernels')
  assert.ok(Array.isArray(inventory.kernels))

  const kernel = inventory.kernels.find((candidate) => candidate.health === 'available' && candidate.language === 'python')
    ?? inventory.kernels.find((candidate) => candidate.health === 'available' && candidate.language === 'r')
  if (!kernel) {
    process.stdout.write('DraftMatter execution host protocol verified; no Python or R kernel was available for the live persistence check.\n')
  } else {
    await call('trust', { acknowledgement: 'run-project-code-with-user-permissions' })
    const firstCode = kernel.language === 'python'
      ? 'draftmatter_agent_value = 41\nprint(draftmatter_agent_value + 1)'
      : 'draftmatter_agent_value <- 41\ncat(draftmatter_agent_value + 1, "\\n")'
    const secondCode = kernel.language === 'python'
      ? 'print(draftmatter_agent_value + 2)'
      : 'cat(draftmatter_agent_value + 2, "\\n")'
    const first = await call('execute', {
      cellId: `agent-host-${kernel.language}-1`,
      language: kernel.language,
      kernelName: kernel.name,
      code: firstCode,
      attributes: { role: 'ordinary' },
      inputs: [],
    }, 20 * 60_000)
    assert.equal(first.status, 'ok')
    assert.match(first.messages.map((message) => message.text ?? '').join(''), /42/)
    const second = await call('execute', {
      cellId: `agent-host-${kernel.language}-2`,
      language: kernel.language,
      kernelName: kernel.name,
      code: secondCode,
      attributes: { role: 'ordinary' },
      inputs: [],
    }, 20 * 60_000)
    assert.equal(second.status, 'ok')
    assert.match(second.messages.map((message) => message.text ?? '').join(''), /43/)
    assert.equal(second.sessionGeneration, first.sessionGeneration)
    assert.ok(second.executionSequence > first.executionSequence)
    assert.equal((await call('terminate', { language: kernel.language })).terminated, true)
    process.stdout.write(`DraftMatter execution host verified with a persistent ${kernel.language} Jupyter session, trust, structured output, and termination.\n`)
  }
} finally {
  child.stdin.end()
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve()
    else child.once('exit', resolve)
  })
}
