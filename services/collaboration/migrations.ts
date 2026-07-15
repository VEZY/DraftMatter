import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Pool, PoolClient } from 'pg'

export interface MigrationResult {
  applied: string[]
  alreadyApplied: string[]
}

type MigrationDatabase = Pick<Pool, 'connect'>

async function transaction<T>(pool: MigrationDatabase, run: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await run(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function runCollaborationMigrations(pool: MigrationDatabase, directory = join(dirname(fileURLToPath(import.meta.url)), 'migrations')): Promise<MigrationResult> {
  const files = (await readdir(directory)).filter((file) => /^\d+_[a-z0-9_]+\.sql$/i.test(file)).sort()
  const applied: string[] = []
  const alreadyApplied: string[] = []
  await pool.connect().then(async (client) => {
    try {
      await client.query('CREATE TABLE IF NOT EXISTS draftmatter_schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)')
    } finally {
      client.release()
    }
  })
  for (const file of files) {
    const version = file.slice(0, file.indexOf('_'))
    await transaction(pool, async (client) => {
      const existing = await client.query<{ version: string }>('SELECT version FROM draftmatter_schema_migrations WHERE version = $1', [version])
      if (existing.rowCount) {
        alreadyApplied.push(version)
        return
      }
      await client.query(await readFile(join(directory, file), 'utf8'))
      await client.query('INSERT INTO draftmatter_schema_migrations(version) VALUES ($1)', [version])
      applied.push(version)
    })
  }
  return { applied, alreadyApplied }
}
