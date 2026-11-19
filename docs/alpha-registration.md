# Closed-alpha registration and approval

The signed-out application shows **Sign in** and **Register**, rather than
device settings or account configuration. Registration is disabled unless the
running collaboration service advertises that it is ready. Desktop and
unhosted local projects retain their setup controls.

Registration uses Keycloak's email/password form through the same Authorization
Code + S256 PKCE flow as sign-in. First and last names are optional. A new user
must verify their email, then sees **Awaiting invitation**. Creating an identity
does not grant alpha access, create a workspace, reserve storage, or accept a
project invitation. Passwords are handled by Keycloak, never by the manuscript
application or collaboration service.

Only an operator assigns the `draftmatter-alpha` role to an individually
reviewed, verified account. The role must not be a default role/group grant.
The collaboration service requires both `email_verified: true` and the role in
the signed `draftmatter_roles` array before creating even its local user row.
HTTP, WebSocket authentication/renewal and file access use that same check.
Changing a role takes effect on subsequent token validation; an already issued
token can remain valid for its remaining lifetime, at most five minutes under
the supplied realm settings.

## Deployment order for an existing alpha

Use a newly published, versioned server release containing these changes.
Do not modify an existing GitHub release or replace a running image by a mutable
tag. These changes are not part of `0.1.0-alpha.2`.

1. Create and verify an encrypted server backup, and retain the current private
   environment pair and public realm/proxy configuration for rollback. Preserve
   the existing `backup.key`, TLS keys and database credentials.
2. Download and verify the new release as described in `server-releases.md`.
   Its `server-alpha.sh` wrapper verifies the release checksums and uses only
   its pinned operator image. Set `dm_release` below to that reviewed directory.
3. While registration remains closed, run the identity migration and explicitly
   approve the existing owner. Review any other existing participants one by
   one before enforcing the new backend role requirement. No bulk approval is
   performed. The migration preserves password recovery and verification state.
4. Stage the new private environment pair and matching public realm/proxy files,
   then use the standard checked update/rollback procedure to activate the new
   release. The staging command leaves registration disabled by default.
   Validate the staged files together: proxy/realm templates now differ from
   the old release. Keycloak realm imports do **not** update an existing realm;
   the authenticated migration is required, not just a restart.
5. Sign in again as the existing owner and check that their papers remain
   accessible. Configure and test email delivery below. Registration stays
   closed until these checks succeed.
6. Once email works, stage the **same** release with `--registration-ready`,
   validate/activate its four files, and restart the edge/collaboration services
   with the reviewed Compose configuration. This publishes the ready capability
   but still does not open Keycloak registration.
7. Run `enable-registration --mail-delivery-confirmed` only after confirming
   receipt of the test/verification email. The operator checks the *running*
   backend's private approval-policy endpoint, scoped role mapping, minimal
   profile, password flow, role defaults, and SMTP configuration before opening
   registration. An older backend or failed restart cannot pass this check.
8. Complete a real test registration with a separate address. Confirm password
   collection, verification mail, pending screen, no papers/storage access,
   operator approval, invitation email and successful sign-in. Test sign-out
   and password recovery too. Keep that account unprivileged outside its own
   test workspace. Do not invite researchers before this end-to-end check.

After public registration has ever been opened, do not roll the collaboration
service back to `0.1.0-alpha.2` or another version without the approval gate.
Closing signup does not revoke accounts or tokens already created for pending
users: an older backend would accept them. Keep a gate-enforcing backend during
UI rollback, or put the service into maintenance and plan identity/session
revocation before any older-backend recovery. The initial four-file rollback is
safe only while signup has remained closed throughout that first migration.

Run operator commands **on the VPS**, using the downloaded release:

```sh
dm_bundle="$dm_release/draftmatter-server"
sudo sh "$dm_bundle/scripts/server-alpha.sh" "$dm_release" /etc/draftmatter \
  migrate --owner-email vezy.remi@gmail.com
```

