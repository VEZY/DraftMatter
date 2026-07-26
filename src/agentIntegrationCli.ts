import { diagnoseDraftMatterAi, planDraftMatterAiIntegration, type DraftMatterAiOperation } from './agentIntegration'

export interface DraftMatterAiCliIo {
  stdout(content: string): void
  stderr(content: string): void
}

export interface DraftMatterAiCliOptions {
  operation: DraftMatterAiOperation | 'doctor'
  projectRoot: string
  apply: boolean
  portableSkillFallback?: boolean
}

function emit(io: DraftMatterAiCliIo, value: unknown) {
  io.stdout(`${JSON.stringify(value)}\n`)
}

export async function runDraftMatterAiCli(options: DraftMatterAiCliOptions, io: DraftMatterAiCliIo) {
  try {
    if (options.operation === 'doctor') {
      const result = await diagnoseDraftMatterAi(options.projectRoot)
      emit(io, result)
      return result.ok ? 0 : 2
    }
    const result = await planDraftMatterAiIntegration({
      projectRoot: options.projectRoot,
      operation: options.operation,
      apply: options.apply,
      ...(options.portableSkillFallback === undefined ? {} : { portableSkillFallback: options.portableSkillFallback }),
    })
    emit(io, result)
    return result.ok ? 0 : 73
  } catch (error) {
    emit(io, {
      ok: false,
      schemaVersion: 2,
      error: {
        code: 'ai-integration-failed',
        message: error instanceof Error ? error.message : String(error),
      },
    })
    return 70
  }
}
