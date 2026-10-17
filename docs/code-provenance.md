# Vérifier le code publié

La preuve se fait en trois étapes : relier une archive à sa fabrication GitHub, comparer les fichiers installés à cette archive, puis observer les fichiers publics servis. Le SHA affiché par une application est une déclaration ; il ne démontre pas, à lui seul, quel programme le serveur exécute.

## Fabrication et contenu

Le workflow `.github/workflows/release.yml` fonctionne sur `main`, après le workflow de vérification réutilisé sur le même commit. Le job de publication possède une nouvelle copie Git propre. Il reconstruit avec l’origine publique donnée par l’entrée manuelle `origin`, la variable de dépôt `PUBLIC_ORIGIN`, ou `https://jemecompte.fr`. Aucun artefact du build PWA de recette, qui utilise une origine loopback, n’est réutilisé.

Pour éviter de doubler le coût des tests, la CI autonome ignore les pushes sur `main` : le workflow de publication appelle cette même CI via `workflow_call` sur le commit du push avant de publier. Les pushes sur les autres branches et les pull requests gardent leur vérification autonome.

`scripts/build-release.mjs` relève les versions exactes de Node et npm, le hash du lockfile, les chemins et SHA-256 des entrées publiques visibles par Git, l’origine et la difficulté d’admission publique. Les fichiers suivis et les nouveaux fichiers locaux non ignorés sont inventoriés ; une publication exige qu’ils soient tous commités. Les répertoires de sources, scripts, statiques, migrations, documentation, tests, workflows et quelques configurations racine constituent une liste autorisée explicite dans `scripts/release-files.mjs`. Les fichiers privés, `.env`, `ops`, `.git` et fichiers de configuration npm en sont exclus avant lecture ; les liens symboliques de sources sont refusés. Un build local peut être marqué `modified` ; une publication GitHub exige `clean`.

L’identité de build est dérivée du commit, des empreintes de sources, des versions Node/npm, de l’origine et de la difficulté d’admission publique. Le manifeste `build/release-manifest.json` inventorie chaque fichier généré, sa taille, son SHA-256 et son caractère exécutable. Il s’exclut lui-même pour éviter une référence circulaire. Son empreinte est annoncée par `/api/version` ; l’archive extérieure et son attestation authentifient le manifeste complet.

`npm run release:package` vérifie d’abord le build, copie uniquement `build`, `package.json`, le lockfile et les scripts autonomes de vérification dans `.release/runtime`, puis y exécute une installation isolée des dépendances de production avec `npm ci --omit=dev --ignore-scripts`. Les dépendances du répertoire de travail et ses fichiers privés ne sont pas copiés. Le manifeste est refait sur l’ensemble de cette arborescence, y compris les dépendances. Les liens symboliques internes sont décrits sans être suivis ; ceux qui sortent de l’archive sont refusés.

Le workflow démarre cette archive isolée, vérifie son endpoint de provenance et compare ses fichiers publics. Il produit ensuite une archive `.tar.gz`, `SHA256SUMS` et une attestation GitHub/Sigstore de ces deux fichiers. Les actions sont référencées par SHA complet. Le build de publication fixe Node à `24.19.0` et conserve le numéro npm réellement utilisé dans le manifeste. Les outils doivent être mis à jour délibérément avec la CI. Les fichiers sont conservés 90 jours dans les artefacts GitHub Actions ; archiver les preuves de chaque version effectivement déployée si une conservation plus longue est nécessaire. La fabrication peut consommer les quotas GitHub Actions applicables au dépôt.

Cette procédure produit des artefacts vérifiables. Elle ne revendique pas encore des builds indépendants reproductibles bit pour bit : système du runner, outils et formats d’archive doivent aussi être maîtrisés pour cette propriété.

## Vérifier une archive puis les fichiers publics

Choisir le commit attendu depuis une revue ou une publication de confiance. Télécharger l’artefact de son exécution du workflow de publication. Le nom annoncé par le site ne doit pas être l’unique source de ce choix. Les commandes ci-dessous utilisent une version récente de GitHub CLI ; remplacer le commit d’exemple par celui effectivement approuvé.

```sh
release_commit='REMPLACER_PAR_LE_COMMIT_COMPLET_APPROUVE'
gh attestation verify "jemecompte-$release_commit.tar.gz" \
  --repo guidouil/jemecompte \
  --signer-workflow guidouil/jemecompte/.github/workflows/release.yml \
  --source-ref refs/heads/main \
  --source-digest "$release_commit" \
  --deny-self-hosted-runners
mkdir verified-runtime
tar -xzf "jemecompte-$release_commit.tar.gz" -C verified-runtime
node scripts/verify-release.mjs ./verified-runtime
node scripts/verify-site.mjs https://jemecompte.fr ./verified-runtime
```

