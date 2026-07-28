import { parseApplicationRoute } from './applicationRoute'

const DESKTOP_LAUNCH_PROTOCOL = 'draftmatter:'
const DESKTOP_LAUNCH_HOST = 'open'

function localProjectPath(value: string) {
  const compact = value.trim()
  if (!compact || compact.includes('\0')) return null
  return compact.startsWith('/') || /^[A-Za-z]:[\\/]/.test(compact) ? compact : null
}

function sharedRoute(url: URL) {
  const route = parseApplicationRoute(url)
  return route.destination === 'collaborative-editor' || route.destination === 'invitation'
}

export function desktopLaunchUrl(sourceUrl: string) {
  try {
    const source = new URL(sourceUrl)
    if (!['http:', 'https:'].includes(source.protocol) || source.username || source.password || !sharedRoute(source)) return null
    const launch = new URL(`${DESKTOP_LAUNCH_PROTOCOL}//${DESKTOP_LAUNCH_HOST}`)
    launch.searchParams.set('source', source.toString())
    return launch.toString()
  } catch {
    return null
  }
}

export function desktopProjectLaunchUrl(projectPath: string) {
  const project = localProjectPath(projectPath)
  if (!project) return null
  const launch = new URL(`${DESKTOP_LAUNCH_PROTOCOL}//${DESKTOP_LAUNCH_HOST}`)
  launch.searchParams.set('project', project)
  return launch.toString()
}

export function desktopLaunchTarget(launchUrl: string) {
  try {
    const launch = new URL(launchUrl)
    if (launch.protocol !== DESKTOP_LAUNCH_PROTOCOL || launch.hostname !== DESKTOP_LAUNCH_HOST) return null
    const sourceValue = launch.searchParams.get('source')
    const projectValue = launch.searchParams.get('project')
    if (sourceValue && projectValue) return null
    if (projectValue) {
      const project = localProjectPath(projectValue)
      return project ? `/local/${encodeURIComponent(project)}` : null
    }
    if (!sourceValue) return '/'
    const source = new URL(sourceValue)
    if (!['http:', 'https:'].includes(source.protocol) || source.username || source.password || !sharedRoute(source)) return null
    return `${source.pathname}${source.search}${source.hash}`
  } catch {
    return null
  }
}
