import type { LegalConfiguration, LegalDocumentId } from './legalConfig'

function Contact({ configuration }: { configuration: LegalConfiguration }) {
  const email = configuration.contactEmail.trim()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ? <a href={`mailto:${email}`}>{email}</a>
    : <span>A contact address will be provided before the hosted alpha opens.</span>
}

function HostingSummary({ configuration }: { configuration: LegalConfiguration }) {
  return <p>{configuration.dataLocation || 'Hosting for the hosted alpha is planned in France, with a French hosting company. The hosting arrangements will be confirmed before it opens.'}</p>
}

function LegalNotice({ configuration }: { configuration: LegalConfiguration }) {
  return <>
    <section aria-labelledby="legal-publisher">
      <h2 id="legal-publisher">Publisher and contact</h2>
      <p>DraftMatter is scientific writing software and an experimental collaboration service. The free, invitation-only alpha is operated by {configuration.publisherName}, an individual who is also the publication director.</p>
      <p>To contact the publisher, report content, or make a personal data request: <Contact configuration={configuration} />.</p>
    </section>
    <section aria-labelledby="legal-hosting">
      <h2 id="legal-hosting">Hosting</h2>
      <HostingSummary configuration={configuration} />
      <p className="legal-details">Hosting provider: {configuration.hostingDetails || 'The provider’s legal identity, address and contact details will be published here before the hosted alpha opens.'}</p>
    </section>
    <section aria-labelledby="legal-rights">
      <h2 id="legal-rights">Software and content</h2>
      <p>DraftMatter’s code is distributed under the MIT licence, subject to its dependencies’ own licences. These hosted-alpha terms do not remove the rights granted by that licence.</p>
      <p>Manuscripts, references, figures, datasets and comments remain subject to their authors’ and other rights holders’ rights. Hosting content does not make it public or grant the publisher the right to publish the research.</p>
      <p><a href="https://github.com/VEZY/DraftMatter">Source code and documentation</a> · <a href="https://github.com/VEZY/DraftMatter/blob/main/LICENSE">MIT licence</a></p>
    </section>
    <section aria-labelledby="legal-report">
      <h2 id="legal-report">Reporting a problem</h2>
      <p>Report security, privacy or content concerns to the contact above, describing the issue and, if necessary, the affected project identifier. Do not post passwords, access tokens or confidential research data in a public GitHub issue.</p>
    </section>
  </>
}

