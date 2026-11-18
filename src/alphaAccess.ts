export interface AlphaAccessLink {
  href: string
  external: boolean
}

/** Account creation stays invitation-only; this action only asks the operator. */
export function alphaAccessLink(contactEmail: string, signupUrl?: string): AlphaAccessLink {
  if (signupUrl?.trim()) {
    try {
      const url = new URL(signupUrl.trim())
      if (url.protocol === 'https:' && !url.username && !url.password) return { href: url.href, external: true }
    } catch { /* An invalid optional intake URL falls back to the contact address. */ }
  }
  const email = /^[^\s@<>?&#]+@[^\s@<>?&#]+\.[^\s@<>?&#]+$/.test(contactEmail)
    ? contactEmail
    : 'contact@draftmatter.eu'
  return { href: `mailto:${encodeURIComponent(email).replace('%40', '@')}?subject=DraftMatter%20alpha%20access`, external: false }
}
