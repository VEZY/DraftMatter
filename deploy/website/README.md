# Public website on OVH

Target: **https://www.draftmatter.eu/**, with the apex domain redirecting to it.
GitHub Actions builds the static public website and uploads the artifact to
OVH's free hosting. GitHub Pages can keep its separate existing deployment;
**the custom domain's DNS points to OVH, not GitHub Pages**. Application sign-in,
collaboration, databases and research data are outside this website deployment.

The upload is SFTP on port 22 with a pinned Ed25519 server host key. The
previously supplied `ftp.cluster129.hosting.ovh.net` rejects explicit FTPS;
there is deliberately no cleartext FTP fallback. OVH documents enabling SFTP
on its free hosting independently of SSH shell access.

## One-time OVH configuration

1. In **Web Cloud → Hosting plans**, select the free hosting for **draftmatter.eu**.
   If only the `.fr` service exists, activate the hosting included with `.eu`
   first, or explicitly confirm OVH allows associating `.eu` with that service.
   Do not assume the `.fr` FTP account serves `.eu`.
2. In the website/domain association, configure `draftmatter.eu` and
   `www.draftmatter.eu` for the same confirmed document root, normally `www`.
3. Read the hosting's assigned IPv4 and IPv6 from its General information.
   In the authoritative `.eu` DNS zone, replace only the conflicting web records
   for `@` and `www` with that hosting's addresses. Do not copy `.fr` addresses
   without verifying that both names use the same hosting. Leave mail MX, SPF,
   DKIM, autodiscover, DMARC and future app/sync/auth names unchanged.
4. Enable SSL for both hostnames and confirm the certificate is issued before
   publishing the HTTPS redirect in `.htaccess`.
5. In **FTP-SSH**, enable the **SFTP** checkbox for the website user. No paid SSH
   shell is required. Note its exact host, login and document-root path. The
   relative SFTP path is usually `www`; `/www` is not universally the same path.
6. Obtain and verify that server's SSH host key/fingerprint through your trusted
   hosting/SFTP setup, then pin its `ssh-ed25519 AAAA...` public key below.
   `ssh-keyscan` can retrieve a candidate key, but does not authenticate it.
   Do not replace a changed pinned key without checking the hosting provider.

Never put the FTP password in chat, a workflow file, a Git commit or a command
argument. The old password-retrieval link is not needed for this setup.

## GitHub environment

Create the `ovh-website` environment in `VEZY/DraftMatter`. Set these variables:

| Variable | Value |
| --- | --- |
| `OVH_SFTP_HOST` | Exact host from this hosting's FTP-SSH tab |
| `OVH_SFTP_DIRECTORY` | Confirmed SFTP path, normally `www` |
| `OVH_SFTP_HOST_KEY` | Verified server public key: `ssh-ed25519 AAAA...` |
| `DRAFTMATTER_LEGAL_PUBLISHER_NAME` | `Rémi Vezy` |
| `DRAFTMATTER_LEGAL_CONTACT_EMAIL` | `contact@draftmatter.eu`, once receiving mail is verified |
| `DRAFTMATTER_WEBSITE_HOSTING_DETAILS` | Actual website hosting provider's name, address and contact |
| `DRAFTMATTER_WEBSITE_DATA_LOCATION` | Confirmed website/data location; distinguish the unopened collaboration service |
| `DRAFTMATTER_LEGAL_ADDITIONAL_PROCESSORS` | Actual contact email and other enabled providers |

Create two **environment secrets**: `OVH_SFTP_USERNAME` and `OVH_SFTP_PASSWORD`.
The build job receives only public variables. The SFTP secrets are referenced
only in the deploy job, which downloads the already validated public artifact.

The workflow must be on the default branch before GitHub permits its initial
manual dispatch. Every push to `main` builds and tests the public website, even
when that commit changes only application or server files. After the first verified
publication, set the **repository variable** `OVH_WEBSITE_AUTO_DEPLOY=true` to upload
each successful build automatically. Failed checks prevent the upload. Leave the
variable absent or `false` to pause automatic publication. Restrict the
`ovh-website` environment to `main`.

## Build, test and publish

From the repository root:

```sh
npm ci
DRAFTMATTER_SITE_BASE=/ npm run build:website
python3 -m venv /tmp/draftmatter-website-python
/tmp/draftmatter-website-python/bin/pip install -r deploy/website/requirements.txt
/tmp/draftmatter-website-python/bin/python -m unittest discover -s deploy/website -p 'test_*.py'
python3 deploy/website/deploy.py --build-dir dist-website --validate-only
npx playwright test --config deploy/website/playwright.config.ts
```

The uploader accepts only public static files, rejects symlinks and secret/dot
files, checks all referenced entry assets, and reserves headroom under the
100 MB allowance. It creates hashed assets first and atomically replaces each
file; `index.html` follows the assets. It never recursively deletes remote
files. Stale assets from prior releases remain for open browsers; monitor OVH's
space usage and review a separate cleanup before the free quota fills.

Run **Actions → DraftMatter website on OVH → Run workflow** after configuration.
A manual run builds and tests by default; check **publish** only when the SFTP
credentials and HTTPS certificate are ready. The first automatic build keeps
uploads disabled, so it can be verified before the OVH setup is complete.
Success requires HTTPS responses for the release manifest, every file digest
compared against the downloaded build, and the actual domain root. A green
build alone is not a completed deployment. DNS and SSL must already be ready;
the verifier's retries cover brief propagation delays, not initial provisioning.

The manifest is public and contains only source revision, public filenames and
SHA-256 digests. It contains no server credentials or research data.

## Recovery and limitations

The existing site stays in place if uploading an asset fails before the HTML
switch. A failure after publication can leave a partially updated release;
inspect the run, then rebuild/redeploy the previous source revision to roll back.
GitHub retains the build artifact for 14 days. Keep exact release identifiers.

The workflow deliberately refuses missing or placeholder legal metadata. Do not
claim France as the actual location until the hosting service confirms it.
Update the website's hosting information separately when the alpha backend opens.
The signup link stays disabled until its intake or the live application is ready.

## Sources

- [OVH: enable SFTP, including free hosting](https://docs.ovhcloud.com/en/guides/web-cloud/web-hosting/enable-sftp).
- [GitHub: deployment environments and secrets](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).
- [GitHub: custom domains for Pages](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site).
