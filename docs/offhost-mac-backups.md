# Sauvegardes chiffrées sur le deuxième Mac

Destination retenue le **18 novembre 2026** : le deuxième Mac de Rémi, sans
abonnement de stockage supplémentaire. Ce document prépare l’installation ;
aucune tâche n’est encore activée sur le VPS ni sur ce Mac par le dépôt.

## Fonctionnement retenu

- Le VPS produit une sauvegarde cohérente chiffrée chaque nuit, à 03 h 10,
  heure de Paris. Elle contient les deux bases et les fichiers partagés.
  La création suspend momentanément les services d’écriture et les reprend
  ensuite ; il faut prévoir cette courte fenêtre de maintenance.
- Le Mac **récupère** les archives : aucun accès entrant au réseau domestique,
  aucune clé permettant de se connecter au Mac ne réside sur le VPS.
- Une clé SSH distincte permet uniquement de lister et lire les archives
  chiffrées. Ce compte n’a ni shell utilisable, ni accès Docker, ni accès à la
  clé de déchiffrement ou aux autres fichiers du serveur.
- Le Mac vérifie les octets, SHA-256, l’authentification AES-256-GCM complète et
  la date du manifeste chiffré avant de publier une copie locale. Un simple
  téléchargement ou une connexion SSH réussie ne vaut pas sauvegarde vérifiée.
- Après une récupération réussie, le Mac conserve au plus **sept jours
  distincts** de sauvegarde, avec une copie établie par jour UTC. Si une série
  échoue après quelques copies vérifiées, les anciennes sont conservées : il
  peut temporairement y en avoir davantage jusqu’à une rotation réussie.
  Le plafond absolu d’âge reste **29 jours**, y compris pour la dernière copie.
  Ce n’est pas une promesse de 29 copies complètes.
- Le VPS conserve les **deux dernières archives complètes**. La rotation du
  nombre intervient uniquement après fermeture, vérification AES-GCM et
  publication de la nouvelle archive ; un échec de création garde les anciennes.
  Un nettoyage horaire indépendant applique aussi la limite d’âge de 29 jours.
- Une suppression côté serveur ne supprime pas la copie du Mac. La rotation est
  locale, après succès ; la suppression pour âge reste indépendante d’une panne
  de connexion au VPS.
- Le contrôle du Mac se lance à la connexion utilisateur, puis à 00 h 20,
  04 h 20, 08 h 20, 12 h 20, 16 h 20 et 20 h 20, heure locale du Mac.
  Une sauvegarde âgée de plus de 36 heures est signalée comme échec.

Les copies peuvent être volumineuses : prévoir la place pour sept archives,
une copie temporaire et une marge en cas de récupération partiellement réussie.
Le programme contrôle l’espace libre et refuse de saturer le disque. Il ne
supprime pas une copie encore utile simplement pour faire entrer un
téléchargement incomplet.

## Conditions à vérifier sur le deuxième Mac

1. macOS et Node.js **24.22.3 ou un correctif plus récent de la branche 24**.
   Utiliser un chemin Node stable, pas un exécutable dans un répertoire
   temporaire. La copie ne nécessite pas Docker.
2. FileVault activé, une session utilisateur ouverte (elle peut être verrouillée),
   connexion Internet et alimentation régulières. Un LaunchAgent ne travaille
   pas avant la connexion utilisateur. Le calendrier rattrape une échéance
   passée pendant la veille au réveil ; après extinction, `RunAtLoad` intervient
   à la prochaine connexion. Cela ne rend pas une machine éteinte disponible.
   Confirmer aussi que l’emplacement physique de ce Mac respecte la localisation
   des données annoncée aux testeurs.
3. Dossier privé, par exemple `~/DraftMatter Backups`, hors iCloud Drive,
   Desktop/Bureau, Documents ou répertoire de synchronisation d’un autre cloud.
