import { useMemo, useState } from 'react'
import type { GeneratedFileExport } from './fileExport'
import { Icon } from './Icon'
import { parsePublicationMetadata } from './publicationMetadata'
import {
  analyzeSubmission,
  buildSubmissionPackage,
  submissionProjectAssetPaths,
  type SubmissionAsset,
  type SubmissionOptions,
  type SubmissionReviewModel,
} from './submissionPackage'
import type { CitationRecord } from './types'
import { preparePublicationAssetsForDocx } from './publicationAssets'

export function SubmissionPackageDialog({
  source,
  baseName,
  citations,
  citationLabels,
  bibliography,
  loadProjectAssets,
  onClose,
  onExport,
}: {
  source: string
  baseName: string
  citations: CitationRecord[]
  citationLabels: Record<string, string>
  bibliography: Array<{ id: string; value: string }>
  loadProjectAssets?: (paths: string[]) => Promise<SubmissionAsset[]>
  onClose: () => void
  onExport: (file: GeneratedFileExport) => void
}) {
  const metadata = useMemo(() => parsePublicationMetadata(source), [source])
  const authorNames = metadata.authorDetails.length
    ? metadata.authorDetails.map((author) => author.name)
    : metadata.authors
  const [journal, setJournal] = useState('')
  const [articleType, setArticleType] = useState('Research article')
  const [correspondingAuthor, setCorrespondingAuthor] = useState(authorNames[0] ?? '')
  const [correspondingEmail, setCorrespondingEmail] = useState('')
  const [reviewModel, setReviewModel] = useState<SubmissionReviewModel>('identified')
  const [submissionUrl, setSubmissionUrl] = useState('')
  const [coverLetter, setCoverLetter] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const options: SubmissionOptions = useMemo(() => ({
    journal,
    articleType,
    correspondingAuthor,
    correspondingEmail,
    reviewModel,
    submissionUrl,
    coverLetter,
  }), [articleType, correspondingAuthor, correspondingEmail, coverLetter, journal, reviewModel, submissionUrl])
  const analysis = useMemo(() => analyzeSubmission(source, citations, options), [citations, options, source])
  const projectAssetPaths = useMemo(() => submissionProjectAssetPaths(source), [source])

  const prepare = async () => {
    if (busy || analysis.errors) return
    setBusy(true)
    setProblem('')
    try {
      if (projectAssetPaths.length && !loadProjectAssets) {
        throw new Error('This manuscript references project figure files. Open it as a desktop project so DraftMatter can add them to the package.')
      }
      const assets = await preparePublicationAssetsForDocx(projectAssetPaths.length ? await loadProjectAssets!(projectAssetPaths) : [], source)
      const result = buildSubmissionPackage({
        source,
        baseName,
        options,
        citations,
        assets,
        docx: { citationLabels, bibliography },
      })
      onExport({
        suggestedName: result.filename,
        bytes: result.bytes,
        mimeType: 'application/zip',
        formatLabel: 'journal submission package',
        successMessage: `Submission package prepared for ${journal.trim()}`,
      })
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop submission-package-backdrop" onMouseDown={() => { if (!busy) onClose() }}>
      <section className="submission-package-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="submission-package-title">
        <div className="execution-dialog-head">
          <span className="execution-shield"><Icon name="download" size={19} /></span>
          <div><span className="eyebrow">Journal handoff</span><h2 id="submission-package-title">Prepare journal submission</h2><p>Make a clean, editable manuscript package. The corresponding author still reviews and uploads it through the journal portal.</p></div>
          <button className="icon-button" type="button" onClick={onClose} disabled={busy} aria-label="Close journal submission preparation"><Icon name="close" /></button>
        </div>

        <div className="submission-package-body">
          <div className="submission-package-form">
            <h3>Submission details</h3>
            <div className="submission-field-grid">
              <label><span>Target journal</span><input autoFocus value={journal} onChange={(event) => setJournal(event.target.value)} placeholder="Journal name" /></label>
              <label><span>Article type</span><input value={articleType} onChange={(event) => setArticleType(event.target.value)} placeholder="Research article" /></label>
              <label><span>Corresponding author</span>{authorNames.length
                ? <select value={correspondingAuthor} onChange={(event) => setCorrespondingAuthor(event.target.value)}>{authorNames.map((author) => <option key={author} value={author}>{author}</option>)}</select>
                : <input value={correspondingAuthor} onChange={(event) => setCorrespondingAuthor(event.target.value)} placeholder="Full name" />}</label>
              <label><span>Corresponding email</span><input type="email" value={correspondingEmail} onChange={(event) => setCorrespondingEmail(event.target.value)} placeholder="author@example.org" autoComplete="email" /></label>
              <label className="submission-wide-field"><span>Submission portal (optional)</span><input type="url" value={submissionUrl} onChange={(event) => setSubmissionUrl(event.target.value)} placeholder="https://…" /></label>
            </div>

            <fieldset className="submission-review-model">
              <legend>Peer-review identity</legend>
              <label className={reviewModel === 'identified' ? 'selected' : ''}><input type="radio" name="review-model" checked={reviewModel === 'identified'} onChange={() => setReviewModel('identified')} /><span><strong>Identified manuscript</strong><small>Keep authors and affiliations in the DOCX and source.</small></span></label>
              <label className={reviewModel === 'double-anonymous' ? 'selected' : ''}><input type="radio" name="review-model" checked={reviewModel === 'double-anonymous'} onChange={() => setReviewModel('double-anonymous')} /><span><strong>Double-anonymous copy</strong><small>Remove author metadata from the manuscript files; inspect prose and acknowledgements yourself.</small></span></label>
            </fieldset>

            <label className="submission-cover-letter"><span>Cover-letter notes (optional)</span><textarea value={coverLetter} onChange={(event) => setCoverLetter(event.target.value)} rows={4} placeholder="A short cover letter or notes for the corresponding author…" /></label>
          </div>

          <aside className="submission-readiness">
            <div className="submission-readiness-head"><div><span className="eyebrow">Preflight</span><h3>Submission readiness</h3></div><span className={`submission-readiness-count ${analysis.errors ? 'blocked' : analysis.warnings ? 'warning' : 'ready'}`}>{analysis.errors ? `${analysis.errors} blocked` : analysis.warnings ? `${analysis.warnings} to review` : 'Ready'}</span></div>
            <ul className="submission-check-list">
              {analysis.checks.map((check) => <li className={check.level} key={check.id}><span className="submission-check-icon"><Icon name={check.level === 'pass' ? 'check' : check.level === 'error' ? 'x' : 'info'} size={12} /></span><span><strong>{check.label}</strong><small>{check.message}</small></span></li>)}
            </ul>
            <div className="submission-package-contents">
              <strong>Package contents</strong>
              <small>Editable manuscript.docx · clean QMD source · references · submission summary{analysis.figures.length ? ` · ${analysis.figures.length} separate figure file${analysis.figures.length === 1 ? '' : 's'}` : ''}{coverLetter.trim() ? ' · cover letter' : ''}</small>
            </div>
          </aside>
        </div>

        {problem && <p className="submission-package-problem" role="alert">{problem}</p>}
        <div className="submission-package-note"><Icon name="info" size={14} /><span>Journal requirements vary and change. The package records your target and checks common requirements, but it does not submit automatically or claim to reproduce the journal’s typeset layout.</span></div>
        <div className="execution-dialog-actions"><button type="button" onClick={onClose} disabled={busy}>Cancel</button><button className="primary-button" type="button" onClick={() => void prepare()} disabled={busy || analysis.errors > 0}>{busy ? 'Packaging…' : analysis.errors ? 'Resolve blockers' : 'Prepare ZIP package'}</button></div>
      </section>
    </div>
  )
}
