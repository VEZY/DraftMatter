import { Icon } from './Icon'
import './programmingLanguages.css'

const languages = [
  {
    id: 'julia',
    label: 'Julia',
    marker: 'Jl',
    title: 'The Julia project is the environment.',
    summary: 'DraftMatter uses the Julia installation already on your computer and starts the document kernel with the open folder as its active project.',
    files: 'Project.toml and Manifest.toml',
    setup: 'The project files are created when needed, packages are instantiated, and IJulia is added to this project.',
  },
  {
    id: 'python',
    label: 'Python',
    marker: 'Py',
    title: 'Each project gets an isolated Python environment.',
    summary: 'DraftMatter prefers working uv and Python installations. If either is missing, uv and then Python can be acquired for DraftMatter only when this project uses Python.',
    files: 'pyproject.toml, uv.lock, and .venv',
    setup: 'uv creates .venv and adds ipykernel and Ruff as project development dependencies, without changing system Python.',
  },
  {
    id: 'r',
    label: 'R',
    marker: 'R',
    title: 'Your R installation, with a project library.',
    summary: 'R must already be installed on your computer. DraftMatter then bootstraps renv only when the manuscript contains R code.',
    files: 'renv.lock and the renv project library',
    setup: 'An existing lockfile is restored; otherwise renv creates the project library, installs IRkernel and styler, and records it in renv.lock.',
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
          <p>DraftMatter runs Julia, Python, and R cells in the desktop app while keeping source, environments, and retained results with the research project. It detects the languages used by the manuscript and prepares only those environments.</p>
        </section>

        <section className="languages-boundary" aria-labelledby="languages-boundary-title">
          <Icon name="info" size={20} />
          <div>
            <h2 id="languages-boundary-title">Execution happens in the desktop app.</h2>
            <p>The browser can edit and review code and display retained results, but it cannot start programs on your computer. Open a local copy in DraftMatter Desktop to run cells, manage project packages, or use the shared language terminal.</p>
          </div>
        </section>

        <section className="languages-project" aria-labelledby="languages-project-title">
          <div>
            <span className="home-kicker">Open by design</span>
            <h2 id="languages-project-title">A DraftMatter project is an ordinary folder.</h2>
            <p>DraftMatter identifies the folder through <code>.draftmatter/project.json</code>. The manuscript itself remains a plain-text <code>.qmd</code> or <code>.md</code> file, with code cells stored directly in that file.</p>
          </div>
          <div className="languages-project-body">
            <pre aria-label="Example DraftMatter project folder"><strong>my-study/</strong>{`
├── .draftmatter/
│   └── project.json
├── paper.qmd
├── references.bib
├── data/
└── language environment files…`}</pre>
            <div className="languages-project-points">
              <article><Icon name="code" size={18} /><div><h3>Use your regular IDE</h3><p>Open the same folder in VS Code, Positron, RStudio, or another editor. You can edit manuscript prose, code cells, scripts, data, and environment files there.</p></div></article>
              <article><Icon name="branch" size={18} /><div><h3>Use Git normally</h3><p>Initialize, branch, commit, pull, merge, and push this folder like any other repository—through DraftMatter, your IDE, or the command line.</p></div></article>
              <article><Icon name="focus" size={18} /><div><h3>External edits appear automatically</h3><p>DraftMatter checks the open manuscript and reloads clean external changes within a few seconds. If both DraftMatter and your IDE have unsaved changes, it stops and asks you to resolve the conflict instead of overwriting either copy.</p></div></article>
            </div>
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
            <li><span>3</span><div><strong>The project environment is checked and restored.</strong><p>Existing runtimes and lockfiles are preferred. Live setup output and errors appear in the terminal’s Project tab. Manuscript cells still run only when you ask.</p></div></li>
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
            <article><Icon name="check" size={18} /><h3>Keep the result</h3><p>Published values, tables, and retained figures remain readable in the manuscript even when local execution is unavailable.</p></article>
          </div>
        </section>

        <section className="languages-note">
          <Icon name="focus" size={19} />
          <div><h2>DraftMatter does not replace your system tools.</h2><p>Julia and R remain normal installations on your computer. Python packages stay inside the project’s <code>.venv</code>. When needed, managed copies of uv or Python live in DraftMatter’s application data and are not added to your system <code>PATH</code>.</p></div>
        </section>
      </div>
    </main>
  )
}