4. Exclusion confirmée de Time Machine pour les archives et leurs secrets. Sans
   cela, effacer les copies locales ne supprimerait pas les anciennes copies
   conservées dans les sauvegardes de macOS. Le préparateur effectue et vérifie
   ces exclusions avant de créer l’agent. À chaque lancement planifié, le
   contrôle vérifie à nouveau FileVault, la présence des quatre emplacements
   protégés et leurs exclusions. Si le dossier d’archives a été supprimé ou a
   perdu son exclusion, aucune récupération ne démarre avant correction.
5. La clé AES existante et les paramètres de restauration doivent avoir une copie
   protégée hors du VPS. **Ne pas générer une nouvelle `backup.key`** pour préparer
   le Mac et ne jamais coller sa valeur dans le chat ou dans le dépôt.

Pour respecter une expiration physique à 29 jours, ce Mac doit pouvoir effectuer
le nettoyage quotidien. Une longue extinction ou un disque débranché empêche
cette suppression ; ne pas considérer le dispositif comme opérationnel dans ce
cas. Une notification locale n’alerte pas sur une machine elle-même hors service :
l’exploitant doit vérifier régulièrement son état.

## Étape 1 — inventaire, sur le deuxième Mac

Ces commandes sont en lecture seule :

```sh
sw_vers
uname -m
node --version
df -h "$HOME"
fdesetup status
```

Si `node` est absent ou trop ancien, installer le Node 24 LTS correspondant avant
de poursuivre. Le Mac principal qui développe DraftMatter et le Mac qui reçoit
les sauvegardes ne sont pas nécessairement configurés de la même manière.

## Étape 2 — préparer une clé SSH dédiée sur le deuxième Mac

Ne pas recopier la clé SSH administrateur `draftmatter_pulseheberg` sur ce Mac.
Créer une clé distincte, avec une phrase secrète, et conserver cette phrase dans
le trousseau local. Exécuter le bloc interactif seul et attendre son retour :

```sh
umask 077
mkdir -p "$HOME/.ssh"
test ! -e "$HOME/.ssh/draftmatter_backup_readonly" &&
ssh-keygen -t ed25519 -a 100 -C "DraftMatter backup read only" \
  -f "$HOME/.ssh/draftmatter_backup_readonly"
```

Puis, séparément :

```sh
ssh-add --apple-use-keychain "$HOME/.ssh/draftmatter_backup_readonly"
cat "$HOME/.ssh/draftmatter_backup_readonly.pub"
```

Seule la ligne **publique** `.pub` est transmise à l’exploitant pour le VPS.
L’absence de phrase dans les journaux et l’ouverture correcte du trousseau sont
vérifiées avant d’activer la tâche sans interaction.

## Étape 3 — installer les sources privilégiées sur le VPS

Exécuter uniquement dans la session SSH **`deploy@draftmatter`**, après
publication d’une release comprenant ces outils. L’ancien bundle
`0.1.0-alpha.1` ne contient pas les nouveaux lanceurs : ne pas y ajouter des
fichiers non vérifiés puis prétendre qu’ils sont couverts par ses checksums.

Le lancement nocturne est administrateur. Il ne doit donc **jamais** exécuter du
code modifiable par `deploy`, même si cet utilisateur utilise habituellement
`sudo` avec un mot de passe. Préparer une copie de release dédiée sous
`/usr/local/lib/draftmatter/releases/VERSION`, avec tous ses parents et fichiers
appartenant à `root` et non modifiables par groupe/autres. Copier l’archive,
son manifeste et `SHA256SUMS` vérifiés, puis extraire cette archive dans cette
nouvelle arborescence root ; ne pas recopier un arbre extrait modifiable par un
autre utilisateur. Le lanceur refuse une provenance locale non protégée.

