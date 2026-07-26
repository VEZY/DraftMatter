import { basename, resolve } from 'node:path'
import {
  inspectAssistantConnections,
  planAssistantConnection,
  type AssistantConnectionOperation,
  type DraftMatterAssistantClient,
} from './assistantIntegration'

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

export async function runAssistantIntegrationCli(
  options: AssistantIntegrationCliOptions,
  io: AssistantIntegrationCliIo,
) {
  const launch = bundledLaunch()
  const clients: DraftMatterAssistantClient[] = options.client === 'all'
    ? ['codex', 'claude', 'copilot', 'vibe']
    : [options.client]
  if (options.operation === 'status') {
    const statuses = await inspectAssistantConnections(launch)
    const selected = statuses.filter((status) => clients.includes(status.client))
    io.stdout(`${JSON.stringify({ ok: true, scope: 'device', clients: selected })}\n`)
    return selected.every((status) => status.connected) ? 0 : 2
  }
  const results = []
  for (const client of clients) {
    results.push(await planAssistantConnection({
      ...launch,
      client,
      operation: options.operation,
      apply: options.apply,
    }))
  }
  const ok = results.every((result) => result.ok)
  io.stdout(`${JSON.stringify({ ok, scope: 'device', applied: options.apply && ok, results })}\n`)
  return ok ? 0 : 73
}