Lancer les deux scripts depuis une copie de confiance du dépôt. L’attestation doit être validée **avant** extraction ou exécution de fichiers de l’archive. La vérification impose le dépôt, le chemin du workflow, sa référence de source et le commit attendu. Le bundle fourni avec l’artefact peut être passé avec `--bundle` pour la vérification locale, selon la [documentation de GitHub CLI](https://cli.github.com/manual/gh_attestation_verify).

`verify-release.mjs` refuse les fichiers manquants, supplémentaires, modifiés, les chemins dangereux et les permissions exécutables différentes. Sur un build natif, son contrôle est limité à `build` ; sur l’archive complète il couvre toute l’arborescence extraite, sauf le manifeste lui-même. Aucun accès DB n’est nécessaire.

`verify-site.mjs` vérifie d’abord cette copie locale puis compare l’identité annoncée par `/api/version`, l’empreinte du manifeste et chaque ressource publique `build/client` reçue du site sans compression. Les variantes précompressées `.br`/`.gz`, qui ne sont pas des URL publiques, sont contrôlées sur disque avec le reste de l’archive. Les réponses redirigées et trop volumineuses sont refusées. Le téléchargement utilise HTTP directement, sans navigateur ni service worker. Il ne compare pas le HTML SSR dynamique, ni les réponses des API de comptage. Une différence doit être investiguée : elle peut aussi provenir d’une transformation des ressources par un proxy.

## Installer et contrôler la production

Le workflow publie des fichiers ; il ne déploie pas automatiquement sur Clever Cloud et ne modifie aucun secret. Pour une livraison d’artefact, faire vérifier signature et empreinte par la chaîne de déploiement, extraire dans un nouveau répertoire, effectuer le contrôle local et lancer `node build` depuis la racine extraite, avec les secrets fournis par l’environnement de l’hébergeur. Ne pas relancer `npm install` ou Vite après vérification. Les migrations s’appliquent séparément par le rôle de maintenance depuis le code correspondant. Garder un historique indépendant du digest installé, du commit, du résultat des vérifications et des retours arrière.

Le mode natif Node de Clever reste utilisable avec `npm ci`, `npm run build`, puis `npm start`. Vérifier `CC_NODE_BUILD_TOOL=npm-ci`, les dépendances de développement au build et les hooks réellement configurés. Clever expose `COMMIT_ID` ; `.git` peut être disponible ou absent selon le déploiement. Avec une copie Git locale, le build inventorie ses fichiers publics visibles ; sans elle, il utilise une liste de fichiers publics autorisés et marque la correspondance Git comme non vérifiée. Clever peut retirer `.nvmrc` avant le build : uniquement lorsque ce fichier est strictement absent, que `COMMIT_ID` correspond exactement au `HEAD` local et qu’aucun `GITHUB_SHA` n’est fourni, le script restaure les octets exacts du fichier régulier `HEAD:.nvmrc` par création exclusive, sans remplacer de fichier ou de lien. Aucun autre chemin n’est restauré. Cela conserve l’inventaire du commit sans influer sur la version choisie par la plateforme : `engines.node` prévaut sur `CC_NODE_VERSION`. Le manifeste identifie les versions réellement employées. Ce second build n’est pas l’archive attestée par GitHub, même si son commit annoncé est identique. Voir les [variables plateforme](https://www.clever.cloud/developers/doc/develop/common-configuration/environment-variables/) et le [runtime Node](https://www.clever.cloud/developers/doc/deploy/applications/nodejs).

La livraison de l’archive attestée doit être intégrée et qualifiée avec les capacités du mode d’hébergement choisi avant de revendiquer une correspondance d’artefact. Les réglages de branche GitHub, protections de `main`, accès Clever, droits DB et historique des déploiements ne sont pas vérifiés par ces scripts. Restreindre les droits, utiliser MFA et revue indépendante des workflows/dépendances ; conserver le journal de déploiement hors du seul compte administrateur de l’application.

## Portée et limites publiques

Une [attestation GitHub](https://docs.github.com/en/actions/concepts/security/artifact-attestations) relie un artefact à sa fabrication. Sa vérification ne prouve ni l’absence de vulnérabilités ni son exécution actuelle. Le serveur peut annoncer les bons identifiants tout en exécutant un autre programme, ou sélectionner les réponses selon le visiteur. Le contrôle complet du serveur nécessite une observation indépendante chez l’hébergeur ; une page web ordinaire ne fournit pas d’attestation matérielle de son exécution.

Le même code peut produire des chiffres différents selon les événements, périmètres, migrations et modifications SQL. L’endpoint n’expose que la version runtime, `COMMIT_ID`, l’origine publique, le mode test/réel, `COUNTER_EPOCH` et `ADMISSION_DIFFICULTY`. Il ne publie aucune autre variable d’environnement, secret, adresse DB, identifiant de participant ou ligne de participation. La transparence de la configuration ne remplace pas le contrôle de la base et des accès.

Une PWA déjà ouverte peut conserver un ancien client : la page distingue sa version de celle annoncée par le serveur. `/transparence` et `/api/version`, y compris leurs données de navigation, sont exclus du cache du service worker et servis avec `no-store`. Leur contenu reste une déclaration. Le script externe sert à contrôler les octets publics indépendamment.

Enfin, la provenance du programme ne transforme pas les participations anonymes en humains uniques. Les limites de la [méthode de comptage](counting-method.md) et les incidents connus restent à publier séparément. Des instantanés d’agrégats horodatés et déposés auprès d’un tiers permettraient de rendre visible une réécriture ultérieure de l’historique ; ils ne démontreraient pas, à eux seuls, l’authenticité des déclarations initiales.