Le runtime `/etc/draftmatter`, ses parents, les fichiers de configuration et le
staging `/var/backups/draftmatter` doivent également appartenir à root et rester
privés, sans liens. Modifier **les propriétaires et droits**, pas les valeurs des
secrets. Après ce changement, les commandes de configuration de l’opérateur se
lancent avec `sudo sh ...`, et Compose reste lancé avec `sudo docker ...`.
Garder les modes de lecture produits par l’opérateur : répertoire runtime 0700,
`runtime.env`, `release.env` et `backup.key` 0600 ; les configurations publiques
montées dans les conteneurs restent lisibles par leurs utilisateurs. Ne pas
appliquer un `chmod -R 600` qui empêcherait les services de lire leurs montages.

Créer aussi les répertoires root:root, mode 0700,
`/var/lib/draftmatter-backup` et `/var/lib/draftmatter-backup/docker-config`.
Le second doit rester **vide** : le lanceur impose cette configuration Docker
distincte pour ne jamais découvrir de plugin ou d’identifiant depuis le profil
de l’appelant. Ce n’est pas un emplacement pour stocker des secrets Docker.

```sh
sudo install -d -o root -g root -m 700 \
  /var/lib/draftmatter-backup /var/lib/draftmatter-backup/docker-config
```

Installer depuis cette copie protégée :

- `scripts/server-backup.sh` vers `/usr/local/lib/draftmatter/server-backup.sh`,
  root:root, mode 0755 ;
- `deploy/single-host/backup/export.py` vers
  `/usr/local/lib/draftmatter/backup-export`, root:root, mode 0755 ;
- les quatre fichiers `draftmatter-backup*.service` et `.timer` vers
  `/etc/systemd/system/`, root:root, mode 0644.

Créer `/etc/draftmatter/backup-schedule.env`, root:root, mode 0600, avec le seul
chemin de la copie protégée de la release :

```text
DM_BACKUP_RELEASE_DIRECTORY=/usr/local/lib/draftmatter/releases/VERSION
```

Le lanceur utilise Node depuis l’image opérateur déjà installée et identifiée par
son digest. Il monte le CLI Docker et son plugin Compose Linux existants en
lecture seule ; aucune installation Node sur le VPS, reconstruction d’image ou
connexion au registre ne fait partie de la tâche nocturne. Le socket Docker et
les paramètres privés sont accessibles uniquement au lancement de création.
L’expiration à 29 jours utilise un worker sans socket ni clé de déchiffrement.

Si le staging contient déjà des archives récentes, configurer d’abord l’accès
des étapes 4 à 6 et en récupérer une copie vérifiée : le lancement ci-dessous
applique aussi la rotation de deux copies. Pour une première installation sans
archive existante, il crée la première copie nécessaire à cet amorçage.

Faire une première sauvegarde manuelle avec la version réellement installée :

```sh
sudo /bin/sh /usr/local/lib/draftmatter/server-backup.sh \
  /usr/local/lib/draftmatter/releases/VERSION \
  /etc/draftmatter /var/backups/draftmatter create
```

Vérifier `status: "created"` et la reprise en bonne santé des services avant
d’autoriser le calendrier. Ce premier lancement Linux doit être constaté ; les
tests du lanceur sur macOS ne l’effectuent pas sur le VPS.

## Étape 4 — limiter l’accès SSH de récupération, sur le VPS

Créer le compte `draftmatter-backup` sans mot de passe utilisable et **sans**
appartenance au groupe sudo ou Docker. Sa clé publique est placée dans
`/etc/ssh/authorized_keys/draftmatter-backup`, fichier appartenant à root et
non modifiable par le compte. Le répertoire parent appartient aussi à root.
Le compte doit avoir un shell système valide, par exemple `/bin/sh`, pour que
SSH exécute la commande forcée ; `/usr/sbin/nologin` empêcherait aussi l’export.
Son répertoire personnel doit être non modifiable par ce compte. L’interdiction
du shell interactif est assurée par la commande forcée ci-dessous.

Les gabarits de la release sont :

- `deploy/single-host/backup/sshd-backup.conf.example`, à installer dans
  `/etc/ssh/sshd_config.d/30-draftmatter-backup.conf` ;
