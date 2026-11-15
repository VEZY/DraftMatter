import { Icon } from './Icon'

const homeLearningTopics = [
  ['Write and organize', 'Shape the paper with sections and movable blocks while keeping the manuscript central.', 'document'],
  ['Cite sources', 'Insert citations with durable bibliography metadata and an automatic References section.', 'book'],
  ['Add figures, tables, and equations', 'Drop an image into the paper, edit table cells directly, or type an equation and see its preview as you write.', 'image'],
  ['Review and collaborate', 'Comment, suggest revisions, invite focused roles, and keep a portable checkpoint of the work.', 'users'],
] as const

export function HomeLearningGuide({ onStartTour }: { onStartTour: () => void }) {
  return (
    <section className="home-learning-guide" aria-labelledby="home-learning-title">
      <div className="home-learning-intro">
        <span className="home-kicker">Learn DraftMatter</span>
        <h2 id="home-learning-title">Explore a complete research paper.</h2>
        <p>Take a short guided tour of the example shipped with DraftMatter and see the complete workflow inside one manuscript.</p>
        <div className="home-learning-action">
          <button className="home-primary" onClick={onStartTour}><Icon name="spark" size={16} />Start guided tour</button>
          <small>Short, skippable, and safe to explore.</small>
        </div>
      </div>

      <ol className="home-learning-topics">
        {homeLearningTopics.map(([title, detail, icon], index) => (
          <li key={title}>
            <span>{String(index + 1).padStart(2, '0')}</span>
            <i><Icon name={icon} size={17} /></i>
            <div><h3>{title}</h3><p>{detail}</p></div>
          </li>
        ))}
      </ol>

      <aside className="home-learning-boundary">
        <Icon name="info" size={18} />
        <div>
          <strong>Write in your browser. Compute on desktop.</strong>
          <span>Code is optional. If you use R, Python, or Julia, run it from a trusted desktop project. Collaborators can keep writing and reviewing saved results online.</span>
        </div>
      </aside>
    </section>
  )
}

const homeTrustTopics = [
  ['Portable Markdown', 'The manuscript stays readable and editable outside DraftMatter.', 'document'],
  ['Local computation', 'Optional R, Python, and Julia code runs from a trusted project on your computer.', 'code'],
  ['Reviews inside Markdown', 'Comments and suggested changes are stored directly inside the Markdown manuscript.', 'message'],
] as const

export function HomeTrustGuide({ onStartTour }: { onStartTour: () => void }) {
  return (
    <section className="home-learning-guide home-trust-guide" aria-labelledby="home-trust-title">
      <div className="home-learning-intro">
        <span className="home-kicker">A workflow you can inspect</span>
        <h2 id="home-trust-title">The paper remains yours.</h2>
        <p>Explore the complete example to see writing, figures, citations, and review working together. Add computation when your research needs it.</p>
        <div className="home-learning-action">
          <button className="home-primary" onClick={onStartTour}><Icon name="spark" size={16} />Start guided tour</button>
          <small>Short, skippable, and safe to explore.</small>
        </div>
      </div>

      <ul className="home-learning-topics home-trust-topics">
        {homeTrustTopics.map(([title, detail, icon]) => (
          <li key={title}>
            <i><Icon name={icon} size={17} /></i>
            <div><h3>{title}</h3><p>{detail}</p></div>
          </li>
        ))}
      </ul>
    </section>
  )
}
