# Revue de préparation de l’alpha — 17 novembre 2026

Cette revue couvre le site public, l’application web, le serveur collaboratif et
les frontières du client macOS. Elle part du code `b7de87e` (serveur publié
`0.1.0-alpha.1`) et inclut les corrections du répertoire de travail. Ces
corrections ne sont pas encore une release publiée ni une mise à jour du VPS.

Les vérifications du service public sont en lecture seule, dans un navigateur
isolé sans session personnelle. Les écritures, comptes fictifs, tests de charge
bornés et restaurations sont exécutés uniquement sur des fixtures ou des piles
locales dédiées. Aucun papier personnel n’est utilisé comme fixture.

## Conclusion pour les invitations

Le code a été renforcé sur plusieurs frontières réelles. Avant de confier des
travaux au service, il reste à publier puis installer les images corrigées, à
installer une sauvegarde chiffrée indépendante du VPS avec sa clé conservée
séparément, et à vérifier la restauration, les alertes et le pare-feu de l’hôte.
Le succès d’une restauration locale ne prouve pas qu’une sauvegarde du VPS est
effectivement programmée ou externalisée.

L’inscription reste fermée : demander l’accès permet de contacter l’exploitant,
qui active un compte. Une invitation de collaborateur ne crée pas de compte.

## Sécurité : constats et corrections

Les priorités ci-dessous concernent cette alpha ; elles ne sont pas des scores
CVSS ni des vulnérabilités publiées sous un identifiant CVE.

| Priorité | Problème constaté | Correction et preuve |
| --- | --- | --- |
| Haute | Le paramètre `dm-service` d’une invitation pouvait remplacer le serveur configuré par l’exploitant. Un service hostile pouvait annoncer le vrai fournisseur d’identité puis recevoir le jeton obtenu. | Le serveur configuré est désormais la frontière de confiance. Une invitation incompatible est rejetée avant toute connexion ; la reprise OAuth vérifie aussi le serveur de sa transaction. Tests : aucune requête et aucun jeton envoyés au serveur substitué. |
| Haute | Une connexion collaborative pouvait ignorer les demandes de renouvellement et continuer après l’expiration du jeton. | Échéance ferme par connexion, renouvellement vérifié et maintien de la même identité. Tests avec de vraies WebSockets : expiration, rejeu de l’ancien jeton, renouvellement et changement de compte. |
| Haute | Certaines commandes Git pouvaient exécuter des programmes définis par un dépôt local non fiable : SSH, aides d’authentification, signature et comparaison externe. | Rejet des configurations exécutables provenant du dépôt/worktree, y compris les inclusions ; maintien des réglages de confiance de l’utilisateur et du système. Comparaison préparatoire sans programmes externes. Scripts témoins reproduisant réellement l’exécution avant le contrôle. |
| Moyenne | La déconnexion effaçait seulement l’état de l’app ; le navigateur pouvait conserver sa session d’identité et reconnecter silencieusement. | Déconnexion standard du fournisseur : POST navigateur avec indication d’identité conservée uniquement en mémoire, aucun jeton dans l’URL ; invalidation des fonctions de renouvellement. Le client natif ouvre une confirmation dans le navigateur système sans jeton dans son URL. |
| Moyenne | Les gros aperçus de fichiers ne partageaient pas les limites des transferts ordinaires. | Admission commune : huit transferts simultanés au total, deux par compte, durée absolue bornée, capacité conservée jusqu’à la fin du travail de stockage même après déconnexion du client. |
| Moyenne | Les sauvegardes techniques pouvaient recopier indéfiniment un même état et remplir le stockage indépendamment du quota DATA. | Réutilisation du même état pendant 24 h ; plafonds de 100 copies et 1 Go par projet, 5 Go agrégés ; réservation atomique entre processus. Aucune version manuelle de l’utilisateur n’est supprimée pour libérer cette place. |
| Moyenne | Des acceptations d’invitations ou écritures simultanées pouvaient dépasser les limites de places ou de taille du manuscrit. | Sérialisation transactionnelle et tests concurrentiels avec deux pools et une vraie base PostgreSQL, y compris avec une isolation par défaut `REPEATABLE READ`. |
| Moyenne | Un nouveau login pouvait réinitialiser certains budgets HTTP ; plusieurs connexions multipliaient les budgets temps réel. | Budgets attachés au compte, en plus des limites par connexion ; huit documents actifs par compte, 128 sockets physiques au total et file pré-authentification bornée. |
| Moyenne | Un attribut d’adresse e-mail absent ou mal typé pouvait être considéré comme vérifié. | Seul `email_verified === true` autorise l’utilisation de l’adresse pour les invitations adressées. Les autres formes restent non vérifiées. |
| Défense supplémentaire | L’app web ne publiait pas de CSP ni de Permissions-Policy. | Scripts propres au site, pas de script inline, objets et cadrage tiers interdits, fonctions navigateur inutiles désactivées. Déconnexion limitée à l’origine d’identité configurée. Contrôles de déploiement bloquants et tests dans un vrai Caddy et Chromium. Le site vitrine reçoit aussi ses en-têtes via `.htaccess`. |
| Fiabilité | La première connexion lançait deux créations concurrentes du même profil et pouvait produire une erreur PostgreSQL puis un échec d’ouverture de session. | Reprise idempotente strictement limitée à la même identité fournisseur et au même identifiant local. Test concurrent de douze requêtes sur une identité nouvelle, puis validation dans la pile complète. |
| Fiabilité/confidentialité | Une réponse de catalogue tardive pouvait réafficher des données de compte après déconnexion ; les paramètres OAuth restaient visibles en cas d’erreur. | Génération de session vérifiée avant publication de résultats et nettoyage immédiat des paramètres OAuth, y compris sur un callback rejeté. |

