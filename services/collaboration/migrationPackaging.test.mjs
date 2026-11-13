import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { copyCollaborationAssets } from '../../scripts/copy-collaboration-assets.mjs'

const temporary = []
afterEach(async () => { await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'draftmatter-migration-package-'))
  temporary.push(directory)
  const sourceDirectory = join(directory, 'source'), targetDirectory = join(directory, 'dist', 'migrations')
  await mkdir(sourceDirectory)
  return { directory, sourceDirectory, targetDirectory }
}

describe('collaboration migration packaging', () => {
  it('packages every real migration byte-for-byte, including project files and backup retention', async () => {
    const { targetDirectory } = await fixture()
    const sourceDirectory = new URL('./migrations/', import.meta.url)
    const expected = (await readdir(sourceDirectory)).filter((file) => /^\d+_[a-z0-9_]+\.sql$/i.test(file)).sort()
    const copied = await copyCollaborationAssets({ targetDirectory })
    expect(copied).toEqual(expected)
    expect(copied).toContain('010_project_files.sql')
    expect(copied).toContain('011_alpha_backup_retention.sql')
    expect((await readdir(targetDirectory)).sort()).toEqual(expected)
    for (const file of expected) expect(await readFile(join(targetDirectory, file))).toEqual(await readFile(new URL(file, sourceDirectory)))
  })

  it('discovers future migrations deterministically and only removes stale regular migration assets', async () => {
    const { sourceDirectory, targetDirectory } = await fixture()
    await mkdir(targetDirectory, { recursive: true })
    for (const file of ['999_future_feature.sql', '011_latest.sql', '001_initial.sql', 'notes.sql', '012-invalid.sql', '013_extra.sql.bak']) {
      await writeFile(join(sourceDirectory, file), `-- ${file}\nSELECT 1;\n`)
    }
    await mkdir(join(sourceDirectory, '014_directory.sql'))
    for (const file of ['009_removed.sql', 'notes.sql', '001_initial.sql.bak']) await writeFile(join(targetDirectory, file), `Keep ${file}`)
    await mkdir(join(targetDirectory, '015_archive.sql'))
    await writeFile(join(targetDirectory, '015_archive.sql', 'keep.txt'), 'Keep this directory')
    const expected = ['001_initial.sql', '011_latest.sql', '999_future_feature.sql']
    expect(await copyCollaborationAssets({ sourceDirectory, targetDirectory })).toEqual(expected)
    expect((await readdir(targetDirectory)).sort()).toEqual([...expected, 'notes.sql', '001_initial.sql.bak', '015_archive.sql'].sort())
    expect(await readFile(join(targetDirectory, 'notes.sql'), 'utf8')).toBe('Keep notes.sql')
    expect(await readFile(join(targetDirectory, '015_archive.sql', 'keep.txt'), 'utf8')).toBe('Keep this directory')
    // A repeat build replaces changed migration bytes, rather than leaving stale SQL.
    await writeFile(join(sourceDirectory, '011_latest.sql'), '-- revised\nSELECT 2;\n')
    expect(await copyCollaborationAssets({ sourceDirectory, targetDirectory })).toEqual(expected)
    expect(await readFile(join(targetDirectory, '011_latest.sql'), 'utf8')).toBe('-- revised\nSELECT 2;\n')
  })

  it.skipIf(process.platform === 'win32')('excludes source links and refuses to overwrite a destination link', async () => {
    const { directory, sourceDirectory, targetDirectory } = await fixture()
    const external = join(directory, 'external.sql')
    await writeFile(external, 'Preserve external contents')
    await symlink(external, join(sourceDirectory, '011_link.sql'))
    expect(await copyCollaborationAssets({ sourceDirectory, targetDirectory })).toEqual([])
    await writeFile(join(sourceDirectory, '001_initial.sql'), 'SELECT 1;')
    await symlink(external, join(targetDirectory, '001_initial.sql'))
    await expect(copyCollaborationAssets({ sourceDirectory, targetDirectory })).rejects.toThrow(/not a regular file/)
    expect(await readFile(external, 'utf8')).toBe('Preserve external contents')
  })
})
