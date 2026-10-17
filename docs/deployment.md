# Déploiement

L'application utilise Node 24 et PostgreSQL. Elle se construit avec `npm ci` puis `npm run build`, et démarre avec `npm start`. Les dépendances de développement sont nécessaires au build. Le processus écoute sur le `HOST` et le `PORT` fournis par l'environnement d'hébergement.

## Configuration

Configurer hors du dépôt :

- `NODE_ENV=production`.
- `ORIGIN`, l'origine HTTPS publique, définie avant le build et au démarrage.
- `DATABASE_URL`, ou `POSTGRESQL_ADDON_URI` lorsqu'un add-on Clever Cloud lié la fournit.
- Les paramètres TLS PostgreSQL requis par l'hébergeur, avec vérification du certificat lorsque la chaîne de confiance est disponible. Ne pas supposer que l'URI seule active TLS ; `pg` accepte notamment `PGSSLMODE`.
- `ADDRESS_HEADER` et `XFF_DEPTH` selon la chaîne de proxys réellement utilisée.
- `BODY_SIZE_LIMIT=2K` et `COUNTER_EPOCH`, entier positif à augmenter après une restauration faisant reculer les compteurs.
- `ADMISSION_DIFFICULTY`, entier entre `16` et `20` (`18` par défaut), règle la petite preuve de calcul anonyme exigée avant une nouvelle présence, un soutien ou une création. Qualifier son temps de calcul sur téléphone. `ADMISSION_SECRET`, secret aléatoire de 43 à 128 caractères base64url, peut stabiliser les défis signés ; sans configuration, une clé éphémère est créée au démarrage et les défis précédents expirent lors du redémarrage. Ne jamais publier ce secret. Garder une seule instance tant que la protection réseau en RAM n’est pas partagée.
- Pour l’espace privé `/gui`, `ADMIN_PASSWORD_HASH` et `ADMIN_SESSION_SECRET`, générés avec `npm run admin:password`. Si le rôle de la connexion publique est restreint, fournir une connexion distincte `ADMIN_DATABASE_URL` avec les droits administratifs décrits dans le [guide du back-office](admin.md).

L'origine est aussi utilisée lors du build : reconstruire l'application si elle change. Prévoir HTTPS et un proxy compatible avec les flux SSE. Conserver une seule instance applicative tant que le partage des limiteurs et des canaux SSE entre processus n'est pas implémenté.

`npm run test:pwa` reconstruit le serveur pour l'origine locale de recette `http://127.0.0.1:5176` avant les tests du build. Avant déploiement, reconstruire avec l'origine HTTPS cible : les formulaires utilisent cette origine pour leur contrôle CSRF.

Les valeurs d'instance, identifiants de ressources, tickets support et rapports de mise en service restent dans les paramètres privés de l'hébergeur ou dans `ops/`, dossier local ignoré par Git. Les secrets et sauvegardes ne doivent pas être versionnés. Le fichier `.env.example` contient uniquement une configuration locale d'exemple.

## Migrations et maintenance

Exécuter `npm run db:migrate` avec l'environnement de la base cible, depuis le répertoire applicatif. Le runner sérialise les migrations et vérifie les fichiers déjà appliqués. Ne pas lancer de seed de démonstration automatiquement en production.

Appliquer la migration des soutiens avant le nouveau code. Avec un rôle applicatif restreint, ajouter `SELECT, INSERT, DELETE` sur `supports`, `SELECT, INSERT, UPDATE` sur `support_counters` et `SELECT, INSERT, DELETE` sur `daily_support_claims`. Le droit de suppression sur `supports` permet la conversion d’un soutien en présence ; celui sur `daily_support_claims` permet le nettoyage des jours expirés. Conserver les restrictions existantes sur `presences`, notamment l’absence de droit de suppression pour le rôle public. Les migrations et la purge utilisent leurs droits de maintenance habituels.

Appliquer aussi `0005_admission_claims.sql` avant ce code. Le rôle public doit avoir `SELECT, INSERT` sur `admission_claims`, sans droit de modification ni suppression. La maintenance/purge utilise un rôle distinct avec `DELETE` pour retirer les défis consommés et expirés. L’unicité SQL du défi consommé empêche son réemploi concurrent ; le secret de signature ne doit pas être stocké en base ni dans le manifeste public.

Planifier `npm run db:purge -- --expired` toutes les 15 minutes et suivre son résultat. Le dépôt fournit `clevercloud/cron.json` et son wrapper pour Clever Cloud : environnement de production, instance numéro zéro, répertoire `APP_HOME`. Vérifier leur installation et leur exécution sur l'hébergement choisi. Les détails individuels de présence et de soutien sont purgés après `endsAt + 48 h`. Les marqueurs de soutien des jours de Paris passés sont également supprimés par cette tâche et lors des demandes de soutien ; ils ne contiennent aucune référence d’événement. Les agrégats restent conservés ; les sauvegardes ont leur propre rétention à configurer.

Configurer les sauvegardes, leur rétention et une restauration de contrôle auprès de l'hébergeur. Garder les procédures propres à l'instance hors du dépôt public. Les principes de cohérence, de purge et de reprise sont décrits dans l'[ADR PostgreSQL](adr/002-database.md).

## Vérifications

Avant l'ouverture, vérifier HTTPS, le catalogue, la création d'un événement de recette, la participation idempotente, le soutien sans demande de GPS, le refus d’un deuxième événement soutenu le même jour et la conversion d’un soutien en présence, SSE et son repli, puis supprimer uniquement les données de cette recette. Contrôler aussi la consommation mémoire, les limites de connexion, la purge et les journaux de chaque couche, sans enregistrer les corps de participation ni les paramètres SQL.

`REAL_EVENTS_APPROVED` conserve sa valeur désactivée tant que les décisions du [pilote](pilot-checklist.md) ne sont pas résolues. Ce paramètre n'établit aucune conformité juridique.

## Provenance du code publié

`npm run build` passe désormais par `scripts/build-release.mjs` : il prépare une identité de build à partir des sources publiques, du lockfile, des versions Node/npm et de l’origine, puis écrit `build/release-manifest.json` avec les empreintes des fichiers générés. Les fichiers privés et `.env` ne sont jamais inclus dans cet inventaire. Un build local modifié est signalé comme tel ; le workflow de publication exige une copie Git propre. `/transparence` et `/api/version` présentent ces métadonnées sans cache et sans secret.

La [procédure de provenance](code-provenance.md) distingue deux modes. Le build natif Clever Cloud conserve sa compatibilité et expose son `COMMIT_ID` lorsque fourni, mais il constitue une reconstruction distincte de l’artefact GitHub. Pour l’installation de l’artefact attesté, vérifier sa signature et son commit attendu avant extraction, contrôler les fichiers puis lancer directement `node build` depuis la racine extraite, sans nouveau build ni nouvelle installation npm. Adapter cette livraison aux capacités de l’hébergement ; ce dépôt ne modifie pas l’instance distante et ne prétend pas qu’elle utilise déjà cette chaîne.
