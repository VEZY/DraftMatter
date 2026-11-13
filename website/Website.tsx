import { useEffect, useState } from 'react'
import { Icon } from '../src/Icon'
import { LegalLinks, LegalPage } from '../src/LegalDocuments'
import { isLegalDocumentId, type LegalDocumentId } from '../src/legalConfig'
import { HomeTrustGuide } from '../src/HomeLearningGuide'
import { HomeHeroPreview, HomeShowcase } from '../src/HomeShowcase'

const repositoryUrl = 'https://github.com/VEZY/DraftMatter'
const releasesUrl = `${repositoryUrl}/releases`

function legalDocumentFromHash(): LegalDocumentId | null {
  const id = window.location.hash.slice('#legal/'.length)
  return window.location.hash.startsWith('#legal/') && isLegalDocumentId(id) ? id : null
}

function scrollTo(id: string) {
  const section = document.getElementById(id)
  if (!section) return
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  section.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' })
}

function AlphaAction({ compact = false }: { compact?: boolean }) {
  const signupUrl = import.meta.env.VITE_ALPHA_SIGNUP_URL?.trim()
  if (signupUrl) {
    return (
      <a className={compact ? 'website-nav-cta' : 'home-primary website-alpha-primary'} href={signupUrl} target="_blank" rel="noreferrer">
        Request alpha access
        {!compact && <Icon name="arrowRight" size={16} />}
      </a>
    )
  }
  return (
    <a className={compact ? 'website-nav-cta' : 'home-primary website-alpha-primary'} href={releasesUrl}>
      Follow alpha progress
      {!compact && <Icon name="arrowRight" size={16} />}
    </a>
  )
}

