import { describe, expect, it } from 'vitest'
import { codexRegistration } from './codexRegistration'

const old = { command: '/old bundle/mcp', args: ['mcp', '--stdio'] }
const next = { command: '/new bundle/mcp', args: old.args }
const prefix = '# settings\r\nmodel = "local"\r\n'
const marker = '# draftmatter-assistant:'
const foreign = '\r\n[mcp_servers.node_repl]\r\ncommand = "other"\r\n[mcp_servers.node_repl.env]\r\nNOTE = "preserve me"\r\n'
const source = prefix + marker + 'start\r\n[mcp_servers."draftmatter"]\r\n'
  + "command = '/old bundle/mcp'  # personal comment\r\nargs = [\r\n 'mcp', '--stdio',\r\n]\r\n" + foreign + marker + 'end\r\n'

describe('Codex shared configuration', () => {
  it('recognizes the actual table despite reordered comments, quoting, multiline args and foreign tables', () => {
    expect(codexRegistration(source, old, false, false)).toMatchObject({ current: true, content: source })
    expect(codexRegistration(source, next, false, false, old).content).toBe(source.replace("'/old bundle/mcp'", JSON.stringify(next.command)))
    expect(codexRegistration(source, next, false, false)).toMatchObject({ conflict: expect.stringContaining('Reconnect'), content: source })
    expect(codexRegistration(source, next, false, true).content).toBe(source.replace("'/old bundle/mcp'", JSON.stringify(next.command)))
    expect(codexRegistration(source, old, true, false).content).toBe(prefix + '  # personal comment\r\n' + foreign)
  })

  it('preserves extra Codex settings and refuses an ambiguous disconnect', () => {
    const extra = source.replace('args =', 'enabled_tools = ["draftmatter_project"]\r\nargs =')
    expect(codexRegistration(extra, next, false, true).content).toBe(extra.replace("'/old bundle/mcp'", JSON.stringify(next.command)))
    expect(codexRegistration(extra, old, true, true)).toMatchObject({ content: extra, conflict: expect.stringContaining('additional settings') })
  })

  it('leaves unowned registrations and broken markers alone, even on repair', () => {
    for (const input of [source.replace(marker + 'end', '# unrelated'), source.replaceAll(marker, '# user:')]) {
      expect(codexRegistration(input, next, false, true)).toMatchObject({ content: input, conflict: expect.any(String) })
    }
    expect(() => codexRegistration('model = [', next, false, true)).toThrow(/Fix the TOML at line/)
  })
})
