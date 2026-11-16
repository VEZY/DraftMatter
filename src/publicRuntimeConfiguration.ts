import { validatePublicRuntimeConfiguration, type PublicRuntimeConfiguration } from './publicConfigurationModel.mjs'

declare global {
  var __DRAFTMATTER_PUBLIC_ENVIRONMENT__: PublicRuntimeConfiguration['environment'] | undefined
}

const MAX_PUBLIC_CONFIGURATION_BYTES = 128 * 1024

/** Run before importing the application: legal/contact constants read it at import time. */
export async function initializePublicRuntimeConfiguration(required: boolean, fetchConfiguration: typeof fetch = fetch) {
  if (!required) return
  delete globalThis.__DRAFTMATTER_PUBLIC_ENVIRONMENT__
  const response = await fetchConfiguration('/draftmatter-public-config.json', {
    credentials: 'omit', cache: 'no-store', redirect: 'error',
    headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type')?.trim() ?? '')) {
    throw new Error('The public web configuration is unavailable.')
  }
  if (Number(response.headers.get('content-length') ?? 0) > MAX_PUBLIC_CONFIGURATION_BYTES) {
    throw new Error('The public web configuration exceeds its size limit.')
  }
  if (!response.body) throw new Error('The public web configuration is empty.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let source = '', bytes = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > MAX_PUBLIC_CONFIGURATION_BYTES) {
        await reader.cancel()
        throw new Error('The public web configuration exceeds its size limit.')
      }
      source += decoder.decode(next.value, { stream: true })
    }
    source += decoder.decode()
  } finally {
    reader.releaseLock()
  }
  let payload: unknown
  try { payload = JSON.parse(source) }
  catch { throw new Error('The public web configuration is invalid JSON.') }
  const configuration = validatePublicRuntimeConfiguration(payload)
  Object.defineProperty(globalThis, '__DRAFTMATTER_PUBLIC_ENVIRONMENT__', {
    configurable: true, enumerable: false, writable: false, value: configuration.environment,
  })
}

export function publicRuntimeEnvironment() {
  return globalThis.__DRAFTMATTER_PUBLIC_ENVIRONMENT__
}
