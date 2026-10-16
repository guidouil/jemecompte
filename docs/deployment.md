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

L'origine est aussi utilisée lors du build : reconstruire l'application si elle change. Prévoir HTTPS et un proxy compatible avec les flux SSE. Conserver une seule instance applicative tant que le partage des limiteurs et des canaux SSE entre processus n'est pas implémenté.

Les valeurs d'instance, identifiants de ressources, tickets support et rapports de mise en service restent dans les paramètres privés de l'hébergeur ou dans `ops/`, dossier local ignoré par Git. Les secrets et sauvegardes ne doivent pas être versionnés. Le fichier `.env.example` contient uniquement une configuration locale d'exemple.

## Migrations et maintenance

Exécuter `npm run db:migrate` avec l'environnement de la base cible, depuis le répertoire applicatif. Le runner sérialise les migrations et vérifie les fichiers déjà appliqués. Ne pas lancer de seed de démonstration automatiquement en production.

Planifier `npm run db:purge -- --expired` toutes les 15 minutes et suivre son résultat. Le dépôt fournit `clevercloud/cron.json` et son wrapper pour Clever Cloud : environnement de production, instance numéro zéro, répertoire `APP_HOME`. Vérifier leur installation et leur exécution sur l'hébergement choisi. Les admissions expirées sont purgées après `endsAt + 48 h` ; les sauvegardes ont leur propre rétention à configurer.

Configurer les sauvegardes, leur rétention et une restauration de contrôle auprès de l'hébergeur. Garder les procédures propres à l'instance hors du dépôt public. Les principes de cohérence, de purge et de reprise sont décrits dans l'[ADR PostgreSQL](adr/002-database.md).

## Vérifications

Avant l'ouverture, vérifier HTTPS, le catalogue, la création d'un événement de recette, la participation idempotente, SSE et son repli, puis supprimer uniquement les données de cette recette. Contrôler aussi la consommation mémoire, les limites de connexion, la purge et les journaux de chaque couche, sans enregistrer les corps de participation ni les paramètres SQL.

`REAL_EVENTS_APPROVED` conserve sa valeur désactivée tant que les décisions du [pilote](pilot-checklist.md) ne sont pas résolues. Ce paramètre n'établit aucune conformité juridique.
