import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const skill = join(root, 'integrations', 'skills', 'draftmatter-authoring')
const plugin = join(root, 'integrations', 'plugins', 'draftmatter')
const packageMetadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const skillSource = await readFile(join(skill, 'SKILL.md'), 'utf8')
const frontmatter = skillSource.match(/^---\n([\s\S]*?)\n---\n/)
assert.ok(frontmatter, 'The canonical skill requires YAML frontmatter.')
assert.match(frontmatter[1], /^name: draftmatter-authoring$/m)
assert.match(frontmatter[1], /^description: .{40,}$/m)
assert.doesNotMatch(skillSource, /\[TODO:|TODO placeholder/i)
assert.ok(skillSource.split('\n').length < 500, 'The canonical SKILL.md must remain under 500 lines.')

const openaiYaml = await readFile(join(skill, 'agents', 'openai.yaml'), 'utf8')
assert.match(openaiYaml, /display_name: "DraftMatter Authoring"/)
assert.match(openaiYaml, /default_prompt: "Use \$draftmatter-authoring /)

const sync = spawnSync(process.execPath, [join(root, 'scripts', 'sync-agent-integrations.mjs'), '--verify'], {
  cwd: root,
  encoding: 'utf8',
})
assert.equal(sync.status, 0, sync.stderr || sync.stdout)

const manifest = JSON.parse(await readFile(join(plugin, '.codex-plugin', 'plugin.json'), 'utf8'))
assert.equal(manifest.name, 'draftmatter')
assert.equal(manifest.version, packageMetadata.version)
assert.equal(manifest.mcpServers, './.mcp.json')
assert.equal(manifest.skills, './skills/')
assert.equal(manifest.license, 'MIT')
assert.equal(manifest.interface.composerIcon, './assets/icon.svg')
assert.match(await readFile(join(plugin, 'LICENSE'), 'utf8'), /^MIT License/)
assert.match(await readFile(join(plugin, 'README.md'), 'utf8'), /provider-neutral/)
assert.match(await readFile(join(plugin, 'assets', 'icon.svg'), 'utf8'), /<svg/)
const mcp = JSON.parse(await readFile(join(plugin, '.mcp.json'), 'utf8'))
assert.deepEqual(mcp.mcpServers.draftmatter, {
  command: 'draftmatter',
  args: ['mcp', '--stdio', '--project-root', '.'],
})

const marketplace = JSON.parse(await readFile(join(root, 'integrations', '.agents', 'plugins', 'marketplace.json'), 'utf8'))
const listing = marketplace.plugins.find((entry) => entry.name === 'draftmatter')
assert.equal(listing.source.source, 'local')
assert.equal(listing.source.path, './plugins/draftmatter')
assert.equal(listing.policy.installation, 'AVAILABLE')
const listedPlugin = resolve(root, 'integrations', listing.source.path)
assert.equal(listedPlugin, plugin)

const temporary = await mkdtemp(join(tmpdir(), 'draftmatter-plugin-install-'))
try {
  const installed = join(temporary, 'marketplace', 'plugins', 'draftmatter')
  const project = join(temporary, 'existing-project')
  await mkdir(project, { recursive: true })
  await writeFile(join(project, 'paper.qmd'), '# Project remains independent\n')
  await cp(plugin, installed, { recursive: true })
  assert.deepEqual(
    JSON.parse(await readFile(join(installed, '.codex-plugin', 'plugin.json'), 'utf8')),
    manifest,
  )
  assert.equal(
    await readFile(join(installed, 'skills', 'draftmatter-authoring', 'SKILL.md'), 'utf8'),
    skillSource,
  )
  await rm(installed, { recursive: true, force: true })
  assert.equal(await readFile(join(project, 'paper.qmd'), 'utf8'), '# Project remains independent\n')
} finally {
  await rm(temporary, { recursive: true, force: true })
}

process.stdout.write('DraftMatter canonical skill, generated copy, metadata, personal-marketplace install/uninstall isolation, and plugin integration validated.\n')
