import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { runDraftMatterCli, type DraftMatterCliIo } from './draftmatterCli'

const io: DraftMatterCliIo = {
  async readText(path) {
    return path === '-' ? readFileSync(0, 'utf8') : readFile(path, 'utf8')
  },
  async writeText(path, content) {
    if (path === '-') {
      process.stdout.write(content)
      return
    }
    const temporary = join(dirname(path), `.${basename(path)}.draftmatter-${process.pid}-${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, content, 'utf8')
      await rename(temporary, path)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  },
  stdout(content) {
    process.stdout.write(content)
  },
  stderr(content) {
    process.stderr.write(content)
  },
}

process.exitCode = await runDraftMatterCli(process.argv.slice(2), io)
