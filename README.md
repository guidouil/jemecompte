# JeMeCompte.fr

Prototype de comptage volontaire, sans compte participant : **« X personnes se sont comptées sur place »**. Ce chiffre additionne des participations déclarées ; il ne mesure ni toute la foule ni des humains uniques. Un client modifié peut mentir sur sa présence.

**La collecte réelle est désactivée par défaut dans la configuration technique.** Les mentions de version de test et de démonstration ont été retirées de l'interface ; ce changement de présentation n'active pas la collecte réelle. Les décisions E0 concernant information, bases légales, droits et retrait restent bloquantes avant un pilote réel. Voir [ADR 001](docs/adr/001-product-and-privacy.md), [PLAN.md](PLAN.md) et [méthode de comptage](docs/counting-method.md).

## Démarrer localement

Prérequis : Node ≥22.17, npm et Docker Compose. Les dépendances stables sont fixées dans `package.json` et `package-lock.json`.

```sh
npm ci
cp .env.example .env
docker compose up -d --wait postgres
npm run db:migrate
npm run admin -- seed-demo
npm run dev
```

Ouvrir [http://127.0.0.1:5173](http://127.0.0.1:5173). Le seed crée un événement **fictif** ouvert 24 heures autour de la place de la République à Paris, avec un compteur initial à **zéro**. Il ne crée aucun participant. Le relancer crée une autre démonstration ; il ne remet pas un compteur existant à zéro.

Aucune géolocalisation n'est demandée avant le clic. Hors du périmètre parisien, le refus « hors zone » est attendu. Les tests simulent une position uniquement sur des événements fictifs. Pour un téléphone réel, la géolocalisation nécessite HTTPS ; l'exception locale `localhost`/loopback ne rend pas une simple adresse HTTP du réseau local équivalente.

La clé locale reste dans IndexedDB ; l'identifiant envoyé diffère selon l'événement. La position GPS utilisée pour chercher autour de soi ou participer reste dans le navigateur. Lors d'une création, le lieu public choisi explicitement sur la carte est, lui, envoyé et publié. Aucun fingerprint, tracker tiers, compte participant ou crédit hors ligne. Le fournisseur de localisation du navigateur et le transport réseau ont leurs propres limites de confidentialité.

## Trouver et créer un rassemblement

La [recherche locale](http://127.0.0.1:5173/#rassemblements) filtre par nom, ville et période. « Autour de moi » demande un relevé ponctuel et classe les zones à 5, 25 ou 100 km sans transmettre la position, l'ajouter à l'URL ou la conserver dans le stockage. Les distances sont approximatives, jusqu'au centre du périmètre. Le catalogue est borné à 500 événements avec priorité aux comptages actifs ; il ne constitue pas un annuaire exhaustif.

La page [Créer un comptage](http://127.0.0.1:5173/creer) guide le choix d'une commune puis d'un lieu public sur une carte IGN, le réglage du rayon de **100 m à 10 km, avec 500 m par défaut**, le nom, le début et la durée (**1, 2, 4, 8, 12, 24, 48 ou 72 h, avec 4 h par défaut**), puis une confirmation des informations publiques. Elle propose les comptages voisins avant publication. Aucun GPS n'est demandé dans ce parcours et aucune présence n'est ajoutée automatiquement. Après création, la personne rejoint la page du rassemblement pour s'y compter.

L'ouverture est immédiate par défaut, ou fixée à une **date et une heure de Paris (Europe/Paris)**, indépendamment du fuseau de l'appareil. Le récapitulatif affiche le début et la fin. Les heures inexistantes ou répétées lors d'un changement d'heure demandent un autre choix explicite. La durée mesure les heures réellement écoulées depuis le début retenu : 72 h correspondent à trois fois 24 h, y compris lors d'un changement d'heure. Le serveur refuse un nouvel événement dont la fin est déjà passée ; un début passé reste possible pour un rassemblement encore en cours. Il n'enregistre aucune participation rétroactive et refuse de compter avant l'ouverture. Les événements programmés sont consultables et proposés dans la recherche, dans la limite du catalogue. Le passage à minuit ne remet pas le compteur à zéro et n'autorise pas une nouvelle participation avec la même identité locale : l'unicité porte sur l'événement entier, même sur plusieurs jours.

Un rayon de 500 m couvre 1 km de large. À 10 km de rayon, la zone couvre 20 km de large et environ 314 km² : elle peut inclure des personnes éloignées du rassemblement. Le chiffre porte sur les participations déclarées dans la zone choisie ; il ne garantit pas la présence physique au rassemblement. Le périmètre publié doit accompagner l'interprétation du compteur.

Sur la page d'un rassemblement, **« Voir le périmètre »** ouvre une carte du polygone exact utilisé pour le comptage, avec une superficie approximative et le rayon approximatif pour un cercle reconnu. Les zones personnalisées restent affichées selon leur contour publié. Cette carte ne demande aucune position et n'ajoute aucune présence ; son fond passe par la même passerelle IGN. Une erreur de carte ne bloque pas le comptage.

**« Copier le lien »** copie l'adresse publique du rassemblement. **« Partager »** ouvre le partage natif lorsque le navigateur le propose. Aucun paramètre, fragment ou identifiant de participation n'est inclus dans le lien. Si la copie automatique est refusée, un champ sélectionnable permet de copier manuellement ; l'annulation du partage est traitée normalement.

Le serveur transforme le cercle en GeoJSON, fixe le début immédiat ou valide le début choisi, calcule la fin et déduplique les reprises du même `requestId`. Une réponse perdue peut être redemandée sans modifier les horaires, même après la fin ; réutiliser la demande avec un autre début est refusé. Aucune identité de créateur n'est conservée et aucun droit d'administration n'est accordé au créateur. Les créations portent la mention « Ouvert par un participant » ; nom, commune et zone sont déclaratifs. Avec `REAL_EVENTS_APPROVED=false`, le classement interne `is_test` reste appliqué, sans badge ni préfixe ajouté au nom public. La migration `0002_public_event_wording.sql` nettoie uniquement les anciens textes générés identifiables, en préservant noms saisis, identités, liens, horaires, hashs et compteurs. Modération via la CLI existante. Voir [les choix et limites](docs/adr/003-community-events.md).

Leaflet 1.9.4 est livré localement, sans CDN. Les tuiles IGN et recherches de communes passent par des endpoints aux fournisseurs fixes, sans transmettre IP, cookies ou headers du visiteur. Le service voit la zone de carte demandée et le nom de commune recherché ; les fournisseurs voient l'IP du serveur. Internet est nécessaire pour ces services externes. Aucun appel cartographique n'est nécessaire au parcours de comptage.

## Vérifier

Compose crée uniquement la base applicative. Créer la base de test une première fois :

```sh
docker compose exec -T postgres createdb -U jemecompte jemecompte_test
npm run check
npm run build
npm test
npx playwright install chromium
npm run test:e2e
npm run test:pwa
```

Pour consulter le build localement après `npm run build` : `npm run preview` ouvre le port 4173. `npm start` sert le build Node ; configurer alors `ORIGIN` pour son URL effective (par exemple `ORIGIN=http://127.0.0.1:3000 npm start`). En production derrière Caddy, utiliser l’origine HTTPS canonique du guide de déploiement.

`TEST_DATABASE_URL` doit viser une base dédiée dont le nom se termine par `_test`. Les intégrations appliquent leurs migrations et nettoient leurs propres événements, sans `TRUNCATE`. Sans cette variable, les intégrations sont ignorées : une suite verte sans PostgreSQL ne valide pas les transactions. Les E2E démarrent leur serveur isolé sur le port 5175 ; la recette PWA utilise le build de production sur 5176 et vérifie un rechargement hors ligne puis une confirmation après reconnexion, les cartes sous CSP et les outils de partage. Le partage et le presse-papiers sont simulés dans cette recette : aucun lien n'est envoyé à un tiers. Ces serveurs utilisent la base de test ; ne pas leur fournir de données réelles.

Les intégrations vérifient sur PostgreSQL 18 les soumissions concurrentes, rollback, clôture, attente de verrou, multijour, purge, privilèges du rôle public et création idempotente sans présence automatique. Ce résultat n'atteste pas une capacité de 5 000 connexions en production. La CI fournie exécute types, build, tests et Chromium avec une base éphémère ; elle n'a aucun accès à la production.

## Administrer

```sh
npm run admin -- import event.json --dry-run
npm run admin -- import event.json
npm run admin -- publish UUID --reason 'Démonstration autorisée'
npm run admin -- pause UUID --reason 'Vérification du périmètre'
npm run admin -- close UUID --reason 'Événement terminé'
npm run db:reconcile -- UUID --finalize
npm run db:purge -- --expired
```

L'import attend `slug`, `name`, `cityCode`, `cityName`, `geofence` GeoJSON Polygon, `startsAt`, `endsAt` ISO avec fuseau, et `isTest` explicite ; `id` et `description` sont optionnels. Il crée un brouillon, jamais une publication implicite. L'UUID demeure l'identité de l'événement. Les scripts chargent `.env` si présent ; ne jamais versionner ce fichier ni réutiliser les identifiants locaux en production.

Le drapeau `REAL_EVENTS_APPROVED=true` n'est pas une validation juridique. Il ne doit pas être activé avant résolution des décisions et adaptations décrites dans l'ADR 001.

## Architecture et exploitation

SvelteKit 3, Svelte 5, TypeScript strict, CSS natif, PostgreSQL et schéma Drizzle ; API dans le même processus Node. L'unicité SQL et l'incrément sont transactionnels. SSE diffuse des snapshots regroupés, avec polling de secours. La PWA cache des ressources publiques ; aucune file de participations différées n'est créditée après clôture.

- [Base, migrations et CLI](docs/adr/002-database.md)
- [Déploiement Node/Caddy](ops/deployment.md)
- [Incidents et restauration](ops/incident-runbook.md)
- [Recette du pilote](docs/pilot-checklist.md)
- [Signalement sécurité](SECURITY.md)

Licence [MIT](LICENSE).

Résultats détaillés et limites de la recette : [état de l’implémentation](docs/implementation-status.md). Le scénario de charge local se lance après le build avec `npm run test:load` sur la base de test dédiée.