- `deploy/single-host/backup/sudoers-backup.example`, à installer en mode 0440
  dans `/etc/sudoers.d/draftmatter-backup-export`.

Le seul privilège sudo du compte est d’exécuter le programme d’export figé,
**sans argument**. Ce programme n’accepte que les messages JSON `list` et `get`
sur son entrée standard et un nom d’archive strictement validé. Ni shell distant,
SFTP général, transfert de port, terminal, lecture de `backup.key`, restauration
ou suppression d’archive n’est exposé à la clé du Mac.

Contrôler les restrictions globales `AllowUsers`/`AllowGroups` existantes, valider
`visudo -cf` sur le gabarit installé et `sshd -t` avant de recharger SSH. Garder la
session administrateur ouverte jusqu’à la première récupération réussie depuis
le Mac. Ne pas modifier la configuration SSH du Mac principal pour cette étape.

## Étape 5 — vérifier le serveur et préparer la configuration sur le Mac

Obtenir l’empreinte de la clé d’hôte depuis la session VPS déjà authentifiée :

```sh
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

Sur le deuxième Mac, collecter la clé d’hôte dans un fichier provisoire avec
`ssh-keyscan`, afficher son empreinte avec `ssh-keygen -lf`, et comparer
indépendamment les deux empreintes **avant** de retenir ce fichier comme
`knownHostsFile`. Une collecte réseau seule n’établit pas la confiance.
Le programme ne désactive jamais `StrictHostKeyChecking`.

Transférer la clé AES **existante** par un moyen protégé validé par l’exploitant,
par exemple un support chiffré ou le gestionnaire de secrets. Le fichier obtenu
doit contenir exactement 32 octets bruts et avoir le mode 0600. Une représentation
base64 copiée telle quelle n’est pas ce fichier. Conserver aussi une copie de
secours protégée indépendamment du seul disque du Mac.

Créer un JSON privé, mode 0600, avec les chemins absolus réels du deuxième Mac :

```json
{
  "version": 1,
  "host": "ADRESSE_DU_VPS",
  "user": "draftmatter-backup",
  "identityFile": "/Users/UTILISATEUR/.ssh/draftmatter_backup_readonly",
  "knownHostsFile": "/Users/UTILISATEUR/.config/draftmatter-backup/known_hosts",
  "keyFile": "/Users/UTILISATEUR/.config/draftmatter-backup/backup.key",
  "directory": "/Users/UTILISATEUR/DraftMatter Backups",
  "maxCopies": 7,
  "retentionDays": 29
}
```

Les majuscules sont des valeurs à remplacer ; ce JSON n’est pas directement
exécutable. Aucun mot de passe ou contenu de clé ne figure dans la configuration.
Conserver aussi les clés, le JSON et les scripts installés hors des dossiers
synchronisés : le contrôle porte sur les chemins réels, même à travers un lien
de répertoire.

Depuis les sources vérifiées de la nouvelle release sur ce Mac :

```sh
node deploy/offhost-mac/install.mjs \
  --config /CHEMIN/ABSOLU/config.json --node "$(command -v node)"
```

Ce préparateur vérifie Node, FileVault et les exclusions Time Machine, copie
uniquement les scripts publics et la configuration privée, puis prépare le
LaunchAgent. Il **ne l’active pas** et n’écrase pas une installation existante ni
les clés. Il fournit le chemin du helper installé et de son JSON.

## Étape 6 — première copie vérifiée, puis activation

Sur le deuxième Mac, exécuter manuellement le helper installé :

```sh
node "$HOME/Library/Application Support/DraftMatter Backup/deploy/offhost-mac/pull.mjs" \
  --config "$HOME/Library/Application Support/DraftMatter Backup/config.json"
