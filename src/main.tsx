import { initializePublicRuntimeConfiguration } from './publicRuntimeConfiguration'
import { installBrowserDemoStorage, isBrowserDemoLocation } from './browserDemo'

async function startApplication() {
  // Install before importing anything that might read a manuscript, profile or
  // pending sign-in. A public example must never borrow a visitor's real draft.
  if (isBrowserDemoLocation(window.location)) installBrowserDemoStorage()
  await initializePublicRuntimeConfiguration(import.meta.env.VITE_DM_RUNTIME_PUBLIC_CONFIG === 'true')
  await import('./renderApplication')
}

void startApplication().catch(() => {
  const root = document.getElementById('root')
  if (!root) return
  root.replaceChildren()
  const message = document.createElement('p')
  message.setAttribute('role', 'alert')
  message.textContent = 'DraftMatter cannot start because its public site configuration is unavailable. Please contact the site operator.'
  root.append(message)
})
