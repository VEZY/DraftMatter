import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { desktopProjectLaunchUrl } from './desktopLaunch'
import { runDraftMatterCli, type DraftMatterCliIo } from './draftmatterCli'

function launchDesktopUrl(url: string) {
  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'cmd.exe'
      : 'xdg-open'
  const arguments_ = process.platform === 'win32'
    ? ['/d', '/c', 'start', '', url]
    : [url]
  return new Promise<void>((resolveLaunch, rejectLaunch) => {
    const child = spawn(command, arguments_, { stdio: 'ignore', windowsHide: true })
    child.once('error', rejectLaunch)
    child.once('close', (code) => {
      if (code === 0) resolveLaunch()
      else rejectLaunch(new Error(`${command} exited with code ${code ?? 'unknown'}.`))
    })
  })
}

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
  async openApplication(projectPath) {
    const url = projectPath
      ? desktopProjectLaunchUrl(resolve(projectPath))
      : 'draftmatter://open'
    if (!url) throw new Error('The project folder path is invalid.')
    await launchDesktopUrl(url)
  },
  stdout(content) {
    process.stdout.write(content)
  },
  stderr(content) {
    process.stderr.write(content)
  },
}

process.exitCode = await runDraftMatterCli(process.argv.slice(2), io)
