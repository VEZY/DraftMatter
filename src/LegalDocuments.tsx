import { useEffect, useRef } from 'react'
import { LegalDocumentContent } from './legalContent'
import { LEGAL_DOCUMENT_VERSION, legalConfiguration, legalDocuments, type LegalDocumentId } from './legalConfig'
import './legal.css'

export function LegalLinks({ basePath = '/', target, onNavigate }: { basePath?: string; target?: '_blank'; onNavigate?: (id: LegalDocumentId) => void }) {
  return (
    <nav className="legal-links" aria-label="Legal information">
      {legalDocuments.map((document) => (
        <a key={document.id} href={`${basePath}legal/${document.id}`} target={onNavigate ? undefined : target} rel={target && !onNavigate ? 'noreferrer' : undefined}
          onClick={(event) => {
            if (!onNavigate || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
            event.preventDefault()
            onNavigate(document.id)
          }}>
          {document.title}
        </a>
      ))}
    </nav>
  )
}

export function LegalPage({ documentId, onBack, linkBase = '/', onNavigate }: { documentId: LegalDocumentId; onBack: () => void; linkBase?: string; onNavigate?: (id: LegalDocumentId) => void }) {
  const document = legalDocuments.find((entry) => entry.id === documentId)!
  const pageRef = useRef<HTMLElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    const previousTitle = window.document.title
    window.document.title = `${document.title} — DraftMatter`
    if (pageRef.current) pageRef.current.scrollTop = 0
    const documentScroller = window.document.scrollingElement
    if (documentScroller) documentScroller.scrollTop = 0
    titleRef.current?.focus({ preventScroll: true })
    return () => { window.document.title = previousTitle }
  }, [document.title])
  return (
    <main className="legal-page" lang="en" ref={pageRef}>
      <header className="legal-page-header">
        <span className="legal-brand">DraftMatter</span>
        <button type="button" onClick={onBack}>Back</button>
      </header>
      <article aria-labelledby="legal-page-title">
        <p className="legal-kicker">Free closed alpha · by invitation</p>
        <h1 id="legal-page-title" tabIndex={-1} ref={titleRef}>{document.title}</h1>
        <p className="legal-version">Version dated <time dateTime={LEGAL_DOCUMENT_VERSION}>{new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${LEGAL_DOCUMENT_VERSION}T00:00:00Z`))}</time></p>
        {!legalConfiguration.ready && (
          <aside className="legal-preparation" aria-label="Alpha preparation">
            The hosted alpha is being prepared. Its hosting provider and data processing locations must be confirmed below before testers are invited.
          </aside>
        )}
        <LegalDocumentContent documentId={documentId} configuration={legalConfiguration} />
      </article>
      <footer><LegalLinks basePath={linkBase} onNavigate={onNavigate} /></footer>
    </main>
  )
}