export function Website() {
  const [legalDocument, setLegalDocument] = useState(legalDocumentFromHash)
  useEffect(() => {
    const onHashChange = () => setLegalDocument(legalDocumentFromHash())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])
  if (legalDocument) return <LegalPage documentId={legalDocument} linkBase={`${import.meta.env.BASE_URL}#`} onBack={() => { window.location.hash = 'top' }} />
  return (
    <main id="top" className="home-welcome website">
      <header className="home-welcome-header">
        <a className="home-brand" href="#top" aria-label="DraftMatter website home">
          <img src={`${import.meta.env.BASE_URL}draftmatter-pencil-mark.svg`} alt="" />
          <span>DraftMatter</span>
        </a>
        <nav className="website-nav" aria-label="DraftMatter website">
          <a href="#home-showcase">Product tour</a>
          <a href="#website-principles">Why DraftMatter</a>
          <a href={repositoryUrl}>GitHub</a>
          <AlphaAction compact />
        </nav>
      </header>

      <section className="home-hero website-hero" aria-labelledby="website-title">
        <div className="home-hero-layout">
          <div className="home-hero-copy">
            <span className="website-alpha-label">Private alpha · pre-release</span>
            <span className="home-kicker">A calm workspace for rigorous research</span>
            <h1 id="website-title">Your paper should be as <span>reproducible</span> as your research.</h1>
            <p className="home-hero-support">Research writing, with the missing pieces built in.</p>
            <p className="home-hero-summary">DraftMatter brings writing, citations, reproducible results, review, and collaboration into one focused workspace. Everything is available when needed and quiet when it is not.</p>
            <div className="home-hero-actions">
              <AlphaAction />
              <button className="home-preview-action" onClick={() => scrollTo('home-showcase')}>
                See how it works
                <Icon name="arrowRight" size={17} />
              </button>
              <a className="website-source-action" href={repositoryUrl}>
                View the source
              </a>
            </div>
            <ul className="home-hero-proof" aria-label="DraftMatter principles">
              <li><Icon name="check" size={13} />Portable manuscript</li>
              <li><Icon name="check" size={13} />Local computation</li>
              <li><Icon name="check" size={13} />Reviews inside Markdown</li>
              <li><Icon name="check" size={13} />AI integration, on your terms</li>
            </ul>
          </div>
          <HomeHeroPreview />
        </div>
      </section>

      <HomeShowcase />

      <section id="website-principles" className="home-ai-connect website-ai" aria-labelledby="website-ai-title">
        <div>
          <span className="home-kicker">Optional · bring your own model</span>
          <h2 id="website-ai-title">AI integration, on your terms</h2>
          <p>Connect Codex, Claude Code, GitHub Copilot, or Mistral Vibe once on your computer. Then choose separately which projects each connected assistant may access.</p>
          <nav className="home-ai-brands" aria-label="Supported AI assistant product pages">
            <a href="https://openai.com/codex/" target="_blank" rel="noreferrer" aria-label="Open the OpenAI Codex product page">
              <img src={`${import.meta.env.BASE_URL}ai-openai.svg`} alt="" /><span>Codex</span>
            </a>
            <a href="https://claude.com/product/claude-code" target="_blank" rel="noreferrer" aria-label="Open the Claude Code product page">
              <img src={`${import.meta.env.BASE_URL}ai-claude-code.svg`} alt="" /><span>Claude Code</span>
            </a>
            <a href="https://mistral.ai/products/vibe/code/" target="_blank" rel="noreferrer" aria-label="Open the Mistral Vibe Code product page">
              <img src={`${import.meta.env.BASE_URL}ai-mistral.svg`} alt="" /><span>Mistral Vibe</span>
            </a>
          </nav>
        </div>
        <div className="website-ai-notes">
          <span><Icon name="check" size={14} />Works without AI</span>
          <span><Icon name="check" size={14} />Project-by-project access</span>
          <span><Icon name="check" size={14} />Reviewable changes</span>
        </div>
      </section>

      <HomeTrustGuide onStartTour={() => scrollTo('home-showcase')} />

      <section id="alpha" className="website-alpha" aria-labelledby="website-alpha-title">
        <div>
          <span className="website-alpha-label">Private alpha · pre-release</span>
          <h2 id="website-alpha-title">Help shape a better way to write research.</h2>
          <p>DraftMatter is not a finished public release yet. The hosted alpha is free and available by invitation. Participants will test real paper workflows, report rough edges, and help decide what deserves attention before wider distribution.</p>
          <ul>
            <li><Icon name="check" size={14} />Clear pre-release expectations</li>
            <li><Icon name="check" size={14} />No DraftMatter account required for local papers</li>
            <li><Icon name="check" size={14} />Download links only after supported builds are ready</li>
          </ul>
        </div>
        <aside>
          <strong>{import.meta.env.VITE_ALPHA_SIGNUP_URL ? 'Interested in testing DraftMatter?' : 'The alpha is being prepared.'}</strong>
          <p>{import.meta.env.VITE_ALPHA_SIGNUP_URL
            ? 'Read the alpha terms and privacy policy below before requesting access. The registration page identifies any separate provider it uses. Your email is used to organise the test and send essential alpha updates.'
            : 'Follow the repository for now. A private email registration link can be enabled here as soon as the alpha intake is ready.'}</p>
          <AlphaAction />
          <small>No public download is advertised until a supported pre-release exists.</small>
        </aside>
      </section>

      <footer className="website-footer">
        <a className="home-brand" href="#top">
          <img src={`${import.meta.env.BASE_URL}draftmatter-pencil-mark-monochrome.svg`} alt="" />
          <span>DraftMatter</span>
        </a>
        <p>Write the paper. Keep it reproducible.</p>
        <nav aria-label="DraftMatter project links">
          <a href={repositoryUrl}>Source</a>
          <a href={`${repositoryUrl}/blob/main/README.md`}>Documentation</a>
          <a href={`${repositoryUrl}/blob/main/LICENSE`}>MIT License</a>
        </nav>
        <LegalLinks basePath={`${import.meta.env.BASE_URL}#`} />
      </footer>
    </main>
  )
}
