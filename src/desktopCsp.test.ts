import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('desktop content security policy', () => {
  it('allows the CSL WebAssembly formatter without enabling general eval', () => {
    const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
    const csp = String(config.app.security.csp)
    const scriptDirective = csp.split(';').map((directive) => directive.trim()).find((directive) => directive.startsWith('script-src '))

    expect(scriptDirective).toContain("'self'")
    expect(scriptDirective).toContain("'wasm-unsafe-eval'")
    expect(scriptDirective).not.toMatch(/(?:^|\s)'unsafe-eval'(?:\s|$)/)
  })
})
