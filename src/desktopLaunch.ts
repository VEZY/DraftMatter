import { parseApplicationRoute } from './applicationRoute'

const DESKTOP_LAUNCH_PROTOCOL = 'draftmatter:'
const DESKTOP_LAUNCH_HOST = 'open'

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

export function desktopLaunchTarget(launchUrl: string) {
  try {
    const launch = new URL(launchUrl)
    if (launch.protocol !== DESKTOP_LAUNCH_PROTOCOL || launch.hostname !== DESKTOP_LAUNCH_HOST) return null
    const source = new URL(launch.searchParams.get('source') ?? '')
    if (!['http:', 'https:'].includes(source.protocol) || source.username || source.password || !sharedRoute(source)) return null
    return `${source.pathname}${source.search}${source.hash}`
  } catch {
    return null
  }
}