The command prompts privately for the permanent Keycloak `remi-admin` password.
Do not put that password on the command line, in chat, in shell history, or in
an environment variable. The temporary master session is closed after use.
The public proxy continues to block administrator and master-realm routes.
The wrapper can run against the existing stack before the backend update.

The offline staging tool prepares only `runtime.env.next`, `release.env.next`,
`realm.json.next` and `Caddyfile.next`. It refuses to overwrite an earlier staged
update. It adds/preserves the separate random admission token and the approval
role requirement; it does not rotate other credentials or touch live settings.
Use `stage` through the release wrapper for initial staging, then
`stage --registration-ready` for the final same-release capability update.
Activation must preserve the previous **four-file** configuration together for
rollback. An operator must not simply rename one environment file and leave
the proxy/realm pair from another version.

## Outgoing email

Receiving messages at `contact@draftmatter.eu` does not prove that it is an SMTP
mailbox. A forwarding-only address needs a real sending mailbox before signup
can be enabled. Confirm the mailbox product and its SMTP host with the provider;
do not guess an Exchange/Email Pro host from MX Plan documentation.

Create `/etc/draftmatter/mail.env` as a root-owned regular file with mode `600`.
Edit it privately on the VPS; never commit or paste the completed file.
For a confirmed OVH MX Plan mailbox, a typical configuration is:

```dotenv
DM_SMTP_HOST=smtp.mail.ovh.net
DM_SMTP_PORT=465
DM_SMTP_USER=contact@draftmatter.eu
DM_SMTP_FROM=contact@draftmatter.eu
DM_SMTP_PASSWORD="REPLACE_PRIVATELY_WITH_THE_MAILBOX_PASSWORD"
```

Alternatively, use `DM_SMTP_PASSWORD_BASE64` with the UTF-8 password encoded as
canonical base64, and omit `DM_SMTP_PASSWORD`. This preserves passwords containing
quotes, backslashes, `#` or other dotenv punctuation. Base64 is only an encoding;
the completed file is still a password file and must remain private.

The following can prepare the private file **before** upgrading alpha.2: it
does not contact SMTP, change the running services or enable registration. It
refuses an existing file and reads the mailbox password from the terminal with
echo disabled. This example is for the confirmed MX Plan/Zimbra Starter SMTP
settings above; Email Pro or Exchange may require a different confirmed host.

Run on the VPS, in the interactive `deploy@draftmatter` terminal:

```sh
command -v python3 >/dev/null && sudo python3 - <<'PY'
import base64, getpass, os, stat
directory = '/etc/draftmatter'
info = os.lstat(directory)
if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
    raise SystemExit('Expected the existing root-owned private deployment directory; stopped.')
target = directory + '/mail.env'
if os.path.lexists(target):
    raise SystemExit('mail.env already exists; it was preserved.')
tty = os.open('/dev/tty', os.O_RDWR | os.O_NOCTTY)
os.close(tty)
password = getpass.getpass('OVH mailbox password for contact@draftmatter.eu (hidden): ')
if not password or len(password) > 1024 or any(c in password for c in '\r\n\0'):
    raise SystemExit('Invalid mailbox password; no file created.')
content = 'DM_SMTP_HOST=smtp.mail.ovh.net\nDM_SMTP_PORT=465\nDM_SMTP_USER=contact@draftmatter.eu\nDM_SMTP_FROM=contact@draftmatter.eu\n'
content += 'DM_SMTP_PASSWORD_BASE64=' + base64.b64encode(password.encode('utf-8')).decode('ascii') + '\n'
descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
    output.write(content)
    output.flush()
    os.fsync(output.fileno())
print('SMTP credentials saved privately. No service was changed and no email was sent.')
PY
```

Keep the completed file and the password out of chat, screenshots and shell
history. After the reviewed new release is published, migrate/configure/test
using its operator commands below; those commands are not shipped in alpha.2.

Port 465 uses TLS immediately; port 587 requires STARTTLS, with no plaintext
fallback. Both require valid server certificates and mailbox authentication.
The authenticated mailbox must also be the sender. No SMTP settings or secrets
are included in the public runtime configuration or imported realm JSON.
Keycloak has a separate outbound mail network, with no published identity or
administrator ports. The operator has access to its private identity network
and the frontend network for SMTP and the live-policy check.

