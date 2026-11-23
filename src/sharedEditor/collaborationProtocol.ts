// Review decisions can retain both wordings in attributed Y.Text runs. Only
// peers that project those runs may synchronize this manuscript format.
const socketPrefix = 'draftmatter.live.2:'

export const collaborationUpgradeMessage = 'Shared editing requires matching versions. Reload the web app or update DraftMatter Desktop and the collaboration server.'

export function collaborationSocketCredential(accessToken: string) {
  return socketPrefix + accessToken
}

export function socketAccessToken(credential: string) {
  return credential.startsWith(socketPrefix) ? credential.slice(socketPrefix.length) : undefined
}
