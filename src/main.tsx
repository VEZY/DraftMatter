import { initializePublicRuntimeConfiguration } from './publicRuntimeConfiguration'

async function startApplication() {
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
