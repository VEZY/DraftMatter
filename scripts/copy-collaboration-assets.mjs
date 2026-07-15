import { cp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const root = new URL('..', import.meta.url)
const target = new URL('../dist-service/migrations/', import.meta.url)
await mkdir(target, { recursive: true })
for (const file of ['001_managed_collaboration.sql', '002_rate_limits_and_recovery.sql', '003_managed_identity.sql']) {
  await cp(new URL(`../services/collaboration/migrations/${file}`, import.meta.url), new URL(file, target))
}

process.stdout.write(`Copied collaboration migration assets to ${join(root.pathname, 'dist-service/migrations')}.\n`)
