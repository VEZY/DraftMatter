# Alpha fermée gratuite : publication et OVH

Les trois documents sont partagés par le site et l’application, en anglais :

- Application : `/legal/mentions-legales`, `/legal/confidentialite`,
  `/legal/conditions-utilisation`.
- Site : `#legal/mentions-legales`, `#legal/confidentialite`,
  `#legal/conditions-utilisation`, sous son chemin de base. Ce format fonctionne
  aussi sous `/DraftMatter/` sur GitHub Pages, sans réécriture serveur.

Ils identifient Rémi Vezy et `vezy.remi@gmail.com` pour l’alpha. Les engagements
retenus sont la gratuité, les invitations, un quota de données de 1 Go par projet,
30 jours pour retirer les données actives après une demande recevable ou la
fermeture, jusqu’à 30 jours supplémentaires pour l’expiration des sauvegardes,
et un préavis de 30 jours avant une fermeture planifiée. Les contenus communs et
droits des autres auteurs sont examinés séparément. Ces textes ne constituent
pas une validation du nom comme marque ni du statut professionnel de l’éditeur.

Les conditions contiennent une section **Testing and data loss** : risque de perte,
corruption ou indisponibilité définitive en pré-production, responsabilité de
l’utilisateur de conserver des sauvegardes indépendantes et de tester leur
restauration. La synchronisation, l’historique et les sauvegardes du service ne
remplacent pas ces copies. Ce rappel figure également avant la connexion et dans
la politique de confidentialité. Les obligations et responsabilités impératives
de l’éditeur, notamment en protection des données, restent applicables.

La formulation prévue est un hébergement en France par une société française.
Tant que le prestataire et la localisation ne sont pas confirmés, les textes
emploient **planned**, et ne prétendent pas qu’un serveur a déjà été déployé.
Une fois ces faits vérifiés, le champ public de localisation peut contenir
`Hosted in France by a French company.` L’identité et l’adresse de l’hébergeur
restent des informations légales nécessaires ; supprimer l’architecture et les
caractéristiques techniques ne les supprime pas. Pour un site restant sur
GitHub Pages, renseigner son hébergeur réel, distinct de l’alpha envisagée.

## Paramètres publics de publication

Pour un build local, renseigner les variables `VITE_DM_LEGAL_*` de `.env.example`
dans un fichier local ignoré par Git. Ce sont des informations **publiques**,
compilées dans les bundles : aucun mot de passe, jeton ou identifiant secret.

| Paramètre | Valeur à publier |
| --- | --- |
| `VITE_DM_LEGAL_PUBLISHER_NAME` | Identité de l’éditeur et directeur de publication |
| `VITE_DM_LEGAL_CONTACT_EMAIL` | Contact effectivement relevé pour assistance et droits RGPD |
| `VITE_DM_LEGAL_HOSTING_DETAILS` | Identité, adresse et contact légal de l’hébergeur ; aucun détail technique de serveur |
| `VITE_DM_LEGAL_DATA_LOCATION` | Courte phrase publique en anglais sur le pays d’hébergement effectif, sans architecture technique |
| `VITE_DM_LEGAL_ADDITIONAL_PROCESSORS` | Messagerie, inscription, notifications et autres prestataires activés |

Pour l’image de production, les mêmes paramètres sont fournis **sans** le préfixe
`VITE_` dans le fichier privé `production.env`. Compose ne transmet au build que
ces champs publics, jamais le fichier contenant les secrets. `deploy:check` et
le build de l’image refusent des coordonnées d’hébergement manquantes ou encore
marquées comme exemples. Une page locale non configurée indique que l’alpha
hébergée est encore en préparation.

Le site GitHub Pages utilise les variables Actions
`DRAFTMATTER_LEGAL_PUBLISHER_NAME`, `DRAFTMATTER_LEGAL_CONTACT_EMAIL`,
`DRAFTMATTER_WEBSITE_HOSTING_DETAILS`, `DRAFTMATTER_WEBSITE_DATA_LOCATION` et
`DRAFTMATTER_LEGAL_ADDITIONAL_PROCESSORS`. Décrire **GitHub Pages** si le site y
reste publié, pas OVH. La fiche de l’instance de collaboration doit quant à elle
décrire les prestataires de cette instance. Une forme d’inscription externe doit
également être identifiée avant d’activer `DRAFTMATTER_ALPHA_SIGNUP_URL`.

