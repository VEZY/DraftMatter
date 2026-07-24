import { Icon } from './Icon'
import './programmingLanguages.css'

const languages = [
  {
    id: 'julia',
    label: 'Julia',
    marker: 'Jl',
    title: 'The Julia project is the environment.',
    summary: 'DraftMatter prefers the Julia installation already on your computer and always starts it in the open project.',
    files: 'Project.toml and Manifest.toml',
    setup: 'The project is instantiated and IJulia is added when the document needs a Julia kernel.',
  },
  {
    id: 'python',
    label: 'Python',
    marker: 'Py',
    title: 'Each project gets an isolated Python environment.',
    summary: 'DraftMatter uses uv for predictable environments. It prefers existing Python and uv installations and acquires them only when a Python project actually needs them.',
    files: 'pyproject.toml, uv.lock, and .venv',
    setup: 'uv creates .venv and synchronizes the kernel and formatter without installing packages into system Python.',
  },
  {
    id: 'r',
    label: 'R',
    marker: 'R',
    title: 'Your R installation, with a project library.',
    summary: 'DraftMatter uses the R installation already on your computer and bootstraps renv only when the manuscript contains R code.',
    files: 'renv.lock and the renv project library',
    setup: 'An existing lockfile is restored; otherwise a small isolated environment is created with IRkernel and styler.',
  },
] as const

export function ProgrammingLanguages({ onBack }: { onBack: () => void }) {
  return (
    <main className="languages-page">
      <header>
        <button onClick={onBack}><Icon name="arrowRight" size={15} />Back to DraftMatter</button>
        <span className="home-brand"><img src="/draftmatter-pencil-mark.svg" alt="" /><span>DraftMatter</span></span>
      </header>

      <div className="languages-content">
        <section className="languages-intro">
          <span className="home-kicker">Programming languages</span>
          <h1>Code that belongs to the project.</h1>
          <p>DraftMatter can run Julia, Python, and R cells beside the manuscript while keeping their packages and results connected to the project. It detects what the document uses and prepares only those languages.</p>
        </section>

        <section className="languages-boundary" aria-labelledby="languages-boundary-title">
          <Icon name="info" size={20} />
          <div>
            <h2 id="languages-boundary-title">Execution happens in the desktop app.</h2>
            <p>The browser version displays code and retained results but does not execute local programs. Open the project in DraftMatter Desktop to run cells, install project packages, or use the shared language terminal.</p>
          </div>
        </section>

        <section className="languages-setup" aria-labelledby="languages-setup-title">
          <div>
            <span className="home-kicker">Automatic setup</span>
            <h2 id="languages-setup-title">Existing installations come first.</h2>
          </div>
          <ol>
            <li><span>1</span><div><strong>DraftMatter detects the languages in the manuscript.</strong><p>Nothing is downloaded for languages the project does not use.</p></div></li>
            <li><span>2</span><div><strong>You trust the local project once.</strong><p>Trust permits code execution and environment changes for that project. DraftMatter remembers the choice on this computer.</p></div></li>
            <li><span>3</span><div><strong>The project environment is checked and restored.</strong><p>Existing runtimes and lockfiles are preferred. Setup progress and errors remain visible in Code &amp; computation.</p></div></li>
          </ol>
        </section>

        <section className="languages-grid" aria-label="Supported programming languages">
          {languages.map((language) => (
            <article key={language.id} data-language={language.id}>
              <div className="languages-card-head"><span>{language.marker}</span><strong>{language.label}</strong></div>
              <h2>{language.title}</h2>
              <p>{language.summary}</p>
              <dl>
                <div><dt>Project files</dt><dd>{language.files}</dd></div>
                <div><dt>First setup</dt><dd>{language.setup}</dd></div>
              </dl>
            </article>
          ))}
        </section>

        <section className="languages-use" aria-labelledby="languages-use-title">
          <div>
            <span className="home-kicker">In a manuscript</span>
            <h2 id="languages-use-title">Add a cell, then work normally.</h2>
          </div>
          <div className="languages-use-grid">
            <article><Icon name="code" size={18} /><h3>Add code</h3><p>Insert a setup, values, figure, table, or ordinary code cell and choose its language.</p></article>
            <article><Icon name="play" size={18} /><h3>Run independently</h3><p>Run one cell while developing, or run the project’s language cells together for a clean result.</p></article>
            <article><Icon name="command" size={18} /><h3>Inspect the session</h3><p>The terminal shares the live document kernel, so variables, imports, progress, and errors are visible in one place.</p></article>
            <article><Icon name="check" size={18} /><h3>Keep the result</h3><p>Published values and retained figures stay readable in the manuscript even when execution is unavailable.</p></article>
          </div>
        </section>

        <section className="languages-note">
          <Icon name="focus" size={19} />
          <div><h2>DraftMatter does not replace your system tools.</h2><p>Julia and R remain normal installations on your computer. Python packages stay inside the project’s .venv. A DraftMatter-managed copy of uv or Python lives in application data and is not added to your system PATH.</p></div>
        </section>
      </div>
    </main>
  )
}
