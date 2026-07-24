import { Icon } from './Icon'
import './learn.css'

const lessons = [
  ['Write and organize', 'Use sections and movable blocks to shape a clear scientific argument.', 'document'],
  ['Cite sources', 'Attach durable bibliography metadata and insert citations without losing the portable citekey.', 'book'],
  ['Produce reproducible results', 'Run code on desktop while publishing retained figures, tables, and inline statistics.', 'code'],
  ['Review with context', 'Comment on a selection, suggest revisions, and resolve decisions with attribution.', 'message'],
  ['Collaborate and checkpoint', 'Invite narrow roles, work live, and materialize an owner-controlled portable checkpoint.', 'users'],
] as const

export function Learn({ onBack, onStartTour }: { onBack: () => void; onStartTour: () => void }) {
  return (
    <main className="learn-page">
      <header><button onClick={onBack}><Icon name="arrowRight" size={15} />Back to DraftMatter</button><span className="home-brand"><img src="/draftmatter-pencil-mark.svg" alt="" /><span>DraftMatter</span></span></header>
      <div className="learn-content">
        <section className="learn-intro">
          <span className="home-kicker">Learn DraftMatter</span>
          <h1>Explore a complete research paper.</h1>
          <p>Take a guided tour of the full example shipped with DraftMatter to see citations, review, reproducible results, and multiple coding languages working together in one manuscript.</p>
          <div className="learn-actions">
            <button className="home-primary" onClick={onStartTour}><Icon name="spark" size={16} />Start guided tour</button>
          </div>
        </section>
        <ol className="learn-lessons">{lessons.map(([title, detail, icon], index) => <li key={title}><span>{String(index + 1).padStart(2, '0')}</span><i><Icon name={icon} size={19} /></i><div><h2>{title}</h2><p>{detail}</p></div></li>)}</ol>
        <section className="learn-boundary"><Icon name="info" size={19} /><div><h2>Desktop computes. Browser collaboration reviews.</h2><p>R, Python, and Julia execute only in the desktop app. Browser collaborators work with the portable manuscript and retained outputs according to their role.</p></div></section>
      </div>
    </main>
  )
}
