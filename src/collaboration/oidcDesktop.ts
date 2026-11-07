import { isTauri, invoke } from '@tauri-apps/api/core'
import { completeOidcAuthorization, prepareOidcAuthorization, type OidcLoginResult } from './oidcBrowser'

export const DESKTOP_IDENTITY_CALLBACK = 'draftmatter://auth/callback'

interface DesktopIdentityHost {
  listen: (handler: (urls: string[]) => void) => Promise<() => void>
  open: (url: string) => Promise<void>
}

async function nativeHost(): Promise<DesktopIdentityHost> {
  const { onOpenUrl } = await import('@tauri-apps/plugin-deep-link')
  return { listen: onOpenUrl, open: (url) => invoke('open_identity_authorization', { url }) }
}

/** PKCE verifier and rotating tokens stay in this running app, never in a deep link or disk. */
export async function signInDesktop(
  serviceUrl: string,
  host?: DesktopIdentityHost,
  request: typeof fetch = fetch,
  webCrypto: Crypto = crypto,
  timeoutMs = 120_000,
): Promise<OidcLoginResult> {
  const entries = new Map<string, string>()
  const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value) }, removeItem: (key: string) => { entries.delete(key) } }
  const authorization = await prepareOidcAuthorization(serviceUrl, DESKTOP_IDENTITY_CALLBACK, storage, request, webCrypto)
  const expectedState = new URL(authorization.authorizationUrl).searchParams.get('state')
  const bridge = host ?? await nativeHost()
  let unlisten: (() => void) | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  let handling = false
  let finished = false
  try {
    return await new Promise<OidcLoginResult>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Sign-in timed out. Return to DraftMatter and sign in again.')), timeoutMs)
      void bridge.listen((urls) => {
        if (handling) return
        const callback = urls.find((value) => {
          try {
            const url = new URL(value)
            return `${url.protocol}//${url.host}${url.pathname}` === DESKTOP_IDENTITY_CALLBACK && !url.hash
              && url.searchParams.get('state') === expectedState
          } catch { return false }
        })
        if (!callback) return
        handling = true
        void completeOidcAuthorization(callback, storage, request).then((result) => {
          if (!result) throw new Error('The identity provider did not return a sign-in response.')
          resolve(result)
        }).catch(reject)
      }).then(async (stop) => {
        if (finished) { stop(); return }
        unlisten = stop
        await bridge.open(authorization.authorizationUrl)
      }).catch(reject)
    })
  } finally {
    finished = true
    if (timeout) clearTimeout(timeout)
    unlisten?.()
    entries.clear()
  }
}

export function usesDesktopIdentity() { return isTauri() }