function PrivacyPolicy({ configuration }: { configuration: LegalConfiguration }) {
  return <>
    <section aria-labelledby="privacy-scope">
      <h2 id="privacy-scope">Who processes your data?</h2>
      <p>{configuration.publisherName} is the controller for personal data needed to manage this alpha: accounts, access, support and security. Contact: <Contact configuration={configuration} />.</p>
      <p>Responsibilities for research data provided by a laboratory or another organisation depend on the project. The organisation may remain the controller, with DraftMatter acting on its behalf. This alpha is not intended for sensitive personal data, health data, or information subject to special confidentiality or hosting requirements.</p>
    </section>
    <section aria-labelledby="privacy-local">
      <h2 id="privacy-local">Local work and hosted collaboration</h2>
      <p>You can work on local projects without a DraftMatter account. Opening a local project does not automatically upload its folder. Local files, preferences, drafts and caches remain on your device unless you choose a sharing function, an external service, or separate file synchronisation.</p>
      <p>Hosted collaboration sends the content you share to the service: manuscript text, references and associated resources, comments and suggestions, collaboration history, and the data files you upload. Copies, exports and downloads made by a collaborator remain under that person’s control.</p>
      <p>DraftMatter is pre-production software. Data loss or corruption may occur. Keep independent backups of important work outside DraftMatter, including local files and shared datasets.</p>
    </section>
    <section aria-labelledby="privacy-purpose">
      <h2 id="privacy-purpose">Data used and purposes</h2>
      <dl>
        <dt>Account and access</dt>
        <dd>Email address, display name, account identifier, authentication information and roles are used to identify you, manage invitations and enforce permissions. The identity provider handles sign-in and any passwords; the collaboration service receives the information needed to verify access.</dd>
        <dt>Collaborative projects</dt>
        <dd>Manuscripts, files, project and file names, references, change attribution and activity dates are used to store, synchronise, display, download and recover shared work. Collaborators can see content and attribution according to their permissions.</dd>
        <dt>Support and testing feedback</dt>
        <dd>Messages you choose to send, reply details and information needed to diagnose a problem. Avoid attaching manuscripts or datasets; a project identifier and a description are usually sufficient.</dd>
        <dt>Operations and security</dt>
        <dd>Connection and request information available to the service, technical identifiers, access and administration events, errors and diagnostic records are used to protect accounts, prevent abuse and operate the service.</dd>
      </dl>
      <p>Account and project management is based on performing the alpha’s terms of use. Security, abuse prevention and support are based on the legitimate interest in operating and improving a reliable service, subject to your rights. Applicable legal obligations are a separate basis where they require processing.</p>
      <p>Information essential to sign-in and sharing is required for those functions. You may choose not to use hosted collaboration and continue working locally. Testing feedback and external features are optional.</p>
    </section>
    <section aria-labelledby="privacy-access">
      <h2 id="privacy-access">Who can access your data?</h2>
      <p>Hosted projects are not published openly on the Internet. Access depends on workspace membership and roles, together with project-specific roles. Workspace members may have default access to its projects: use separate workspaces for groups that should not share their work.</p>
      <p>The operator and service providers may access data where necessary for operations, support, security or a legal obligation. DraftMatter does not provide end-to-end encryption that prevents the operator from reading content. Administrative access must be limited to those needs.</p>
      <HostingSummary configuration={configuration} />
      <p>The hosting provider’s legal identification is given in the Legal notice. Hosting, storage, backup and authentication providers process data only for the functions they provide.</p>
      {configuration.additionalProcessors && <p>Other service providers: {configuration.additionalProcessors}</p>}
      {configuration.contactEmail.toLowerCase().endsWith('@gmail.com') && <p>This alpha’s contact address uses Gmail, provided by Google. Support messages therefore pass through that service and may be processed outside the European Union under <a href="https://policies.google.com/privacy?hl=en">Google’s terms and safeguards</a>. Do not send confidential research data by email. Contact email is separate from project storage.</p>}
      <p>The publisher does not sell your data, use it for targeted advertising, or provide your manuscripts to an AI provider to train its models.</p>
    </section>
    <section aria-labelledby="privacy-external">
      <h2 id="privacy-external">External features and AI assistants</h2>
      <p>Features you choose may contact services separate from DraftMatter’s hosting. An online reference search sends its query or DOI to Crossref; opening a DOI or another link contacts the corresponding website. Connecting Zotero Desktop queries its local library. These services have their own policies.</p>
      <p>AI assistants are optional and configured by you. Project permissions can restrict their access within DraftMatter. An authorised assistant may read accessible content and transmit it to its model provider according to its configuration and terms. Check those terms before granting access to confidential manuscripts or data.</p>
    </section>
    <section aria-labelledby="privacy-retention">
      <h2 id="privacy-retention">Retention and the end of the alpha</h2>
      <p>Accounts and shared content are retained during participation and while needed for active projects. Earlier versions and history may be retained for collaboration and recovery; replacing a file does not automatically delete its previous version.</p>
      <p>Following a valid deletion request or service closure, the affected data is removed from active systems within {configuration.deletionDays} days. Copies may remain in backups for up to {configuration.backupDays} additional days before expiring. A legal obligation or dispute may justify separate, limited retention; you will be informed where the law permits.</p>
      <p>Deleting your account does not necessarily erase other authors’ shared work. Attribution, comments or history may need to be anonymised or retained to a limited extent to protect their rights. Requests are reviewed individually and the publisher will explain the outcome.</p>
      <p>Incomplete upload parts expire after seven days without activity. Operational logs are limited to diagnostic and security needs; project history follows the project’s retention. Support requests are kept while being handled and for up to {configuration.deletionDays} days after closure, unless justified legal requirements apply.</p>
      <p>DraftMatter does not delete copies held on your devices, in your own backups, or with other services. Retrieve the manuscripts and files you need before leaving the alpha. Retention periods describe deletion handling, not a guarantee that data will remain available or recoverable throughout that time.</p>
    </section>
    <section aria-labelledby="privacy-storage">
      <h2 id="privacy-storage">Cookies and device storage</h2>
      <p>DraftMatter uses browser or application storage for drafts, preferences, sign-in sessions and resumable transfers. The identity provider may use cookies needed for authentication. This version does not include advertising or advertising analytics.</p>
      <p>Clearing application storage can remove a local draft or information needed to resume a transfer. Sign out and remove local copies after using a shared device.</p>
    </section>
    <section aria-labelledby="privacy-rights">
      <h2 id="privacy-rights">Your rights and requests</h2>
      <p>You may request access, correction, erasure or restriction of your personal data. Depending on the legal basis and your circumstances, you may object to processing and exercise data portability rights. Any consent can be withdrawn for processing based on that consent, without affecting earlier lawful processing.</p>
      <p>Send requests to <Contact configuration={configuration} />, identifying the account and request. Proportionate identity checks may be needed. You will receive a response within the legal deadline, normally one month; a reasoned extension is possible where the GDPR allows it.</p>
      <p>If you believe your rights have not been respected, you may <a href="https://www.cnil.fr/fr/adresser-une-plainte">complain to the French data protection authority, the CNIL</a>. You do not need the publisher’s permission to do so.</p>
    </section>
  </>
}