L’exception d’identification publique prévue pour un éditeur non professionnel
par l’article 1-1 II de la LCEN dépend de la situation réelle de l’éditeur : elle
ne découle pas du seul mot « alpha » ou de la gratuité. Communiquer à l’hébergeur
les éléments d’identité requis. Si le service relève d’une édition
professionnelle, compléter les mentions avec les informations requises par le
I de cet article avant sa publication ; ne pas inventer d’adresse ou de numéro.

L’adresse Gmail est une messagerie de contact, pas l’hébergeur des manuscrits.
Un nouveau compte Gmail ne change pas ce fournisseur. Pour séparer les échanges
personnels et ceux du projet, une boîte dédiée sur le futur domaine pourra le
remplacer ; mettre alors à jour les deux builds et les prestataires publiés.

## Préparation du VPS et domaines

Les domaines retenus sont `draftmatter.eu` et `draftmatter.fr`, avec `.eu` comme
adresse principale. Les noms proposés pour le service sont `app.draftmatter.eu`,
`sync.draftmatter.eu` et `auth.draftmatter.eu`. La messagerie de production est
préconfigurée dans le nouvel initialiseur sur `contact@draftmatter.eu` ; vérifier
sa réception effective avant d'inviter les testeurs. Les builds non configurés
conservent leur ancienne adresse de contact : toujours transmettre les paramètres
publics effectivement retenus pour la publication.

Le [déploiement sur un seul VPS](../deploy/single-host/README.md) provisionne
PostgreSQL, Keycloak en mode production et le stockage S3 privé sur la même
machine, avec contrôle des certificats TLS. Il inclut une répétition locale
isolée, des comptes fictifs uniquement dans cette répétition, un plafond DATA
agrégé de 25 Go en plus du quota de 1 Go par projet, et une procédure chiffrée de
sauvegarde/restauration. La pile de développement reste distincte.

1. Choisir un VPS Linux d'environ 4 vCPU, 8 Go de RAM et 75 Go de disque, avec un
   abonnement mensuel à coût fixe. Les stocks et tarifs OVH sont variables :
   confirmer le panier avant paiement. Une localisation dans l'Union européenne
   est acceptée ; renseigner le lieu réellement attribué dans les mentions.
2. Relever après livraison l'IPv4, la région effective et l'utilisateur SSH.
   Garder les clés privées et les secrets hors du dépôt, des images Docker et de
   la conversation.
3. Préparer une configuration de production distincte, avec de nouveaux secrets,
   aucun compte de test et les véritables informations d'hébergement. Le contrôle
   refuse les coordonnées non confirmées et les identifiants de release locaux.
4. Vérifier la zone DNS faisant autorité, puis ajouter seulement les A de `app`,
   `sync` et `auth`. N'ajouter AAAA qu'après validation d'IPv6. Préserver les
   enregistrements de messagerie OVH et ceux du site existant.
5. Configurer les sauvegardes indépendantes hors VPS, leur rétention de 29 jours
   et les alertes avant toute première invitation. Le stockage de données et les
   sauvegardes doivent rester dans les régions déclarées aux utilisateurs.

Le [gabarit avec dépendances externes](../deploy/production/README.md) reste
utilisable pour une future base, identité ou stockage managés. Aucun serveur,
DNS ou transfert hors hôte n'est créé par cette préparation locale.

## Avant la première invitation

Appliquer le [runbook des données de l’alpha](alpha-operations.md) : cycle de
maintenance surveillé, sauvegardes techniques et externes bornées, exercice
d’export/suppression/restauration et suivi de la boîte de contact. Les opérations
de suppression de compte et certaines copies externes nécessitent l’exploitant ;
les pages ne promettent pas un bouton de suppression automatique.

Désactiver l’inscription publique et les fournisseurs de connexion ouverts dans
le fournisseur d’identité du pilote. Provisionner uniquement les comptes invités
et vérifier avec un navigateur déconnecté que l’inscription publique n’est pas
possible. Valider les droits d’un second compte, les transferts et les exports
avant de confier de vrais travaux au service.

Les critères techniques détaillés restent dans les
[instructions de production](../deploy/production/README.md).

## Sources vérifiées le 11 novembre 2026

- [Catalogue VPS OVH](https://www.ovhcloud.com/fr/vps/).
- [Identité légale OVH](https://www.ovhcloud.com/fr/terms-and-conditions/).
- [LCEN, article 1-1](https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000049568614).
- [CNIL : information des personnes](https://www.cnil.fr/fr/conformite-rgpd-information-des-personnes-et-transparence).
- [CNIL : sous-traitance](https://www.cnil.fr/fr/securite-gerer-la-sous-traitance).
- [Google : confidentialité](https://policies.google.com/privacy?hl=fr).
