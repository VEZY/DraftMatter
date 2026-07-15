import { loadCollaborationServiceConfig } from './config'
import { createCollaborationService } from './serviceRuntime'

const config = loadCollaborationServiceConfig()
const service = createCollaborationService(config)
const address = await service.start()

process.stdout.write(`${JSON.stringify({
  level: 'info',
  event: 'collaboration.started',
  address: address.address,
  port: address.port,
  environment: config.environment,
})}\n`)

let stopping = false
async function stop(signal: string) {
  if (stopping) return
  stopping = true
  process.stdout.write(`${JSON.stringify({ level: 'info', event: 'collaboration.stopping', signal })}\n`)
  try {
    await service.stop()
    process.exitCode = 0
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ level: 'error', event: 'collaboration.shutdown_failed', message: error instanceof Error ? error.message : 'Unknown shutdown failure.' })}\n`)
    process.exitCode = 1
  }
}

process.once('SIGINT', () => void stop('SIGINT'))
process.once('SIGTERM', () => void stop('SIGTERM'))
