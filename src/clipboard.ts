export interface ClipboardEnvironment {
  clipboard?: { writeText: (text: string) => Promise<void> }
  document?: Document
}

/** Copy plain text through the modern API, with a WebView-safe DOM fallback. */
export async function copyPlainText(text: string, environment: ClipboardEnvironment = {}) {
  const clipboard = environment.clipboard ?? globalThis.navigator?.clipboard
  if (clipboard) {
    try {
      await clipboard.writeText(text)
      return true
    } catch {
      // Older WebViews can expose the API while rejecting writes; use the local fallback below.
    }
  }

  const document = environment.document ?? globalThis.document
  if (!document?.body || typeof document.execCommand !== 'function') return false
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.readOnly = true
  textarea.style.position = 'fixed'
  textarea.style.inset = '-1000px auto auto -1000px'
  document.body.append(textarea)
  textarea.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea.remove()
  }
}
