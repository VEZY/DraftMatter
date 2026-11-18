import { describe, expect, it } from 'vitest'
import { alphaAccessLink } from './alphaAccess'

describe('closed alpha access links', () => {
  it('offers a contact request without implying public account creation', () => {
    expect(alphaAccessLink('editor@draftmatter.test')).toEqual({
      href: 'mailto:editor@draftmatter.test?subject=DraftMatter%20alpha%20access', external: false,
    })
  })

  it('supports a configured HTTPS invitation intake', () => {
    expect(alphaAccessLink('editor@draftmatter.test', ' https://research.example.test/invitations ')).toEqual({
      href: 'https://research.example.test/invitations', external: true,
    })
  })

  it.each(['javascript:alert(1)', 'data:text/html,example', 'http://intake.example.test/', 'https://account:secret@intake.example.test/', 'not a URL'])('rejects an unsafe optional intake %s', (signupUrl) => {
    expect(alphaAccessLink('editor@draftmatter.test', signupUrl).href).toBe('mailto:editor@draftmatter.test?subject=DraftMatter%20alpha%20access')
  })

  it('cannot inject extra mail recipients or headers through the contact field', () => {
    expect(alphaAccessLink('editor@example.test?bcc=other@example.test').href).toBe('mailto:contact@draftmatter.eu?subject=DraftMatter%20alpha%20access')
    expect(alphaAccessLink('editor@example.test\r\nBcc: other@example.test').href).toBe('mailto:contact@draftmatter.eu?subject=DraftMatter%20alpha%20access')
  })
})
