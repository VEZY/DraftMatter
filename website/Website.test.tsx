// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Website } from './Website'
import { LegalDocumentContent } from '../src/legalContent'
import { readLegalConfiguration } from '../src/legalConfig'

// Keep component tests independent of the actual hosting variables used by CI.
// A distinct contact checks that the website renders configured legal metadata.
vi.mock('../src/legalConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/legalConfig')>()
  return {
    ...actual,
    legalConfiguration: actual.readLegalConfiguration({
      VITE_DM_LEGAL_PUBLISHER_NAME: 'Website test editor',
      VITE_DM_LEGAL_CONTACT_EMAIL: 'website-editor@draftmatter.test',
      VITE_DM_LEGAL_HOSTING_DETAILS: 'Static website test hosting',
      VITE_DM_LEGAL_DATA_LOCATION: 'Isolated website test environment',
      VITE_DM_LEGAL_ADDITIONAL_PROCESSORS: 'Test contact provider',
    }),
  }
})

describe('DraftMatter website', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    vi.stubEnv('VITE_ALPHA_SIGNUP_URL', '')
    window.history.replaceState({}, '', '/DraftMatter/')
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('preserves the paper-led product story and interactive guided preview', async () => {
    await act(async () => root.render(<Website />))

    expect(container.querySelector('h1')?.textContent).toBe('Your paper should be as reproducible as your research.')
    expect(container.textContent).toContain('Research writing, with the missing pieces built in.')
    expect(container.textContent).toContain('DraftMatter brings writing, citations, reproducible results, review, and collaboration into one focused workspace.')
    expect(container.querySelector('.home-hero-manuscript-scroll')).not.toBeNull()
    expect(container.querySelectorAll('.home-showcase-tabs [role="tab"]')).toHaveLength(6)
    expect(container.textContent).toContain('The paper remains yours.')
    expect(container.querySelector('.home-app-setup')).toBeNull()
  })

  it('labels the alpha honestly and falls back to GitHub until intake is configured', async () => {
    await act(async () => root.render(<Website />))

    const alpha = container.querySelector<HTMLElement>('#alpha')!
    expect(alpha.textContent).toContain('Private alpha · pre-release')
    expect(alpha.textContent).toContain('No DraftMatter account required for local papers')
    expect(alpha.textContent).toContain('No public download is advertised until a supported pre-release exists.')
    expect(alpha.querySelector<HTMLAnchorElement>('a')?.href).toBe('https://github.com/VEZY/DraftMatter/releases')
  })

  it('scrolls the product action to the guided preview', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    await act(async () => root.render(<Website />))

    const action = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('See how it works'))!
    await act(async () => action.click())

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
  })

  it('offers legal documents under the configured website base without opening the application', async () => {
    await act(async () => root.render(<Website />))
    const links = [...container.querySelectorAll<HTMLAnchorElement>('.legal-links a')]
    expect(links).toHaveLength(3)
    expect(links.map((link) => link.textContent)).toEqual(['Legal notice', 'Privacy policy', 'Terms of use'])
    for (const link of links) expect(link.getAttribute('href')).toMatch(/^.*#legal\//)
    expect(container.textContent).toContain('The hosted alpha is free and available by invitation.')
  })

  it('opens a bookmarked legal document and returns to the website through hash navigation', async () => {
    window.history.replaceState({}, '', '/DraftMatter/#legal/confidentialite')
    await act(async () => root.render(<Website />))
    expect(container.querySelector('main')?.lang).toBe('en')
    expect(container.querySelector('h1')?.textContent).toBe('Privacy policy')
    expect(container.querySelector<HTMLAnchorElement>('a[href^="mailto:"]')?.href).toBe('mailto:website-editor@draftmatter.test')
    expect(container.querySelector('.home-showcase')).toBeNull()
    await act(async () => {
      window.history.replaceState({}, '', '/DraftMatter/#top')
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(container.querySelector('h1')?.textContent).toContain('Your paper should be')
  })

  it('shows the pre-production backup responsibilities in the public website terms', async () => {
    window.history.replaceState({}, '', '/DraftMatter/#legal/conditions-utilisation')
    await act(async () => root.render(<Website />))
    expect(container.querySelector('h1')?.textContent).toBe('Terms of use')
    const heading = [...container.querySelectorAll('h2')].find((element) => element.textContent === 'Testing and data loss')
    const warning = heading?.closest('section')?.textContent ?? ''
    expect(warning).toMatch(/pre-production/i)
    expect(warning).toMatch(/data loss/i)
    expect(warning).toMatch(/independent backups/i)
    expect(warning).toMatch(/outside (?:DraftMatter|the service)/i)
    expect(warning).toMatch(/synchroni[sz]ation/i)
    expect(warning).toMatch(/history/i)
    expect(warning).toMatch(/server backups/i)
    expect(warning).toMatch(/You are .*responsible .*independent backups/i)
    expect(warning).toMatch(/Synchroni[sz]ation, version history and server backups do not replace independent backups/i)
    expect(container.querySelector('article')?.textContent).toMatch(/(?:mandatory|statutory).*rights|rights.*(?:mandatory|statutory)/i)
    expect(container.querySelector('article')?.textContent).not.toMatch(/Docker|PostgreSQL|\bS3\b|Keycloak|\bVPS\b/i)
  })

  it.each(['mentions-legales', 'confidentialite'] as const)('shows concise public hosting information in %s without infrastructure details', async (documentId) => {
    const hostingDetails = 'Hosting Test SAS, 10 Research Street, Paris, France. Contact: hosting@example.fr.'
    const dataLocation = 'France, with a French hosting company.'
    const configuration = readLegalConfiguration({
      VITE_DM_LEGAL_PUBLISHER_NAME: 'Test operator',
      VITE_DM_LEGAL_CONTACT_EMAIL: 'operator@example.fr',
      VITE_DM_LEGAL_HOSTING_DETAILS: hostingDetails,
      VITE_DM_LEGAL_DATA_LOCATION: dataLocation,
      VITE_DM_LEGAL_ADDITIONAL_PROCESSORS: 'No additional processors for this test instance.',
    })
    await act(async () => root.render(<LegalDocumentContent documentId={documentId} configuration={configuration} />))
    expect(container.textContent).toContain(dataLocation)
    if (documentId === 'mentions-legales') expect(container.textContent).toContain(hostingDetails)
    else expect(container.textContent).not.toContain(hostingDetails)
    expect(container.textContent).not.toMatch(/Docker|PostgreSQL|\bS3\b|Keycloak|\bVPS\b/i)
  })

  it('describes unconfigured alpha hosting as planned rather than already deployed', async () => {
    await act(async () => root.render(<LegalDocumentContent documentId="confidentialite" configuration={readLegalConfiguration()} />))
    expect(container.textContent).toContain('Hosting for the hosted alpha is planned in France, with a French hosting company.')
    expect(container.textContent).not.toMatch(/Docker|PostgreSQL|\bS3\b|Keycloak|\bVPS\b/i)
  })

  it('does not treat an unknown legal fragment as a document', async () => {
    window.history.replaceState({}, '', '/DraftMatter/#legal/untrusted')
    await act(async () => root.render(<Website />))
    expect(container.querySelector('.legal-page')).toBeNull()
    expect(container.querySelector('h1')?.textContent).toContain('Your paper should be')
  })
})
