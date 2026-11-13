import type { LegalConfiguration, LegalDocumentId } from './legalConfig'

function Contact({ configuration }: { configuration: LegalConfiguration }) {
  const email = configuration.contactEmail.trim()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ? <a href={`mailto:${email}`}>{email}</a>
    : <span>Adresse de contact à renseigner avant l’ouverture de l’alpha.</span>
}

function LegalNotice({ configuration }: { configuration: LegalConfiguration }) {
  return <>
    <section aria-labelledby="legal-publisher">
      <h2 id="legal-publisher">Éditeur et contact</h2>
      <p>DraftMatter est un logiciel de rédaction scientifique et un service expérimental de collaboration. L’alpha fermée et gratuite est proposée par {configuration.publisherName}, personne physique, qui en assure la direction de la publication.</p>
      <p>Pour contacter l’éditeur, signaler un contenu ou exercer vos droits sur vos données : <Contact configuration={configuration} />.</p>
    </section>
    <section aria-labelledby="legal-hosting">
      <h2 id="legal-hosting">Hébergement de cette instance</h2>
      <p className="legal-details">{configuration.hostingDetails || 'Les coordonnées de l’hébergeur seront renseignées avant l’ouverture de l’alpha hébergée.'}</p>
      <p className="legal-details">Localisation des données du service : {configuration.dataLocation || 'à confirmer avant l’ouverture de l’alpha hébergée'}.</p>
      <p>Ces informations concernent cette instance de DraftMatter. Une installation locale ou un autre serveur peut avoir un exploitant et des conditions d’hébergement différents.</p>
    </section>
    <section aria-labelledby="legal-rights">
      <h2 id="legal-rights">Logiciel et contenus</h2>
      <p>Le code de DraftMatter est distribué sous licence MIT, sous réserve des licences propres à ses dépendances. Les conditions de l’alpha hébergée ne retirent pas les droits accordés par cette licence.</p>
      <p>Les manuscrits, références, figures, données et commentaires restent soumis aux droits de leurs auteurs et autres titulaires. Le fait de les héberger ne les rend pas publics et n’accorde pas à l’éditeur un droit de publication scientifique.</p>
      <p><a href="https://github.com/VEZY/DraftMatter">Code source et documentation</a> · <a href="https://github.com/VEZY/DraftMatter/blob/main/LICENSE">Licence MIT</a></p>
    </section>
    <section aria-labelledby="legal-report">
      <h2 id="legal-report">Signaler un problème</h2>
      <p>Pour signaler un problème de sécurité, de confidentialité ou de contenu, utilisez le contact ci-dessus en indiquant le problème et, si nécessaire, l’identifiant du projet concerné. Ne publiez pas de mot de passe, de jeton d’accès ou de données de recherche confidentielles dans une issue GitHub.</p>
    </section>
  </>
}