```

Vérifier `status: "success"`, `copiedArchives` et `newestBackupCreatedAt`.
L’authentification complète n’écrit pas les données déchiffrées sur disque.
Un essai avec une copie endommagée et une mauvaise clé est couvert par les tests,
mais un **exercice de restauration réel** reste nécessaire pour établir la
récupération du service, pas seulement de ses octets.

Après ce résultat et la vérification de l’archive conservée sur le Mac :

```sh
launchctl bootstrap "gui/$(id -u)" \
  "$HOME/Library/LaunchAgents/fr.draftmatter.backup.plist"
```

Puis, dans le terminal **du VPS** :

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now draftmatter-backup.timer draftmatter-backup-prune.timer
sudo systemctl list-timers 'draftmatter-backup*'
```

## Surveillance, place et restauration

Sur le Mac, le dernier lancement planifié est consigné dans `last-run.json` et
`last-error.log`, sous `~/Library/Application Support/DraftMatter Backup/`, y
compris quand une protection empêche la récupération. Le détail du dernier
appel au helper est dans `ARCHIVE_DIRECTORY/.backup-status.json` ; il peut être
plus ancien si le contrôle préalable a bloqué un lancement.
Une défaillance produit une notification locale sans contenu de manuscrit ni
secret. Vérifier que les notifications sont effectivement visibles par
l’exploitant ; elles ne remplacent pas une surveillance indépendante du Mac.
Le nettoyage local des archives expirées précède ces contrôles et ne requiert
ni clé ni connexion réseau. Il n’invente pas de nouveau dossier ou marqueur si
le dossier préparé a disparu. Une perte d’exclusion Time Machine nécessite aussi
de vérifier les copies éventuellement déjà conservées par macOS.

Sur le VPS, examiner `systemctl status draftmatter-backup.service` et
`journalctl -u draftmatter-backup.service`. Les tâches ne déclarent pas une panne
de stockage corrigée simplement parce que le Mac est joignable.

Le staging du VPS garde deux archives après une création réussie ; il n’y a
**aucune suppression distante pilotée par le Mac**. Activer cette rotation
seulement après la première copie Mac authentifiée. Ne pas effacer manuellement
la dernière archive pour faire réussir une création.

Pendant une création, le VPS doit pouvoir contenir **les données actives, les
deux archives précédentes et la nouvelle archive temporaire**, plus les bases,
images et la marge système. Une rotation de deux copies ne garantit donc pas
qu’un disque de 80 Go puisse sauvegarder 25 Go de données actives. Mesurer la
taille réelle dès la première sauvegarde et augmenter le disque ou revoir le
stockage avant de s’approcher de cette situation ; le quota applicatif n’est pas
une réservation d’espace pour ces archives. Le contrôle de capacité refuse une
création qui ne tient pas et reprend les services ; cette erreur doit être
traitée rapidement. Il ne supprime aucune ancienne archive avant validation de
la nouvelle et ne touche jamais aux données actives pour faire de la place.

Le fichier de données chiffré n’inclut pas l’environnement, les secrets de
déploiement et les clés TLS du VPS. Conserver ces paramètres par un **canal de
récupération chiffré séparé**, avec la release et les images correspondantes.
Sans cette préparation et la clé AES indépendante, un téléchargement réussi ne
suffit pas à reconstruire le service après perte du VPS.

Avant les premiers testeurs, restaurer une archive réellement récupérée sur le
Mac dans une pile jetable, vérifier comptes, droits, manuscrit et fichiers,
puis consigner le résultat sans secrets. Les détails de la restauration et de
la réconciliation des suppressions sont dans
[single-host-backups.md](single-host-backups.md) et
[alpha-operations.md](alpha-operations.md).

Références : [Apple — tâches planifiées](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/ScheduledJobs.html),
[Apple — trousseau OpenSSH](https://developer.apple.com/library/archive/technotes/tn2449/_index.html),
[OpenSSH — ForceCommand](https://man.openbsd.org/sshd_config#ForceCommand),
[systemd.timer](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html).
