# Signing credentials before the first release

DraftMatter's version tag starts a signed build for four desktop targets. A manual run on `main` builds unsigned candidates and can be used to check packaging. Choose the Windows signing method and validate the Apple credentials before creating the tag.

## Windows publisher

If you are starting without a Windows certificate, establish who will appear as the publisher before obtaining one.

- For an open source project, SignPath Foundation offers signing to accepted projects under its own publisher identity. Review its license, build provenance and approval requirements before applying. [Program](https://signpath.org/) · [Eligibility](https://signpath.org/terms)
- An eligible EU organization can request a Microsoft Artifact Signing **Public Trust** profile under its legal name. This requires an authorized representative and identity validation. Microsoft's individual Public Trust option currently covers residents of the US and Canada. [Eligibility and setup](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)
- To publish under an individual's own name elsewhere, confirm individual eligibility, country coverage and CI integration with a code signing provider before ordering. Newly issued publicly trusted code signing credentials use protected keys. A hardware token typically needs a runner with the token attached. A cloud service signs remotely. [CA/Browser Forum requirements, §6.2.7.4](https://cabforum.org/working-groups/code-signing/requirements/) · [DigiCert on PFX export](https://knowledge.digicert.com/general-information/export-a-code-signing-certificate-as-a-pfx-file)

The current workflow imports a PFX into the hosted Windows runner. A cloud or hardware key needs a provider integration in the workflow first. That integration must sign the application binaries and the finished MSI and NSIS installers, timestamp them and verify the expected publisher. For a remote provider, the signing identity and credentials come from its own enrollment process. [Microsoft signing integrations](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations) · [Tauri Windows signing](https://v2.tauri.app/distribute/sign/windows/)

**Existing PFX route only.** If the issuer permits using your existing code signing identity on a hosted runner, set these three repository secrets. A public certificate by itself cannot sign a build.

| Secret | Value |
| --- | --- |
| `WINDOWS_CERTIFICATE` | Base64 of the password-protected PFX containing the signing certificate and its private key. |
| `WINDOWS_CERTIFICATE_PASSWORD` | Password used to encrypt that PFX. |
| `WINDOWS_CERTIFICATE_THUMBPRINT` | Windows thumbprint (SHA-1, 40 hex characters) of the signing certificate. The installer itself is signed using SHA-256. |

## Apple signing and notarization

1. Use the Apple Developer Program team that will publish DraftMatter. Its Account Holder can issue a **Developer ID Application** certificate for distribution outside the Mac App Store. Generate the certificate signing request on the Mac that will hold the private key, install the issued certificate, then open **Keychain Access → My Certificates**. Select the identity with its private key and export it as a password-protected `.p12` file. [Apple certificate instructions](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/) · [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/)
2. Run `security find-identity -v -p codesigning` and copy the full `Developer ID Application: … (TEAMID)` name of that identity. Find the team ID in **Membership details**. Generate an app-specific password for notarization with the Apple Account belonging to that team. [Apple Team ID](https://developer.apple.com/help/glossary/team-id/) · [App-specific passwords](https://support.apple.com/en-us/102654)
3. On a Mac with Xcode, optionally validate the notarization credentials locally. Substitute your email and team ID. The first command securely prompts for the app-specific password and stores a profile in your login keychain.

```sh
xcrun notarytool store-credentials DraftMatter --apple-id 'you@example.org' --team-id 'YOURTEAMID'
xcrun notarytool history --keychain-profile DraftMatter
```

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64 of the exported Developer ID Application `.p12`. |
| `APPLE_CERTIFICATE_PASSWORD` | Password chosen when exporting the `.p12`. |
| `APPLE_SIGNING_IDENTITY` | Full identity name from `security find-identity`. |
| `APPLE_ID` | Email address of the Apple Account used for notarization. |
| `APPLE_PASSWORD` | App-specific password generated for that account. |
| `APPLE_TEAM_ID` | The publishing team's 10-character ID. |

## Enter the secrets in GitHub

Use **Settings → Secrets and variables → Actions → New repository secret** in the DraftMatter repository. The current jobs read repository-level Actions secrets. Enter each value directly in GitHub or through the interactive GitHub CLI. Pipe the binary certificates as Base64 directly into `gh` so their contents stay out of terminal output and shell history. Run the Windows line only if using the existing PFX route. [Repository settings](https://github.com/VEZY/DraftMatter/settings/secrets/actions) · [GitHub secret handling](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)

```sh
openssl base64 -A -in '/path/to/developer-id.p12' | gh secret set APPLE_CERTIFICATE --repo VEZY/DraftMatter
openssl base64 -A -in '/path/to/code-signing.pfx' | gh secret set WINDOWS_CERTIFICATE --repo VEZY/DraftMatter
gh secret set APPLE_CERTIFICATE_PASSWORD --repo VEZY/DraftMatter
```

Repeat the last command with each remaining secret name. Keep the certificate bundles and passwords in your credential store. Check the registered names with `gh secret list --repo VEZY/DraftMatter`. GitHub exposes their names and update dates. The tagged build verifies the signatures and notarization using the credentials.

## Before creating the tag

Check that the intended commit is on `origin/main`, that its four portability jobs and browser, collaboration and website workflows succeeded, and that `npm run release:verify` identifies version `0.1.0`. Complete the Windows setup for the chosen provider and the Apple steps above. The tag creates a **draft** release. Review its signed installers, checksums and per-platform compliance files before publishing. [Release gate](release-compliance.md#signing-and-notarization-gate)
