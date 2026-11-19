# Identity realm for the single-host pilot

`realm.mjs` exports `buildSingleHostRealm({ appHost, authHost, httpsPort = 443, registrationEnabled = false })`.
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
belongs to the **master** realm. Self-service registration and password reset
remain disabled by default. Enabling registration requires authenticated SMTP
delivery, verification email testing, rate limits at the identity proxy, and the
collaboration service's alpha approval gate. SMTP credentials are never included
in this public import.

Registration uses an email address and password. First and last names are
optional. Email verification is mandatory. Registration creates an identity on
the waiting list; it does not approve alpha access or create a workspace.
Only an operator may assign the `draftmatter-alpha` realm role to an individually
reviewed account. The role is never a default role or a default group assignment.
A project/workspace invitation does not bypass this approval.

The dedicated `draftmatter-registration` flow collects the password on the
registration form, then requires email verification. In Keycloak 26.7 this uses
`always_set_password_on_register_form`, a compatibility setting documented as
deprecated by Keycloak. Check its continued support when upgrading Keycloak;
the safe alternative is to collect the password after email verification.
The user profile permits only email, username and optional names. Unmanaged
attributes are disabled: users cannot assign an approval role or set their own
verification status through profile fields.

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
identity fields used by collaborators; offline access is not assigned. The
client has an explicit realm scope mapping for `draftmatter-alpha` because
`fullScopeAllowed` is false. A realm-role protocol mapper attached only to
`draftmatter-public` adds `draftmatter_roles` as an array in access tokens. It
maps actual assigned roles, never a hardcoded approval or editable user field.

The import is initial configuration: Keycloak does not overwrite an existing
realm on each restart. After changing these settings for an existing deployment,
apply and verify the corresponding realm/client settings through the admin
interface or an explicit migration; do not delete the identity database to
reload this file. `alpha.mjs` supplies public representations and an ordered
`buildAlphaMigrationPlan` for the authenticated operator tooling. The plan first
closes registration, configures role scope/mapper/profile/password collection,
optionally approves one explicitly reviewed owner, and applies registration
settings last. Its executor must verify that the approval role is absent from
default-role composites and default groups, and validate SMTP and the backend
gate before enabling registration. Existing invited accounts must be reviewed
and individually approved before activating the required-role backend gate;
never bulk-approve all identities or overwrite their verification status.

References: [Keycloak 26.7 server administration](https://www.keycloak.org/docs/26.7.0/server_admin/index.html),
[production configuration](https://www.keycloak.org/server/configuration-production),
[realm import behavior](https://www.keycloak.org/server/importExport).
Profile and migration formats follow the
[Keycloak 26.7 Admin REST API](https://www.keycloak.org/docs-api/26.7.0/rest-api/index.html).