function PrivacyPolicy({ configuration }: { configuration: LegalConfiguration }) {
  return <>
    <section aria-labelledby="privacy-scope">
      <h2 id="privacy-scope">Qui traite les données et pour quel service ?</h2>
      <p>{configuration.publisherName} est le responsable des traitements nécessaires à la gestion de cette alpha : comptes, accès, assistance et sécurité. Contact : <Contact configuration={configuration} />.</p>
      <p>Pour les données de recherche confiées par un laboratoire ou une autre organisation, les responsabilités dépendent du projet. L’organisation peut rester responsable du traitement et DraftMatter intervenir pour son compte. Cette alpha n’est pas destinée à recevoir des données personnelles sensibles, de santé, ou soumises à des obligations particulières de confidentialité ou d’hébergement.</p>
    </section>
    <section aria-labelledby="privacy-local">
      <h2 id="privacy-local">Travail local et collaboration hébergée</h2>
      <p>Vous pouvez travailler sur des projets locaux sans compte DraftMatter. L’ouverture d’un projet local ne téléverse pas automatiquement son dossier sur le serveur. Les fichiers, préférences, brouillons et caches locaux restent sur l’appareil, sauf si vous choisissez une fonction de partage, un service externe ou une synchronisation de fichiers indépendante de DraftMatter.</p>
      <p>Lorsque vous utilisez la collaboration hébergée, les données partagées sont envoyées au serveur : contenu du manuscrit, références et ressources associées, commentaires et suggestions, historique de collaboration, ainsi que les fichiers de données que vous téléversez. Une copie locale, un export ou un téléchargement effectué par un collaborateur reste sous son contrôle.</p>
    </section>
    <section aria-labelledby="privacy-purpose">
      <h2 id="privacy-purpose">Données utilisées et finalités</h2>
      <dl>
        <dt>Compte et accès au service</dt>
        <dd>Adresse e-mail, nom affiché, identifiant du compte, informations d’authentification et rôles. Ces informations servent à vous identifier, gérer les invitations et appliquer les autorisations. Le fournisseur d’identité gère la connexion et les éventuels mots de passe ; le service de collaboration reçoit les informations nécessaires pour vérifier votre accès.</dd>
        <dt>Projets collaboratifs</dt>
        <dd>Manuscrits, fichiers, noms de projets et de fichiers, références, auteurs des modifications et dates d’activité. Ils servent à stocker, synchroniser, présenter, télécharger et restaurer les travaux partagés. Vos collaborateurs voient les contenus et les attributions correspondant à leurs droits.</dd>
        <dt>Assistance et retours de test</dt>
        <dd>Messages que vous envoyez volontairement, coordonnées de réponse et informations utiles au diagnostic. Évitez de joindre des manuscrits ou jeux de données ; un identifiant de projet et une description du problème suffisent généralement.</dd>
        <dt>Fonctionnement et sécurité</dt>
        <dd>Informations de connexion et de requête disponibles pour les serveurs, identifiants techniques, événements d’accès et d’administration, erreurs et traces nécessaires au diagnostic. Ils servent à protéger les comptes, limiter les abus et assurer le fonctionnement du service.</dd>
      </dl>
      <p>La gestion du compte et des projets repose sur l’exécution des conditions d’utilisation de l’alpha. La sécurité, la prévention des abus et le traitement des demandes d’assistance reposent sur l’intérêt légitime à exploiter et améliorer un service fiable, dans le respect de vos droits. Les obligations légales applicables constituent une base distincte lorsque leur respect impose un traitement.</p>
      <p>Les champs indispensables à la connexion et au partage sont nécessaires pour ces fonctions. Vous pouvez ne pas utiliser la collaboration et continuer à travailler localement. Les retours de test et l’activation des fonctions externes restent facultatifs.</p>
    </section>
    <section aria-labelledby="privacy-access">
      <h2 id="privacy-access">Qui peut accéder aux données ?</h2>
      <p>Les projets hébergés ne sont pas publiés librement sur Internet. Leur accès dépend des membres et des rôles de l’espace de travail, ainsi que des rôles attribués au projet. Un membre de l’espace peut disposer d’un accès par défaut à ses projets : utilisez des espaces distincts pour des groupes qui ne doivent pas partager leurs travaux.</p>
      <p>L’exploitant et ses prestataires techniques peuvent accéder aux données lorsque cela est nécessaire à l’exploitation, à l’assistance, à la sécurité ou à une obligation légale. Le service n’offre pas de chiffrement de bout en bout empêchant l’exploitant de lire les contenus. Les accès d’administration doivent être limités à ces besoins.</p>
      <p>Les prestataires d’hébergement, de stockage, de sauvegarde et d’authentification sont concernés par les fonctions qu’ils assurent. Hébergement : {configuration.hostingDetails || 'prestataire à renseigner avant l’ouverture de l’alpha'}. Localisation : {configuration.dataLocation || 'à confirmer avant l’ouverture de l’alpha'}.</p>
      {configuration.additionalProcessors && <p>Autres prestataires de cette instance : {configuration.additionalProcessors}</p>}
      {configuration.contactEmail.toLowerCase().endsWith('@gmail.com') && <p>Le contact de cette alpha utilise Gmail, fourni par Google. Les messages d’assistance passent donc par cette messagerie et peuvent être traités hors de l’Union européenne selon les <a href="https://policies.google.com/privacy?hl=fr">conditions et garanties de Google</a>. N’y envoyez pas de données de recherche confidentielles. La messagerie de contact n’est pas le stockage des projets.</p>}
      <p>L’éditeur ne vend pas vos données, ne les utilise pas pour de la publicité ciblée et ne fournit pas vos manuscrits à un fournisseur d’IA pour entraîner ses modèles.</p>
    </section>
    <section aria-labelledby="privacy-external">
      <h2 id="privacy-external">Fonctions externes et assistants d’IA</h2>
      <p>Les fonctions que vous choisissez peuvent contacter des services distincts de l’hébergement DraftMatter. Une recherche bibliographique en ligne transmet sa requête ou son DOI à Crossref ; l’ouverture d’un DOI ou d’un lien contacte le site correspondant. La connexion à Zotero Desktop interroge sa bibliothèque locale. Ces services appliquent leurs propres politiques.</p>
      <p>Les assistants d’IA sont facultatifs et configurés par vos soins. Les autorisations de projet permettent de limiter leur accès dans DraftMatter. Lorsque vous utilisez un assistant autorisé, il peut lire les contenus accessibles et les transmettre au fournisseur du modèle selon sa configuration et ses conditions. Vérifiez ces conditions avant de lui donner accès à un manuscrit ou à des données confidentielles.</p>
    </section>
    <section aria-labelledby="privacy-retention">
      <h2 id="privacy-retention">Durées de conservation et fin de l’alpha</h2>
      <p>Les comptes et les contenus partagés sont conservés pendant la participation à l’alpha et tant qu’ils sont utiles aux projets actifs. Les versions antérieures et historiques peuvent rester conservés pour la collaboration et la restauration ; remplacer un fichier ne supprime pas automatiquement sa version précédente.</p>
      <p>Après une demande recevable de suppression ou la fermeture du service, les données concernées sont retirées des systèmes actifs au plus tard sous {configuration.deletionDays} jours. Des copies peuvent subsister dans les sauvegardes pendant au plus {configuration.backupDays} jours supplémentaires, avant leur expiration. Une obligation légale ou un litige peut justifier une conservation distincte et limitée ; vous en êtes informé lorsque la loi le permet.</p>
      <p>Supprimer votre compte n’efface pas nécessairement les travaux communs des autres auteurs. Une attribution, un commentaire ou un historique peut devoir être anonymisé ou conservé de manière limitée afin de préserver leurs droits. Les demandes sont examinées au cas par cas ; l’éditeur vous explique la suite donnée.</p>
      <p>Les fragments d’un téléversement incomplet expirent après sept jours sans activité. Les journaux de fonctionnement sont limités aux besoins de diagnostic et de sécurité ; les événements utiles à l’historique d’un projet suivent sa conservation. Les demandes d’assistance sont conservées pendant leur traitement, puis au plus {configuration.deletionDays} jours après leur clôture, hors nécessité légale justifiée.</p>
      <p>Les copies que vous avez conservées sur vos appareils, dans vos sauvegardes personnelles ou auprès d’autres services ne sont pas supprimées par DraftMatter. Avant de quitter l’alpha, récupérez les manuscrits et fichiers dont vous avez besoin.</p>
    </section>
    <section aria-labelledby="privacy-storage">
      <h2 id="privacy-storage">Cookies et stockage sur l’appareil</h2>
      <p>DraftMatter utilise le stockage du navigateur ou de l’application pour les brouillons, préférences, sessions de connexion et transferts reprenables. Le fournisseur d’identité peut utiliser des cookies nécessaires à l’authentification. Cette version n’intègre pas de publicité ni de mesure d’audience publicitaire.</p>
      <p>Effacer le stockage de l’application peut supprimer un brouillon local ou les informations permettant de reprendre un transfert. Déconnectez-vous et retirez les copies locales après usage sur un appareil partagé.</p>
    </section>
    <section aria-labelledby="privacy-rights">
      <h2 id="privacy-rights">Vos droits et demandes</h2>
      <p>Vous pouvez demander l’accès, la rectification, l’effacement ou la limitation de vos données. Selon la base légale et votre situation, vous pouvez vous opposer à un traitement et exercer votre droit à la portabilité. Un éventuel consentement peut être retiré à tout moment pour les traitements qui reposent sur lui, sans effet rétroactif.</p>
      <p>Adressez votre demande à <Contact configuration={configuration} />, en précisant le compte et la demande. Une vérification d’identité proportionnée peut être nécessaire. Vous recevez une réponse dans le délai légal, en principe un mois ; une prolongation motivée est possible dans les cas prévus par le RGPD.</p>
      <p>Si vous estimez que vos droits ne sont pas respectés, vous pouvez <a href="https://www.cnil.fr/fr/adresser-une-plainte">adresser une réclamation à la CNIL</a>. Cette possibilité n’est pas conditionnée à l’accord de l’éditeur.</p>
    </section>
  </>
}

