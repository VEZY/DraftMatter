import { useEffect, useRef, useState } from 'react'
import { Icon } from '../src/Icon'
import { publicDesktopRelease, releasesUrl, repositoryUrl, type DesktopDownloadRelease } from './githubReleases'

type DownloadState = { status: 'loading' | 'error' | 'empty' } | { status: 'ready'; release: DesktopDownloadRelease }

const platformHelp: Record<string, string> = {
  macOS: 'Find your chip in Apple menu → About This Mac.',
  Windows: 'Choose EXE for a personal install or MSI for managed deployment.',
  Linux: 'Choose DEB for Debian or Ubuntu, or use the portable AppImage.',
}

export function DesktopDownloads() {
  const heading = useRef<HTMLHeadingElement>(null)
  const [state, setState] = useState<DownloadState>({ status: 'loading' })

  useEffect(() => {
    const previousTitle = document.title
    document.title = 'Download DraftMatter Desktop'
    heading.current?.focus({ preventScroll: true })
    document.documentElement.scrollTop = 0
    const controller = new AbortController()
    const timeout = window.setTimeout(() => {
      controller.abort()
      setState({ status: 'error' })
    }, 15000)
    publicDesktopRelease(controller.signal)
      .then(release => {
        if (!controller.signal.aborted) setState(release ? { status: 'ready', release } : { status: 'empty' })
      })
      .catch(() => { if (!controller.signal.aborted) setState({ status: 'error' }) })
      .finally(() => window.clearTimeout(timeout))
    return () => {
      controller.abort()
      window.clearTimeout(timeout)
      document.title = previousTitle
    }
  }, [])

  return <section id="download" className="desktop-downloads" aria-labelledby="downloads-title">
    <h1 id="downloads-title" ref={heading} tabIndex={-1}>Download DraftMatter Desktop</h1>
    <p className="downloads-intro">Write and run computations on your computer. You can work on local papers without an account.</p>
    {state.status === 'ready' ? <>
      <div className="downloads-version"><strong>Version {state.release.version}</strong><a href={state.release.url}>Release notes</a></div>
      <div className="downloads-platforms">
        {state.release.groups.map(({ platform, installers }) => <section key={platform} aria-label={platform}>
          <h2>{platform}</h2>
          <p>{platformHelp[platform]}</p>
          <ul>{installers.map(({ processor, format, url }) => <li key={url}>
            <a href={url} aria-label={`Download ${platform} for ${processor} (${format})`}>
              <span>{processor}<small>{format}</small></span><Icon name="download" size={16} />
            </a>
          </li>)}</ul>
        </section>)}
      </div>
    </> : <p className="downloads-state" role="status">
      {state.status === 'loading' && 'Checking published installers…'}
      {state.status === 'empty' && 'The first desktop installers will appear here when they are published.'}
      {state.status === 'error' && 'The installer list is temporarily unavailable. Check GitHub Releases for the published files.'}
    </p>}
    <nav className="downloads-resources" aria-label="Installation resources">
      <a href={`${repositoryUrl}/blob/${state.status === 'ready' ? state.release.tag : 'main'}/docs/installation.md`}>Installation guide</a>
      {state.status === 'ready' && state.release.checksums && <a href={state.release.checksums}>SHA-256 checksums</a>}
      <a href={releasesUrl}>GitHub Releases</a>
    </nav>
    <a className="downloads-web-link" href="https://app.draftmatter.eu/">Open the web app<Icon name="arrowRight" size={15} /></a>
  </section>
}