```sh
sudo sh "$dm_bundle/scripts/server-alpha.sh" "$dm_release" /etc/draftmatter configure-mail
sudo sh "$dm_bundle/scripts/server-alpha.sh" "$dm_release" /etc/draftmatter \
  test-mail --email vezy.remi@gmail.com
```

`accepted: true` means the SMTP server accepted the message, **not** that it
arrived in the inbox. Check the inbox/spam folder and the sender domain's
SPF/DKIM/DMARC configuration. Also test a verification or password-recovery
message sent by Keycloak itself. Enabling registration reapplies the tested
private SMTP configuration so an old Keycloak password cannot silently remain
after a mailbox credential rotation.

```sh
sudo sh "$dm_bundle/scripts/server-alpha.sh" "$dm_release" /etc/draftmatter \
  enable-registration --mail-delivery-confirmed
```

Do not use the confirmation switch until receipt has actually been checked.
Update the public privacy processor description to reflect the real email
provider before opening registration. Mail recipients' providers also process
the verification and invitation messages they receive.

## Reviewing and inviting registered users

```sh
sudo sh "$dm_bundle/scripts/server-alpha.sh" "$dm_release" /etc/draftmatter pending
sudo sh "$dm_bundle/scripts/server-alpha.sh" "$dm_release" /etc/draftmatter \
  approve --email researcher@example.org
```

The pending list contains personal information: inspect it in the private VPS
terminal, not a public issue or CI log. Approval grants access to the alpha; a
workspace invitation is a separate step with its own project permissions.
The invitation email contains only the normal application URL, not a sign-in
token or a password-reset link. The recipient uses their chosen password.

Private receipts under `/etc/draftmatter/alpha-notifications` prevent repeated
approval commands from automatically mailing the same account again. Receipts
are atomic and contain delivery state/time, not email content, passwords or
tokens. Include them with private configuration backups/deletion handling.
If delivery fails after approval, the account remains approved and the result
states that notification was not confirmed. SMTP disconnects can be ambiguous:
check delivery before an explicit resend:

```sh
sudo sh "$dm_bundle/scripts/server-alpha.sh" "$dm_release" /etc/draftmatter \
  notify --email researcher@example.org --resend
```

An interrupted process may leave a `.lock` file. Confirm no operator is active
and inspect the corresponding private receipt before removing that stale lock;
do not automate lock removal or resending. Delete receipts when their account
is deleted, following the same active-system and backup expiry rules.

## Abuse controls and stopping registration

The identity proxy checks registration, reset and verification actions through
a private, bodyless admission request. It never forwards passwords to the
collaboration service. The service applies independent signup/account budgets:
20 requests per IP per hour, at most 100 registration actions and 300 account
actions globally per rolling day. Both GET and POST count, so these are action
budgets rather than counts of completed registrations. State is bounded and
process-local; a restart resets counters. Review legitimate traffic and abuse
before changing limits. Proxy checks fail closed if the gate is unavailable.

To stop new registrations while preserving sign-in and password recovery:

```sh
sudo sh "$dm_bundle/scripts/server-alpha.sh" "$dm_release" /etc/draftmatter close-registration
```

Then stage/activate the same release without `--registration-ready` to remove
the Register capability and email promises from the app. Existing approved
accounts keep their access. Revoking individual access is an identity role
administration operation; allow for the remaining token lifetime described
above. A project owner must separately review workspace membership.

References: [Keycloak 26.7 administration](https://www.keycloak.org/docs/26.7.0/server_admin/index.html),
[Admin REST API](https://www.keycloak.org/docs-api/26.7.0/rest-api/index.html),
[Caddy forward authentication](https://caddyserver.com/docs/caddyfile/directives/forward_auth),
[OVH MX Plan documentation](https://docs.ovhcloud.com/fr/guides/web-cloud/email-and-collaborative-solutions/mx-plan/email-creation).
