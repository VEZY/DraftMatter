import assert from 'node:assert/strict'
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { delimiter, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const repository = resolve(import.meta.dirname, '..')
const cli = join(repository, 'dist-cli', 'draftmatter.js')
const host = join(repository, 'src-tauri', 'target', 'debug', process.platform === 'win32' ? 'draftmatter-agent-host.exe' : 'draftmatter-agent-host')
await Promise.all([access(cli), access(host)])

async function executableOnPath(name) {
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
    : ['']
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    for (const extension of extensions) {
      const candidate = join(directory, process.platform === 'win32' ? `${name}${extension}` : name)
      try {
        await access(candidate)
        return candidate
      } catch {
        // Keep searching.
      }
    }
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 120_000,
    ...options,
  })
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')} failed (${result.status}):\n${result.stderr || result.stdout}`,
  )
  return result.stdout
}

const bundledCodex = process.platform === 'darwin'
  ? '/Applications/ChatGPT.app/Contents/Resources/codex'
  : undefined
const codex = process.env.CODEX_CLI_PATH
  ?? (bundledCodex && await access(bundledCodex).then(() => bundledCodex, () => undefined))
  ?? await executableOnPath('codex')
const vibe = await executableOnPath('vibe')
if (!codex || !vibe) {
  process.stdout.write(`Installed-client verification skipped: ${[
    !codex ? 'Codex' : undefined,
    !vibe ? 'Vibe' : undefined,
  ].filter(Boolean).join(' and ')} not found on PATH.\n`)
  process.exit(0)
}