Les limites de sauvegardes techniques ne remplacent ni le quota DATA d’un Go par
projet, ni les versions nommées, ni les copies d’infrastructure hors machine.
Ces trois mécanismes ont des finalités et des règles de conservation distinctes.

## Parcours utilisateur

| Étape | Comportement préparé |
| --- | --- |
| Découvrir le produit | Liens visibles du site vers l’app, la connexion, la demande d’accès et un exemple interactif. La demande d’accès n’aboutit plus par défaut à une page de releases GitHub. |
| Obtenir un compte | Contact d’alpha explicite, activation manuelle et informations de pré-production. Aucune inscription publique ni envoi automatique de courriel n’est ajouté. |
| Se connecter | Action visible dès l’accueil web ; compte et adresse affichés après connexion, y compris sur mobile. Les jetons restent en mémoire ; un rechargement peut demander de reconnecter l’app. |
| Créer un papier | Le formulaire utilise l’identité et les espaces réellement disponibles au moment où il s’ouvre ; les espaces en lecture seule ne sont pas proposés comme destination d’écriture. |
| Retrouver le travail | Papiers propres et partagés accessibles au catalogue ; un filtre sans résultat propose d’effacer les filtres plutôt que de prétendre qu’aucun papier n’existe. |
| Inviter un collègue | Adresse e-mail exigée par défaut ; lien non adressé uniquement sur choix explicite. Le propriétaire voit qu’aucun courriel n’est envoyé et qu’il doit transmettre le lien lui-même. |
| Comprendre le partage | L’interface annonce clairement une invitation à l’espace : accès aux papiers et fichiers présents et futurs de cet espace selon le rôle. Ce n’est pas un partage limité à un seul papier. |
| Accepter une invitation | Route neutre `/invite`, secret dans le fragment, compte utilisé visible, erreur de connexion affichée et bouton « Not now » réellement fonctionnel. Retour au catalogue si plusieurs papiers sont disponibles. |
| Cloner depuis GitHub | Parcours disponible dans l’app de bureau, avec dossier local choisi ; cette limite est expliquée dans le navigateur. |
| Éditer et commenter | Correction du décalage d’origine des nouvelles bulles et restauration du caret lors de l’entrée au clavier, sans réintroduire le cadre gris du manuscrit. |

## Exemple sans compte

La route `/demo` utilise le véritable éditeur et l’article fictif complet, avec
ses références en cache et ses figures précalculées. On peut modifier le texte,
insérer une citation, essayer la relecture et exporter une copie.

