import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('desktop content security policy', () => {
  it('allows encrypted collaboration and loopback development without permitting remote HTTP or scripts', () => {
    const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
    const csp = String(config.app.security.csp)
    const connect = csp.split(';').find((part) => part.trim().startsWith('connect-src'))!.trim().split(/\s+/)
    expect(connect).toContain('https:')
    expect(connect).toContain('wss:')
    expect(connect).toContain('ws://127.0.0.1:*')
    expect(connect).not.toContain('http:')
    expect(connect).not.toContain('ws:')
    expect(connect).not.toContain('*')
    expect(csp.split(';').find((part) => part.trim().startsWith('script-src'))).not.toContain('https:')
  })
  it('allows the CSL WebAssembly formatter without enabling general eval', () => {
    const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
    const csp = String(config.app.security.csp)
    const scriptDirective = csp.split(';').map((directive) => directive.trim()).find((directive) => directive.startsWith('script-src '))

    expect(scriptDirective).toContain("'self'")
    expect(scriptDirective).toContain("'wasm-unsafe-eval'")
    expect(scriptDirective).not.toMatch(/(?:^|\s)'unsafe-eval'(?:\s|$)/)
  })
})
