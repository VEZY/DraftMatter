# Identity realm for the single-host pilot

`realm.mjs` exports `buildSingleHostRealm({ appHost, authHost, httpsPort = 443 })`.
The initializer writes its returned JSON to the directory imported by Keycloak.
`httpsPort` is only overridden for the isolated TLS rehearsal; production uses
443. The renderer accepts reserved DNS suffixes used by that rehearsal. The
production preflight separately rejects reserved/placeholder public hostnames.

This is a production realm, separate from `deploy/keycloak/draftmatter-realm.json`,
which is a local development fixture with demonstration accounts. Never mount
the development fixture into this stack. Start Keycloak with `start`, not
`start-dev`, and configure its external HTTPS hostname and trusted reverse proxy
as documented by the single-host stack.

The import defines no users, passwords, realm administrators, external identity
providers, or client secrets. The randomly generated bootstrap administrator
belongs to the **master** realm. Use it to provision the invited accounts. Verify
an invitee's email out of band before setting `emailVerified: true`; otherwise
the realm deliberately requires email verification before login. Self-service
registration and password reset remain disabled until an appropriate invitation
and email delivery process is configured.

The public `draftmatter-public` client permits Authorization Code with required
S256 PKCE and rotating refresh tokens. Password/direct grants, implicit grants,
service accounts, device grants, CIBA and optional offline access are disabled.
Access tokens contain the `draftmatter-collaboration` audience. Only the single
application HTTPS host (any application path), the exact native callback
`draftmatter://auth/callback`, and the browser/native origins expected by
DraftMatter are allowed. Administrator access is not granted to these users by
this import.

The default `basic` client scope is retained because Keycloak 25 and later add
the required `sub` claim through that scope. `profile` and `email` provide the
identity fields used by collaborators; offline access is not assigned.

The import is initial configuration: Keycloak does not overwrite an existing
realm on each restart. After changing these settings for an existing deployment,
apply and verify the corresponding realm/client settings through the admin
interface or an explicit migration; do not delete the identity database to
reload this file.

References: [Keycloak 26.7 server administration](https://www.keycloak.org/docs/26.7.0/server_admin/index.html),
[production configuration](https://www.keycloak.org/server/configuration-production),
[realm import behavior](https://www.keycloak.org/server/importExport).