function AlphaTerms({ configuration }: { configuration: LegalConfiguration }) {
  return <>
    <section aria-labelledby="terms-purpose">
      <h2 id="terms-purpose">Objet et périmètre de l’alpha</h2>
      <p>Ces conditions encadrent la participation au service de collaboration DraftMatter proposé par {configuration.publisherName}. Il s’agit d’une alpha fermée, gratuite, accessible sur invitation, destinée à tester la rédaction scientifique et recueillir des retours. Aucun abonnement payant, paiement de stockage ou engagement d’achat futur n’est prévu pendant cette alpha.</p>
      <p>Ces conditions sont mises à disposition avant l’utilisation du service hébergé. La licence MIT reste applicable au logiciel libre ; elle permet notamment de l’utiliser localement et de l’installer indépendamment de cette alpha. La participation ne vous oblige pas à publier vos recherches ni à fournir un retour de test.</p>
    </section>
    <section aria-labelledby="terms-access">
      <h2 id="terms-access">Invitations, comptes et partage</h2>
      <p>L’accès à cette instance est réservé aux participants invités. Utilisez un compte personnel, protégez vos moyens de connexion et n’utilisez pas le compte d’un tiers. Signalez rapidement tout accès suspect à <Contact configuration={configuration} />.</p>
      <p>Les propriétaires d’espaces de travail gèrent les invitations et les rôles. Les droits d’un membre de l’espace peuvent s’appliquer par défaut à ses projets ; les rôles de projet précisent ensuite les actions autorisées. Avant de téléverser un contenu, vérifiez les membres de l’espace et les droits du projet. Créez un espace distinct pour un autre groupe de collaborateurs.</p>
      <p>Les collaborateurs autorisés peuvent consulter ou télécharger les contenus selon leurs droits. Révoquer un accès empêche les accès ultérieurs au serveur, mais ne retire pas une copie déjà téléchargée.</p>
    </section>
    <section aria-labelledby="terms-files">
      <h2 id="terms-files">Fichiers, quota et récupération des travaux</h2>
      <p>L’alpha inclut un quota de fichiers de données de 1 Go par projet, soit 1 000 000 000 octets. Les versions de fichiers conservées et les volumes réservés aux téléversements incomplets sont comptabilisés. Remplacer un fichier ne libère donc pas nécessairement son volume précédent.</p>
      <p>Les transferts peuvent être repris lorsque les conditions techniques le permettent. Les téléversements incomplets sont abandonnés après sept jours sans activité. Les interruptions, fermetures de navigateur et limites de stockage de l’appareil peuvent nécessiter une nouvelle sélection du fichier ou un nouveau téléchargement.</p>
      <p>Vous pouvez récupérer vos manuscrits par les fonctions d’export disponibles et télécharger les fichiers partagés auxquels vous avez accès. En cas de difficulté, contactez l’éditeur avant de quitter le test. Conservez une copie indépendante de vos travaux importants.</p>
    </section>
    <section aria-labelledby="terms-content">
      <h2 id="terms-content">Vos contenus et usages autorisés</h2>
      <p>Vous conservez vos droits sur les contenus que vous apportez. Vous devez disposer des droits et autorisations nécessaires pour les partager avec les collaborateurs concernés. Respectez notamment les droits d’auteur, les accords de collaboration et les engagements pris envers votre organisme ou les personnes concernées.</p>
      <p>Vous autorisez l’éditeur, pour la durée et les besoins du service, à héberger, copier, synchroniser, sauvegarder et restituer ces contenus aux personnes autorisées. Cette autorisation est limitée à l’exploitation de l’alpha et à la gestion de sa fermeture ; elle ne transfère pas la propriété de vos travaux et n’autorise ni leur publication ni leur réutilisation scientifique par l’éditeur.</p>
      <p>N’utilisez pas cette alpha pour des données de santé, des données personnelles sensibles, des secrets protégés ou des informations soumises à des exigences particulières de sécurité, de confidentialité ou de localisation. Privilégiez des données de test ou anonymisées et des contenus dont le partage est autorisé.</p>
      <p>Sont notamment interdits les contenus illicites, les accès sans autorisation, les tentatives de contournement des permissions ou quotas, les logiciels malveillants et les usages visant à perturber le service. Les outils d’exécution et assistants externes restent sous votre contrôle : vérifiez le code exécuté et les autorisations accordées.</p>
    </section>
    <section aria-labelledby="terms-experimental">
      <h2 id="terms-experimental">Service expérimental et responsabilité</h2>
      <p>Des fonctions peuvent évoluer, échouer ou être temporairement indisponibles. Aucun niveau de disponibilité, délai d’assistance ou résultat scientifique n’est garanti pour cette alpha. Vérifiez les résultats, références, exports et changements proposés avant de les utiliser dans vos recherches.</p>
      <p>L’éditeur prend des mesures adaptées pour protéger et exploiter le service, mais cette alpha ne doit pas être l’unique copie d’un travail irremplaçable. Les responsabilités de chaque partie restent celles prévues par la loi. Ces conditions n’excluent pas les responsabilités ou garanties auxquelles il ne peut légalement être dérogé.</p>
    </section>
    <section aria-labelledby="terms-end">
      <h2 id="terms-end">Arrêt de participation, suspension et fermeture</h2>
      <p>Vous pouvez quitter l’alpha à tout moment et demander la suppression de votre compte à <Contact configuration={configuration} />. Précisez si votre demande concerne aussi un espace ou des contenus dont vous gérez les droits ; les travaux communs d’autres auteurs sont examinés séparément.</p>
      <p>L’accès peut être suspendu pour une raison de sécurité, un usage interdit ou la protection d’autres participants. L’éditeur vous informe et vous permet, lorsque cela est possible et licite, de récupérer vos travaux. Une suspension urgente peut intervenir avant cette information si elle est nécessaire pour contenir un incident.</p>
      <p>Une fermeture planifiée de l’alpha est annoncée au moins {configuration.noticeDays} jours à l’avance pour permettre la récupération des travaux. Une interruption imprévue peut néanmoins survenir. Les données actives concernées sont ensuite supprimées sous {configuration.deletionDays} jours et les copies de sauvegarde sous {configuration.backupDays} jours supplémentaires, sous réserve des exceptions légales expliquées dans la politique de confidentialité.</p>
    </section>
    <section aria-labelledby="terms-changes">
      <h2 id="terms-changes">Évolutions des conditions et droit applicable</h2>
      <p>La date et la version des documents sont affichées sur chaque page. Les changements substantiels sont annoncés aux participants avant leur entrée en vigueur, sauf adaptation urgente imposée par la loi ou la sécurité. Une éventuelle offre payante ferait l’objet d’une proposition et de conditions distinctes ; elle ne serait pas activée automatiquement.</p>
      <p>Le droit français s’applique, sous réserve des dispositions impératives qui vous protègent dans votre pays. En cas de difficulté, contactez d’abord l’éditeur pour rechercher une solution amiable. Les juridictions compétentes sont déterminées par les règles légales applicables ; aucune compétence exclusive n’est imposée par ces conditions.</p>
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
