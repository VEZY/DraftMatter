import './browserDemo.css'

export function BrowserDemoNotice() {
  return (
    <aside className="browser-demo-notice" aria-label="Interactive example">
      <div><strong>Interactive example</strong><span>Edit freely. Changes stay in this tab and disappear when you reload.</span></div>
      <nav aria-label="Example actions">
        <a href="/demo">Reset example</a>
        <a href="/">Back to your papers</a>
      </nav>
    </aside>
  )
}