function AlphaTerms({ configuration }: { configuration: LegalConfiguration }) {
  return <>
    <section aria-labelledby="terms-purpose">
      <h2 id="terms-purpose">Purpose and scope</h2>
      <p>These terms govern participation in the DraftMatter collaboration service operated by {configuration.publisherName}. This is a free, invitation-only, pre-production alpha for testing scientific writing and collecting feedback. No paid subscription, storage payment or commitment to a future purchase is required during this alpha.</p>
      <p>These terms are available before you use hosted collaboration. The MIT licence continues to apply to the open-source software, including local use and installations independent of this alpha. Participation does not require you to publish your research or provide testing feedback.</p>
    </section>
    <section aria-labelledby="terms-experimental">
      <h2 id="terms-experimental">Testing and data loss</h2>
      <p><strong>DraftMatter is pre-production software. Bugs, updates, interruptions and failed synchronisation may cause data loss, corruption or permanent unavailability. Recovery may be incomplete or impossible.</strong></p>
      <p>You are solely responsible for maintaining your own independent backups of your manuscripts, datasets, references, figures and other important work outside DraftMatter, and for checking that those backups can be restored. Keep copies before testing and after important changes. Do not use DraftMatter as the only repository for irreplaceable data.</p>
      <p>Synchronisation, version history and server backups do not replace independent backups under your control. An export of a manuscript or a saved project version may not include every dataset or local file; back those up separately. Loss can also affect local drafts, for example when browser storage is cleared or a device fails.</p>
      <p>No availability level, support response time, uninterrupted operation or scientific result is guaranteed during this alpha. Check results, references, exports and suggested changes before relying on them in your research.</p>
      <p>The operator remains subject to applicable security and personal data protection obligations. Nothing in these terms excludes or limits mandatory rights, statutory guarantees, or liability that cannot lawfully be excluded or limited.</p>
    </section>
    <section aria-labelledby="terms-access">
      <h2 id="terms-access">Invitations, accounts and sharing</h2>
      <p>Access is limited to invited participants. Use your own account, protect your sign-in credentials, and do not use someone else’s account. Report suspected unauthorised access promptly to <Contact configuration={configuration} />.</p>
      <p>Workspace owners manage invitations and roles. A member’s workspace rights may apply to its projects by default; project-specific roles then determine permitted actions. Check workspace membership and project permissions before sharing content. Create a separate workspace for a different group of collaborators.</p>
      <p>Authorised collaborators may view or download content according to their permissions. Revoking access prevents subsequent access to the service, but does not remove copies already downloaded.</p>
    </section>
    <section aria-labelledby="terms-files">
      <h2 id="terms-files">Files, quota and retrieving your work</h2>
      <p>The alpha includes a data-file quota of 1 GB per project: 1,000,000,000 bytes. Retained file versions and space reserved for incomplete uploads count towards it. Replacing a file may therefore leave its previous version using space.</p>
      <p>Transfers can resume when technical conditions allow. Incomplete uploads are abandoned after seven days without activity. Interruptions, browser closure or device storage limits may require you to select a file again or restart a download.</p>
      <p>You can retrieve manuscripts using the available export functions and download shared files you are allowed to access. If this fails, contact the publisher before leaving the test. These retrieval features do not replace your responsibility to maintain independent backups.</p>
    </section>
    <section aria-labelledby="terms-content">
      <h2 id="terms-content">Your content and permitted use</h2>
      <p>You retain your rights in the content you contribute. You must have the rights and permissions needed to share it with the relevant collaborators. Respect copyright, collaboration agreements and obligations to your organisation and the people concerned.</p>
      <p>You authorise the publisher, only for the service’s duration and operation, to host, copy, synchronise, back up and return this content to authorised people. This limited permission also covers managing service closure; it does not transfer ownership or authorise the publisher to publish or reuse your research.</p>
      <p>Do not use this alpha for health data, sensitive personal data, protected secrets or information requiring special security, confidentiality or location safeguards. Prefer test or anonymised data and content you are authorised to share.</p>
      <p>Unlawful content, unauthorised access, attempts to bypass permissions or quotas, malware and attempts to disrupt the service are prohibited. You control execution tools and external assistants: review the code you run and the permissions you grant.</p>
    </section>
    <section aria-labelledby="terms-end">
      <h2 id="terms-end">Leaving, suspension and closure</h2>
      <p>You can leave the alpha at any time and request account deletion at <Contact configuration={configuration} />. First make and check independent copies of the work you need. Valid deletion requests follow the privacy policy’s deadlines and the rights of other contributors.</p>
      <p>Access may be suspended where necessary to address a security incident, abuse or breach of these terms. Measures must be proportionate; the reason and a contact route will be provided unless security or the law prevents this.</p>
      <p>For a planned service closure, the publisher will give at least {configuration.noticeDays} days’ notice and provide guidance on retrieving data. An emergency or external incident may prevent that notice or data retrieval. Do not postpone independent backups until a closure announcement. Data deletion and backup expiry follow the privacy policy.</p>
    </section>
    <section aria-labelledby="terms-changes">
      <h2 id="terms-changes">Changes and applicable law</h2>
      <p>Each document displays its date and version. Material changes will be announced before taking effect, except where urgent legal or security requirements apply. Any future paid service would require a separate offer and terms; it would not be activated automatically.</p>
      <p>French law applies, subject to mandatory protections available in your country. Contact the publisher first to seek an amicable solution. Jurisdiction follows applicable legal rules; these terms do not impose an exclusive court.</p>
    </section>
  </>
}

export function LegalDocumentContent({ documentId, configuration }: {
  documentId: LegalDocumentId
  configuration: LegalConfiguration
}) {
  if (documentId === 'mentions-legales') return <LegalNotice configuration={configuration} />
  if (documentId === 'confidentialite') return <PrivacyPolicy configuration={configuration} />
  return <AlphaTerms configuration={configuration} />
}
