import { Icon } from './Icon'
import { desktopHost } from './desktopHost'
import './aiLearn.css'

export function AiLearn({
  onBack,
  onConnectAssistants,
}: {
  onBack: () => void
  onConnectAssistants: () => void
}) {
  return (
    <main className="ai-learn">
      <header>
        <button onClick={onBack}><Icon name="undo" size={15} />Home</button>
        <a className="home-brand" href="/" aria-label="DraftMatter home"><img src="/draftmatter-pencil-mark.svg" alt="" /><span>DraftMatter</span></a>
      </header>
      <article>
        <span className="home-kicker">AI integration, on your terms</span>
        <h1>Your assistant. Your projects. Two separate choices.</h1>
        <p className="ai-learn-lead">DraftMatter works without AI. If you choose to use an assistant, connection happens once on your computer; access is then enabled separately for each project.</p>

        <div className="ai-learn-scopes">
          <section>
            <span>1</span>
            <div><small>Device/client-wide</small><h2>Connect AI assistants</h2></div>
            <p>DraftMatter registers its bundled MCP server and canonical authoring skill with Codex, Claude Code, GitHub Copilot, or Mistral Vibe. Unrelated client settings are preserved.</p>
            {desktopHost.available
              ? <button className="home-primary" onClick={onConnectAssistants}><Icon name="spark" size={16} />Connect assistants</button>
              : <span className="ai-learn-desktop-note"><Icon name="command" size={15} />Connect from the DraftMatter desktop app</span>}
          </section>
          <Icon name="arrowRight" size={22} />
          <section>
            <span>2</span>
            <div><small>Per project</small><h2>Enable AI for this project</h2></div>
            <p>DraftMatter adds managed instruction pointers and a versioned enablement manifest. The globally registered MCP refuses projects without that marker and pins the root at startup.</p>
            <small>Available during project creation and from the Project menu.</small>
          </section>
        </div>

        <section className="ai-learn-states" aria-labelledby="ai-state-title">
          <div><span className="home-kicker">Independent controls</span><h2 id="ai-state-title">There is no single “Ready” switch</h2><p>Each state answers a different security question.</p></div>
          <ol>
            <li><Icon name="command" size={18} /><span><strong>Assistant connected</strong><small>Can this AI client discover DraftMatter’s bundled MCP and skill on this computer?</small></span></li>
            <li><Icon name="folder" size={18} /><span><strong>AI enabled for this project</strong><small>May the project-bound MCP expose DraftMatter tools for this folder?</small></span></li>
            <li><Icon name="play" size={18} /><span><strong>Project trusted for code execution</strong><small>May DraftMatter run manuscript code in the current trusted desktop session?</small></span></li>
            <li><Icon name="book" size={18} /><span><strong>Network approved for this request</strong><small>May this specific Zotero or Crossref lookup contact an external source?</small></span></li>
          </ol>
        </section>

        <section className="ai-learn-normal">
          <span className="home-kicker">Normal use</span>
          <h2>Ask naturally; DraftMatter keeps the structure safe</h2>
          <p>Open an enabled project in your connected assistant. It can inspect semantic manuscript structure, propose tracked rewrites, create reproducible figures, tables, and in-text values, run approved cells, inspect outputs, search approved citation sources, add verified references, and insert citations—without inventing managed IDs.</p>
          <div>
            <span><strong>Rewrites</strong><small>Tracked suggestions by default</small></span>
            <span><strong>Computation</strong><small>Explicit project trust + client approval</small></span>
            <span><strong>Citations</strong><small>Verified records + per-request network approval</small></span>
          </div>
        </section>

        <section className="ai-learn-safety">
          <Icon name="focus" size={24} />
          <div><h2>Setup is inert</h2><p>Neither setup step contacts a model, runs manuscript code, grants execution trust, enables Zotero/Crossref access, or pre-approves future assistant tool calls.</p></div>
        </section>
      </article>
    </main>
  )
}