L’isolation est installée **avant les imports de l’application** :

- stockage local et de session remplacés par des objets ne vivant qu’en mémoire ;
- aucun accès initial au brouillon, au profil ou à la transaction de connexion du visiteur ;
- IndexedDB désactivé pour que les images et journaux utilisent également la mémoire ;
- fournisseur de collaboration désactivé, même si l’adresse contient un callback ou une invitation ;
- boîte de collaboration non montée et commande correspondante désactivée ;
- CSP de la démo : connexions à la même origine uniquement, aucun formulaire ni frame ;
- calculs exécutables indisponibles dans le navigateur ; aucun compte collectif ni droit d’exécution serveur ;
- remise à zéro et sortie par navigation complète ; les modifications disparaissent au rechargement.

Le test navigateur conserve un faux brouillon privé, un faux profil et une
transaction de connexion témoin, ouvre la démo, y écrit et insère une citation,
la remet à zéro et revient au brouillon. Les trois témoins sont inchangés,
IndexedDB reste indisponible dans la démo et aucune API de collaboration n’a été
contactée. Les politiques de réseau et de formulaires sont aussi testées par
Chromium derrière Caddy, sans désactiver la sécurité du navigateur.

Publier l’app contenant `/demo` **avant** le site qui annonce ce lien. Une simple
réponse HTTP 200 de l’ancien serveur sur cette route ne prouve pas que la démo
est installée : l’ancienne app utilise une route de repli.
Le site n’annonce donc pas la démo par défaut. Après cette vérification réelle,
activer `DRAFTMATTER_WEBSITE_DEMO_READY=true` pour les workflows du site puis le
republier ; toute autre valeur conserve les demandes d’accès et la connexion
sans promettre un exemple anonyme déjà disponible.

Avant le push, le contrôle de publication est revérifié par 15 tests du
composant du site (activation explicite et valeurs refusées), 18 tests navigateur
du site et deux tests de l’artefact compilé, sur ordinateur et mobile. Les
contrôles TypeScript, la compilation du site et la syntaxe des deux workflows
réussissent aussi. Ces contrôles ne publient pas de nouvelle application sur le
VPS et ne changent aucune variable du dépôt.

## Performances et dépendances

La découverte des projets natifs calcule désormais les empreintes par blocs de
64 Kio et ne charge plus intégralement un énorme JSON juste pour chercher une
bibliographie. Les candidats dépassant la limite de lecture déjà prise en
charge de 10 Mio sont ignorés. Les tests vérifient la conservation des identités
d’empreinte et le traitement des fichiers volumineux.

Le test de frappe complet utilise un manuscrit synthétique de 70 144 octets et
une bibliothèque de 2 552 références (1,31 Mo). Un passage instrumenté a mesuré
un p95 de 344 ms entre une touche et deux images d’animation, sous le budget de
régression conservateur de 500 ms. Citations, bibliographie, annuler/rétablir et
rechargement conservent leur état. Ce chiffre de fixture lourde, avec trace, ne
constitue ni une mesure de latence réseau ni un test de charge du VPS.

Les outils de compilation Vite, son plugin React et TypeScript sont désormais
des dépendances de développement, exclues par `npm prune --omit=dev` de l’image
serveur. L’audit npm des dépendances livrées en production renvoie **zéro
vulnérabilité connue** à la date du contrôle ; ce contrôle devient une étape CI.

L’audit de l’arbre complet signale encore `picomatch 4.0.7`
([GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)), à travers
les outils de compilation/test. L’avis ne publie pas encore de version corrigée
au moment du contrôle. La dépendance n’est pas utilisée par le serveur en
production. L’alerte n’a pas été masquée, le contrôle strict de publication de
bureau reste en place et aucune rétrogradation vers un ancien Vite n’est faite
pour obtenir artificiellement un audit vert. Recontrôler avant une distribution
publique du client.

## Vérifications et limites de preuve

### Complément du 18 novembre : destination des sauvegardes

