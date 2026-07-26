import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, resolve } from 'node:path'
import {
  inspectAssistantConnections,
  planAssistantConnection,
  type AssistantConnectionOperation,
  type DraftMatterAssistantClient,
} from './assistantIntegration'

const execFileAsync = promisify(execFile)

export interface AssistantIntegrationCliOptions {
  operation: AssistantConnectionOperation | 'status'
  client: DraftMatterAssistantClient | 'all'
  apply: boolean
}

export interface AssistantIntegrationCliIo {
  stdout(content: string): void
}

function bundledLaunch() {
  const override = process.env.DRAFTMATTER_BUNDLED_MCP_COMMAND
  if (override) return { bundledCommand: override, bundledArgs: [] as string[] }
  if (/^node(?:\.exe)?$/iu.test(basename(process.execPath))) {
    return {
      bundledCommand: process.execPath,
      bundledArgs: process.argv[1] ? [resolve(process.argv[1])] : [],
    }
  }
  return { bundledCommand: process.execPath, bundledArgs: [] as string[] }
}

async function codexPluginContext() {
  let listOutput: string
  try {
    const result = await execFileAsync('codex', ['plugin', 'list'], {
      env: process.env,
      timeout: 10_000,
    })
    listOutput = result.stdout
  } catch {
    return {
      codexPluginAvailable: false,
      codexPluginInstalled: false,
    }
  }

  let installed = /(?:^|[^a-z0-9_-])draftmatter(?:@|[^a-z0-9_-]|$)/imu.test(listOutput)

  return {
    codexPluginAvailable: true,
    codexPluginInstalled: installed,
    applyCodexPlugin: async (operation: AssistantConnectionOperation) => {
      if (operation === 'remove') {
        if (installed) {
          await execFileAsync('codex', ['plugin', 'remove', 'draftmatter'], {
            env: process.env,
            timeout: 30_000,
          })
          installed = false
        }
        return
      }
      if (!installed) {
        await execFileAsync('codex', ['plugin', 'add', 'draftmatter@personal'], {
          env: process.env,
          timeout: 30_000,
        })
        installed = true
      }
    },
  }
}

export async function runAssistantIntegrationCli(
  options: AssistantIntegrationCliOptions,
  io: AssistantIntegrationCliIo,
) {
  const launch = bundledLaunch()
  const codex = await codexPluginContext()
  const clients: DraftMatterAssistantClient[] = options.client === 'all'
    ? ['codex', 'claude', 'copilot', 'vibe']
    : [options.client]
  if (options.operation === 'status') {
    const statuses = await inspectAssistantConnections({ ...launch, ...codex })
    const selected = statuses.filter((status) => clients.includes(status.client))
    io.stdout(`${JSON.stringify({ ok: true, scope: 'device', clients: selected })}\n`)
    return selected.every((status) => status.connected) ? 0 : 2
  }
  const results = []
  for (const client of clients) {
    results.push(await planAssistantConnection({
      ...launch,
      ...(client === 'codex' ? codex : {}),
      client,
      operation: options.operation,
      apply: options.apply,
    }))
  }
  const ok = results.every((result) => result.ok)
  io.stdout(`${JSON.stringify({ ok, scope: 'device', applied: options.apply && ok, results })}\n`)
  return ok ? 0 : 73
}
