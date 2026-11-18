// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { submitOidcLogout } from './oidcBrowser'

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren() })

describe('browser identity logout', () => {
  it('posts the hint to the provider without putting it in URLs, history or retained DOM', () => {
    let submitted: { method: string; action: string; fields: Record<string, string> } | undefined
    vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(function(this: HTMLFormElement) {
      submitted = { method: this.method, action: this.action, fields: Object.fromEntries([...this.querySelectorAll('input')].map((input) => [input.name, input.value])) }
    })
    const location = window.location.href
    submitOidcLogout({ endpoint: 'https://identity.example.test/logout', clientId: 'draftmatter-public', idToken: 'private-identity-hint' })
    expect(submitted).toEqual({ method: 'post', action: 'https://identity.example.test/logout', fields: { client_id: 'draftmatter-public', id_token_hint: 'private-identity-hint' } })
    expect(window.location.href).toBe(location)
    expect(document.querySelector('form')).toBeNull()
    expect(document.documentElement.innerHTML).not.toContain('private-identity-hint')
  })

  it('rejects insecure or executable logout targets before submitting anything', () => {
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {})
    for (const endpoint of ['javascript:alert(1)', 'http://identity.example.test/logout', 'https://user:password@identity.example.test/logout']) {
      expect(() => submitOidcLogout({ endpoint, clientId: 'draftmatter-public' })).toThrow()
    }
    expect(submit).not.toHaveBeenCalled()
    expect(document.querySelector('form')).toBeNull()
  })
})
