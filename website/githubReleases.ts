export const repositoryUrl = 'https://github.com/VEZY/DraftMatter'
export const releasesUrl = `${repositoryUrl}/releases`
const apiUrl = 'https://api.github.com/repos/VEZY/DraftMatter/releases'

const platforms = {
  macOS: [
    ['darwin_aarch64_dmg.dmg', 'Apple silicon', 'DMG'],
    ['darwin_x64_dmg.dmg', 'Intel', 'DMG'],
  ],
  Windows: [
    ['windows_x64_nsis.exe', 'Intel / AMD 64-bit', 'EXE'],
    ['windows_x64_msi.msi', 'Intel / AMD 64-bit', 'MSI'],
    ['windows_arm64_nsis.exe', 'ARM64', 'EXE'],
  ],
  Linux: [
    ['linux_amd64_deb.deb', 'Intel / AMD 64-bit', 'DEB'],
    ['linux_amd64_appimage.AppImage', 'Intel / AMD 64-bit', 'AppImage'],
    ['linux_arm64_deb.deb', 'ARM64', 'DEB'],
    ['linux_arm64_appimage.AppImage', 'ARM64', 'AppImage'],
  ],
} as const

type GitHubAsset = { name: string; state: string; size: number; browser_download_url: string }
type GitHubRelease = { tag_name: string; draft: boolean; assets: GitHubAsset[] }

function installersFor(release: GitHubRelease) {
  if (release?.draft !== false || !Array.isArray(release.assets)) return
  const version = /^(?:server-)?v(\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?)$/.exec(release.tag_name)?.[1]
  if (!version) return
  const downloadUrl = `${releasesUrl}/download/${release.tag_name}`
  const assets = new Map(release.assets.filter(asset =>
    asset?.state === 'uploaded' && asset.size > 0 && asset.browser_download_url === `${downloadUrl}/${asset.name}`
  ).map(asset => [asset.name, asset]))
  const combined = release.tag_name.startsWith('server-')
  const checksums = assets.get(combined ? 'SHA256SUMS-desktop' : 'SHA256SUMS')?.browser_download_url
  if (combined && !checksums) return
  const groups = Object.entries(platforms).map(([platform, packages]) => ({
    platform,
    installers: packages.flatMap(([suffix, processor, format]) => {
      const asset = assets.get(`DraftMatter_${version}_${suffix}`)
      return asset ? [{ processor, format, url: asset.browser_download_url }] : []
    }),
  })).filter(group => group.installers.length > 0)
  if (!groups.length) return
  return { version, groups, tag: release.tag_name, url: `${releasesUrl}/tag/${release.tag_name}`, checksums }
}

export type DesktopDownloadRelease = NonNullable<ReturnType<typeof installersFor>>

export async function publicDesktopRelease(signal: AbortSignal): Promise<DesktopDownloadRelease | undefined> {
  // Server-only releases can fill a whole page. Only continue until a desktop release is found.
  const perPage = 30
  for (let page = 1; ; page++) {
    const response = await fetch(`${apiUrl}?per_page=${perPage}&page=${page}`, {
      signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/vnd.github+json' },
    })
    if (!response.ok) throw new Error('GitHub release list unavailable')
    const releases: GitHubRelease[] = await response.json()
    if (!Array.isArray(releases)) throw new Error('Unexpected GitHub release list')
    for (const release of releases) {
      const desktop = installersFor(release)
      if (desktop) return desktop
    }
    if (releases.length < perPage) return
  }
}
