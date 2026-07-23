export type ApplicationRoute =
  | { destination: 'home'; workspaceId?: string }
  | { destination: 'collaborative-editor'; workspaceId: string; projectId: string }
  | { destination: 'local-editor'; localProjectId: string }
  | { destination: 'invitation' }
  | { destination: 'example' }

function decoded(value: string | undefined) {
  if (!value) return ''
  try {
    return decodeURIComponent(value)
  } catch {
    return ''
  }
}

export function parseApplicationRoute(location: Pick<Location, 'pathname' | 'search'>): ApplicationRoute {
  const parts = location.pathname.split('/').filter(Boolean)
  if (parts[0] === 'workspace' && parts[1] && parts[2] === 'project' && parts[3]) {
    return { destination: 'collaborative-editor', workspaceId: decoded(parts[1]), projectId: decoded(parts[3]) }
  }
  if (parts[0] === 'workspace' && parts[1]) return { destination: 'home', workspaceId: decoded(parts[1]) }
  if (parts[0] === 'local' && parts[1]) return { destination: 'local-editor', localProjectId: decoded(parts.slice(1).join('/')) }
  if (parts[0] === 'invite') return { destination: 'invitation' }
  if (new URLSearchParams(location.search).get('example') === 'complete') return { destination: 'example' }
  return { destination: 'home' }
}

export function applicationRoutePath(route: ApplicationRoute) {
  if (route.destination === 'collaborative-editor') return `/workspace/${encodeURIComponent(route.workspaceId)}/project/${encodeURIComponent(route.projectId)}`
  if (route.destination === 'local-editor') return `/local/${encodeURIComponent(route.localProjectId)}`
  if (route.destination === 'invitation') return '/invite'
  if (route.destination === 'example') return '/?example=complete'
  return route.workspaceId ? `/workspace/${encodeURIComponent(route.workspaceId)}` : '/'
}