La destination retenue est le deuxième Mac de l’exploitant, sans abonnement
supplémentaire. Les scripts et le [guide d’installation](offhost-mac-backups.md)
préparent une récupération SSH avec compte dédié en lecture seule, validation
SHA-256 et AES-256-GCM, sept jours distincts de copies locales et expiration
absolue à 29 jours. FileVault et les exclusions Time Machine sont contrôlés
avant la préparation du lancement automatique. Les chemins des archives et des
clés doivent rester hors des dossiers synchronisés avec un cloud.

Le lancement privilégié sur le VPS nécessite une copie de release et un runtime
appartenant à root, avec tous leurs parents protégés. Aucun code modifiable par
le compte de déploiement ne peut servir d’entrée à cette tâche administrateur.
Le Mac ne reçoit ni clé SSH d’administration ni droit d’effacement sur le VPS.
Le VPS garde deux archives après validation d’une nouvelle copie complète.
La place temporaire nécessaire demeure un contrôle d’exploitation : ni le quota
de données ni la rotation ne réservent cette capacité sur le disque.

Le complément est validé par **82 tests de sauvegarde** : 15 pour le chiffrement,
le lanceur et la rotation serveur, 57 pour la copie et le préparateur Mac, et
10 pour l’exporteur en lecture seule. Les tests traversent réellement le
protocole Python vers Node et refusent une archive corrompue ou une mauvaise
clé, même avec un SHA-256 de transfert correct. Ils vérifient aussi la purge
locale sans clé ni réseau lorsqu’une protection du Mac bloque la copie.
Les **135 tests de déploiement** repassent ; la syntaxe des scripts et le
workflow GitHub sont contrôlés. Les journaux locaux correspondants sont
`/private/tmp/draftmatter-final-offhost-backup-tests.log`,
`/private/tmp/draftmatter-final-offhost-server-backup-tests.log` et
`/private/tmp/draftmatter-final-offhost-deployment-tests.log`.

À la demande de l’exploitant, **seuls les scripts et le guide sont préparés** :
ni installation sur le deuxième Mac, ni calendrier activé, ni sauvegarde réelle
du VPS copiée ou restaurée. La disponibilité du Mac, la place des deux machines,
la première copie et l’exercice de restauration restent à vérifier avant les
invitations. Une notification locale ne détecte pas la panne du Mac lui-même.

### Campagne de vérification de l’application

Résultats obtenus sur cette préparation :

- **1 661 tests automatisés réussis**, 11 ignorés dans la suite générale ;
- **99 tests navigateur de l’app réussis**, puis cinq contrôles supplémentaires
  de démo/hauteur de fenêtre/défilement après le dernier ajustement de sa bannière ;
- **18 tests navigateur du site réussis**, plus contrôle du site compilé sous
  ses nouveaux en-têtes CSP sur ordinateur et mobile, sans erreur JavaScript,
  diagnostic CSP ni requête externe ;
- **135 tests de déploiement et 15 tests de sauvegarde serveur réussis**, avec
  le complément Mac détaillé ci-dessus ;
- **162 tests du serveur réussis** dans la campagne avec PostgreSQL réel, un
  test S3 optionnel ignoré ; la pile complète teste ensuite réellement le
  stockage S3, les transferts et les restaurations ;
- **47 tests Git natifs, deux tests d’identité native et deux tests de découverte
  de fichiers réussis**, avec les contrôles CSP du client ;
- **11 tests Python de publication/SFTP réussis**, dans un environnement
  temporaire avec les dépendances requises ; aucun transfert de production ;
- contrôles TypeScript de l’app, du site et du serveur, inventaire des licences
  et identité de version réussis ; aucune version de dépendance n’a changé lors
  du reclassement des outils de compilation ;
- compilation de l’app, du serveur, du CLI et des deux exécutables Rust macOS
  ARM64 réussie. Le paquet `.app` déjà installé est resté intact : le sidecar
  MCP autonome et un nouveau paquet signé ne sont pas reconstruits dans cette
  campagne, Bun étant absent. Aucun runtime de calcul n’a été lancé.

La répétition complète de la pile a réussi : connexion d’un compte neuf,
déconnexion réelle et disparition du SSO, PKCE et rejeu de renouvellement,
permissions invité/tiers, synchronisation temps réel, reprise de transferts et
empreintes, quota d’un Go, sauvegarde applicative, redémarrage, puis sauvegarde
AES-256-GCM des deux bases et du volume de fichiers et restauration dans des
volumes neufs. Les données restaurées et les droits sont revérifiés. Les deux
piles sont arrêtées à la fin.

