import { copyFile, mkdir, readdir, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Keep the format in sync with the discovery performed by migrations.ts.
const migrationName = /^\d+_[a-z0-9_]+\.sql$/i
const source = fileURLToPath(new URL('../services/collaboration/migrations/', import.meta.url))
const target = fileURLToPath(new URL('../dist-service/migrations/', import.meta.url))

export async function copyCollaborationAssets({ sourceDirectory = source, targetDirectory = target } = {}) {
  const files = (await readdir(sourceDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && migrationName.test(entry.name))
    .map((entry) => entry.name).sort()
  await mkdir(targetDirectory, { recursive: true })
  const existing = await readdir(targetDirectory, { withFileTypes: true })
  for (const file of files) {
    const destination = existing.find((entry) => entry.name === file)
    if (destination && !destination.isFile()) throw new Error(`Migration asset destination is not a regular file: ${file}`)
    await copyFile(join(sourceDirectory, file), join(targetDirectory, file))
  }
  // Remove only stale regular migration assets; preserve unrelated build files,
  // directories and links, including names ending in .sql outside this format.
  for (const entry of existing) {
    if (entry.isFile() && migrationName.test(entry.name) && !files.includes(entry.name)) await unlink(join(targetDirectory, entry.name))
  }
  return files
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const files = await copyCollaborationAssets()
  process.stdout.write(`Copied ${files.length} collaboration migration assets to ${target}.\n`)
}