const temporary = await mkdtemp(join(tmpdir(), 'draftmatter-installed-clients-'))
const project = join(temporary, 'client project with spaces')
const bin = join(temporary, 'bin')
const deviceHome = join(temporary, 'device-home')
const vibeHome = join(deviceHome, '.vibe')
const codexHome = join(deviceHome, '.codex')
try {
  await Promise.all([
    mkdir(join(project, '.draftmatter'), { recursive: true }),
    mkdir(bin, { recursive: true }),
    mkdir(deviceHome, { recursive: true }),
    mkdir(vibeHome, { recursive: true }),
    mkdir(codexHome, { recursive: true }),
  ])
  await writeFile(join(project, '.draftmatter', 'project.json'), `${JSON.stringify({
    schemaVersion: 1,
    name: 'Installed client verification',
    mainDocument: 'paper.qmd',
    citationStyle: 'draftmatter-author-date',
    citationLocale: 'en-US',
    citationBibliography: 'references.json',
    execution: { python: {}, r: {}, julia: {} },
  }, null, 2)}\n`)
  await writeFile(join(project, 'paper.qmd'), '# Installed client verification\n\nOriginal sentence.\n')
  await writeFile(join(project, 'references.json'), '[]\n')
  run('git', ['init', '--quiet', project], { cwd: temporary })
  const shim = join(bin, process.platform === 'win32' ? 'draftmatter.js' : 'draftmatter')
  await copyFile(cli, shim)
  if (process.platform !== 'win32') await chmod(shim, 0o755)
  const clientEnvironment = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
    HOME: deviceHome,
    USERPROFILE: deviceHome,
    CODEX_HOME: codexHome,
    VIBE_HOME: vibeHome,
    DRAFTMATTER_AGENT_HOST: host,
  }
  const codexVersion = run(codex, ['--version'], {
    cwd: project,
    env: { ...clientEnvironment, CODEX_HOME: codexHome },
  }).trim()

  run(process.execPath, [
    cli,
    'assistants',
    'install',
    'codex',
    '--apply',
  ], { cwd: repository, env: clientEnvironment })
  run(process.execPath, [
    cli,
    'assistants',
    'install',
    'vibe',
    '--apply',
  ], { cwd: repository, env: clientEnvironment })
  run(process.execPath, [
    cli,
    'ai',
    'enable',
    '--project-root',
    project,
    '--apply',
  ], { cwd: repository, env: clientEnvironment })

  const codexConfigPath = join(codexHome, 'config.toml')
  const codexConfig = await readFile(codexConfigPath, 'utf8').catch(() => '')
  await writeFile(codexConfigPath, `${codexConfig}${codexConfig ? '\n' : ''}[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n`)
  const codexPrompt = JSON.parse(run(codex, ['-C', project, 'debug', 'prompt-input', 'Verify project discovery only.'], {
    cwd: project,
    env: { ...clientEnvironment, CODEX_HOME: codexHome },
  }))
  assert.match(JSON.stringify(codexPrompt), /draftmatter-authoring/)
  assert.match(JSON.stringify(codexPrompt), /DraftMatter AI authoring/)
  const codexMcp = JSON.parse(run(codex, [
    '-C',
    project,
    'mcp',
    'list',
    '--json',
  ], {
    cwd: project,
    env: { ...clientEnvironment, CODEX_HOME: codexHome },
  }))
  assert.match(JSON.stringify(codexMcp), /draftmatter/)
  assert.doesNotMatch(JSON.stringify(codexMcp), /project-root/)
  await assert.rejects(readFile(join(project, '.codex', 'config.toml'), 'utf8'))

  const vibeLauncher = await readFile(vibe, 'utf8')
  const python = vibeLauncher.match(/^#!([^\r\n]+)/)?.[1]
  assert.ok(python, 'The installed Vibe launcher does not expose its Python runtime.')
  const probe = `
import json
import importlib.metadata
from pathlib import Path
from vibe.core.paths.config_paths import unlock_config_paths
from vibe.core.trusted_folders import trusted_folders_manager
trusted_folders_manager.add_trusted(Path.cwd())
unlock_config_paths()
from vibe.core.config import VibeConfig
from vibe.core.skills.manager import SkillManager
from vibe.core.tools.manager import ToolManager
import asyncio
config = VibeConfig.load()
skills = SkillManager(lambda: config).available_skills
manager = ToolManager(lambda: config)
tools = manager.available_tools

async def invoke(name, **arguments):
    result = None
    async for item in manager.get(name).invoke(**arguments):
        if hasattr(item, "structured"):
            result = item
    if result is None:
        raise RuntimeError(f"{name} returned no MCP result")
    if not result.ok:
        raise RuntimeError(result.text or f"{name} failed")
    return result.structured

async def verify_workflow():
    inspected = await invoke("draftmatter_draftmatter_project", action="inspect")
    suggested = await invoke(
        "draftmatter_draftmatter_review",
        action="suggest",
        mode="suggest",
        expectedRevision=inspected["revision"],
        idempotencyKey="vibe-client-suggestion-001",
        actor={"id": "agent:vibe-verifier", "name": "Vibe compatibility verifier"},
        selector={"kind": "quote", "quote": "Original sentence."},
        proposal="The original sentence was reviewed through Vibe's MCP adapter.",
        rationale="Verify a provider-neutral tracked suggestion.",
    )
    review = await invoke("draftmatter_draftmatter_review", action="inspect")
    return {
        "revision": suggested["revision"],
        "suggestion": suggested["result"]["suggestion"]["reference"],
        "reviewCount": review["result"]["total"],
    }

workflow = asyncio.run(verify_workflow())
print(json.dumps({
  "version": importlib.metadata.version("mistral-vibe"),
  "servers": [server.name for server in config.mcp_servers],
  "skills": sorted(skills),
  "tools": sorted(name for name in tools if name.startswith("draftmatter_")),
  "workflow": workflow,
}))
`
  const vibeResult = JSON.parse(run(python, ['-c', probe], {
    cwd: project,
    env: {
      ...clientEnvironment,
      VIBE_HOME: vibeHome,
      MISTRAL_API_KEY: 'verification-placeholder-not-used',
    },
  }).trim().split('\n').at(-1))
  assert.deepEqual(vibeResult.servers, ['draftmatter'])
  assert.ok(vibeResult.skills.includes('draftmatter-authoring'))
  assert.deepEqual(vibeResult.tools, [
    'draftmatter_draftmatter_computation',
    'draftmatter_draftmatter_manuscript',
    'draftmatter_draftmatter_project',
    'draftmatter_draftmatter_references',
    'draftmatter_draftmatter_review',
    'draftmatter_draftmatter_validate',
  ])
  assert.match(vibeResult.workflow.suggestion, /^review:/)
  assert.equal(vibeResult.workflow.reviewCount, 1)
  assert.match(await readFile(join(project, 'paper.qmd'), 'utf8'), /Vibe compatibility verifier/)
  assert.match(await readFile(join(project, 'AGENTS.md'), 'utf8'), /draftmatter-authoring/)
  await assert.rejects(readFile(join(project, '.vibe', 'config.toml'), 'utf8'))
  process.stdout.write(`Installed client compatibility verified without a model/API call: ${codexVersion} loaded enabled-project instructions and discovered the device-wide DraftMatter MCP registration; Mistral Vibe ${vibeResult.version} loaded the device-wide MCP server and canonical skill, then persisted and reinspected a tracked suggestion in the separately enabled project.\n`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