Cette répétition utilise des images Linux **ARM64** locales exécutant Node
**24.22.3**. Les outils hôtes ont utilisé Node 24.10.0. La publication doit encore
reconstruire et qualifier le commit retenu sur Linux **AMD64**, cible du VPS,
par le workflow de release existant. Il ne faut pas utiliser les images ARM64
locales à la place des images publiées du serveur.

Les preuves détaillées sont conservées localement, notamment :

- `/private/tmp/draftmatter-alpha-final-full-unit-tests.log` ;
- `/private/tmp/draftmatter-alpha-final-full-browser-tests.log` ;
- `/private/tmp/draftmatter-alpha-final-deployment-tests.log` ;
- `/private/tmp/draftmatter-security-rehearsal-20261117-r2/end-to-end-rehearsal-report.json` ;
- `/private/tmp/draftmatter-security-rehearsal-20261117-r2/tested-images.json` ;
- `/private/tmp/draftmatter-csp-security-audit/` ;
- `/private/tmp/draftmatter-native-security-build-20261117/build-context.json`.

Ces chemins temporaires ne sont pas des archives d’exploitation à long terme.
Les mots de passe, jetons, clés et environnements privés des fixtures ne sont
pas recopiés dans ce rapport ni dans le dépôt.

Contrôles en ligne du 17 novembre, avant toute mise à jour :

- `draftmatter.eu` redirige vers `www.draftmatter.eu`, les deux sont joignables en HTTPS ;
- l’app et la disponibilité du service répondent 200 ; l’API de session sans jeton répond 401 ;
- les routes publiques d’administration, du realm maître et des métriques répondent 404 ;
- la connexion mène à `auth.draftmatter.eu`, sans lien d’inscription publique ;
- aucune erreur JavaScript dans ce parcours public avec un navigateur neuf ;
- l’app actuelle n’a pas encore les nouveaux en-têtes CSP/Permissions-Policy ; le site vitrine n’a pas encore la nouvelle CSP ni HSTS.

Les essais des ports internes n’ont obtenu aucune réponse aux protocoles testés.
L’établissement TCP seul est ambigu dans l’environnement d’audit ; il n’est pas
utilisé comme preuve qu’un port est exposé. La connexion SSH automatique n’a pas
abouti sans déverrouiller la clé de l’exploitant. Le pare-feu hôte/fournisseur et
les tâches réellement installées sur le VPS restent donc à confirmer depuis sa
session SSH, sans transmettre de mot de passe ou de clé privée.

### Actions d’exploitation avant les testeurs

1. Publier et installer une nouvelle release immuable ; ne pas écraser le tag ni
   les images de `0.1.0-alpha.1`. Refaire les contrôles publics après l’installation.
2. Installer les sauvegardes sur le deuxième Mac selon le
   [guide retenu](offhost-mac-backups.md), conserver la clé séparément,
   programmer les copies chiffrées et la rétention de 29 jours, puis restaurer
   une copie de ce VPS sur un environnement isolé.
3. Vérifier les alertes de disque, de disponibilité, d’échec/ancienneté des
   sauvegardes et du cycle de maintenance. Prévoir le renouvellement des
   certificats internes avant leur expiration.
4. Vérifier les règles effectives du pare-feu et les ports publiés. Conserver
   les accès d’administration d’identité sur le chemin privé prévu.
5. Faire un dernier essai à deux comptes invités avec un espace fictif : ouvrir,
   commenter, limiter les droits, transférer un fichier, exporter, puis révoquer.

Les corrections de code n’effectuent aucune de ces mutations de production.
La création et la suppression des comptes opérateur réalisées précédemment par
l’exploitant ne sont pas rejouées par les tests.

Références techniques utilisées pour la revue :
[OAuth 2.0 Security BCP, RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html),
[Keycloak : protocoles OIDC](https://www.keycloak.org/securing-apps/oidc-layers),
[OWASP : Content Security Policy](https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html).
