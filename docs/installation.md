# Install DraftMatter

Download from the [official DraftMatter GitHub Releases](https://github.com/VEZY/DraftMatter/releases) page. Choose a published release and an installer for your operating system and processor. If no release is published yet, desktop downloads are not available there yet. Workflow artifacts are test candidates.

These downloads do not carry a verified publisher signature. macOS uses a free ad hoc signature and is not notarized; Windows installers are unsigned. First-launch warnings are expected, and managed computers may block installation. The steps below approve only the chosen download; do not disable system-wide security controls.

## Check the download

Download `SHA256SUMS` from the same release. Replace the example filenames below with the exact downloaded filename, then compare the result with its entry in `SHA256SUMS`:

```sh
# macOS
shasum -a 256 DraftMatter_VERSION_darwin_aarch64_dmg.dmg

# Linux
sha256sum DraftMatter_VERSION_linux_amd64_appimage.AppImage
```

```powershell
# Windows PowerShell
Get-FileHash .\DraftMatter_VERSION_windows_x64_nsis.exe -Algorithm SHA256
```

The hash must match completely (letter case does not matter). If it differs, stop and download again. Checksums detect damaged or changed downloads; a checksum on the same release is not independent proof of publisher identity.

## macOS

1. In **Apple menu → About This Mac**, check whether your Mac has an Apple chip or an Intel processor. Choose the `darwin_aarch64` DMG for Apple Silicon or `darwin_x64` DMG for Intel.
2. Open the `.dmg` and drag **DraftMatter.app** into **Applications**. Eject the disk image and open DraftMatter from Applications.
3. If macOS says the developer cannot be verified or Apple cannot check the app, dismiss the alert. After checking the source and checksum, open **System Settings → Privacy & Security**, find the blocked DraftMatter launch, choose **Open Anyway**, and confirm **Open**. You may need to authenticate. This approval is available shortly after the blocked launch.
4. Later launches should work from Applications normally.

An ad hoc signature checks bundle integrity locally; it does not establish an Apple-verified publisher. If macOS reports malware or says the app is damaged, stop and report the exact message rather than removing quarantine attributes or disabling Gatekeeper. On a managed Mac, ask your administrator if the approval is unavailable.

See [Apple's instructions for opening downloaded apps](https://support.apple.com/en-us/102445).

## Windows

1. Choose the `windows_x64_nsis.exe` installer for a regular installation, or the `windows_x64_msi.msi` installer if your deployment process uses MSI. These are x64 builds, not native ARM64 builds.
2. Check the checksum and run the installer. If Microsoft Defender SmartScreen displays **Windows protected your PC**, choose **More info → Run anyway** only if you trust this download. An **Unknown publisher** prompt is expected for an unsigned installer.
3. Finish setup and launch DraftMatter from the Start menu. The NSIS installer also adds the application directory to your user `PATH`; open a new terminal before using `draftmatter`.

The **Run anyway** option is not available under every policy. Smart App Control, Windows in S mode, or an organization's rules may block unsigned software. Do not turn those protections off to install DraftMatter; use an approved device or ask your administrator. If antivirus reports malware, stop and report the message.

See Microsoft’s [SmartScreen guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/publish-first-app) and [Smart App Control FAQ](https://support.microsoft.com/en-us/windows/security/threat-malware-protection/smart-app-control-frequently-asked-questions).

## Linux

Choose an x64 (`linux_amd64`) download. Linux ARM builds are not provided.

For Debian/Ubuntu, download the `.deb` and install it using your package manager so dependencies can be resolved. From the download directory, substitute the actual filename:

```sh
sudo apt install ./DraftMatter_VERSION_linux_amd64_deb.deb
```

Then launch DraftMatter from your application menu or run `draftmatter`.

For other distributions, try the `.AppImage`. Make the downloaded file executable and run it as your normal user:

```sh
chmod +x ./DraftMatter_VERSION_linux_amd64_appimage.AppImage
./DraftMatter_VERSION_linux_amd64_appimage.AppImage
```

AppImage compatibility depends on your distribution and system libraries. If it reports a missing FUSE library, follow the [AppImage FUSE troubleshooting guide](https://docs.appimage.org/user-guide/troubleshooting/fuse.html) for your distribution. Do not run the AppImage with `sudo`. See [Running AppImages](https://docs.appimage.org/user-guide/run-appimages.html).

## After installation

DraftMatter bundles its assistant sidecars. Python, R, Julia and their Jupyter kernels, Git, and optional export tools are discovered separately when needed; installing the desktop app does not install those environments. Opening a manuscript does not run its code.

To update, download a newer published release, verify its checksum and install it using the same platform steps. Keep manuscript projects and backups separate from the application installation directory.
