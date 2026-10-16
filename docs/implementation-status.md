# État de l’implémentation et recette locale

16 octobre 2026. Le « Go » suivant la revue de `PLAN.md` a lancé l’implémentation ; le plan reste le document de conception historique.

## Fonctionnement livré

SvelteKit 3.1 / Svelte 5, TypeScript strict, CSS natif clair/sombre, PostgreSQL 18, schéma Drizzle, migrations et CLI. Identité HMAC locale non exportable et sûre entre onglets ; géolocalisation ponctuelle et géofence locales ; API stricte sans coordonnées ; insertion et compteur par jour atomiques/idempotents ; national/ville par somme ; SSE partagé et polling de secours.

Cache PWA de données publiques, aucun POST/statut individuel caché, aucune file persistante de participations ni crédit hors ligne. Reprise d’une confirmation par statut, y compris après clôture. Rate limiting éphémère et borné, budgets de lecture/écriture, deadline du body, CSP avec nonces/hashes et exception par hash exacte pour l’annonceur accessible de SvelteKit.

Événements et compteurs de test séparés des réels. Le seed ne crée aucune présence. La démo locale reste à zéro tant qu’un utilisateur ne participe pas. Les tests utilisent exclusivement des fixtures fictives dans `jemecompte_test` et nettoient leurs données.

Présentation publique : mentions « version de test », « démonstration », badges de test et suffixes automatiques retirés des pages, listes, pied de page et messages. Les nouvelles créations gardent le nom saisi sans préfixe. La migration ciblée `0002_public_event_wording.sql` nettoie les anciens textes générés reconnus, y compris le seed identifié par son audit, et préserve les textes saisis, liens, hashs, horaires, compteurs et participations. Les contrôles techniques de collecte et la séparation interne `is_test` restent configurés comme auparavant.

Création participative ajoutée : carte IGN/Leaflet sans GPS, choix d’une commune puis d’un centre public, rayon réglable de 100 m à 10 km avec 500 m par défaut, durée de 1, 2, 4, 8, 12, 24, 48 ou 72 h avec 4 h par défaut, récapitulatif et confirmation avant publication. L’ouverture est immédiate par défaut, ou choisie par date et heure de Paris (Europe/Paris), indépendamment du fuseau de l’appareil. Le début et la fin sont récapitulés ; les heures inexistantes ou répétées lors des changements d’heure demandent un autre choix. La durée correspond aux heures réellement écoulées depuis le début (72 h = trois fois 24 h). Le serveur valide que la fin d’une nouvelle création n’est pas déjà passée ; un rassemblement commencé et encore ouvert est accepté. Le comptage reste fermé avant le début programmé et aucune participation n’est rétrodatée. Le compteur et l’unicité de l’identité locale restent attachés à l’événement entier, sans remise à zéro par jour. Les comptages voisins sont proposés pour éviter les doublons ; créer ne compte personne. Horaires serveur, UUID de demande et hash de configuration publique assurent l’idempotence des reprises, y compris après la fin et avec les anciennes demandes sans début explicite. La programmation utilise les colonnes horaires existantes, sans nouvelle migration après `0001`. Le catalogue garde sa limite de 500 et son tri temporel, avec suppression de la précédente borne future à 30 jours. Aucune identité durable de créateur. Les nouvelles créations sont fictives en mode démo.

La taille de la zone change la portée du compteur : 10 km de rayon représentent 20 km de large et environ 314 km². Une telle zone peut inclure des personnes éloignées du rassemblement. Le compteur décrit des participations déclarées dans le périmètre choisi, sans garantie de présence physique au rassemblement.

Recherche ajoutée : nom/ville sans accents, période, proximité facultative à 5/25/100 km calculée localement, refus de localisation et remise à zéro. Catalogue borné à 500, non exhaustif. Tuiles IGN et noms de communes transitent par des passerelles aux fournisseurs fixes, sans transfert des headers ou IP des visiteurs. Voir [ADR 003](adr/003-community-events.md).

Outils du rassemblement ajoutés sous le bouton de comptage : « Voir le périmètre » affiche à la demande le GeoJSON exact, y compris les zones personnalisées concaves, avec une superficie approximative et un rayon approximatif pour les cercles reconnus. Aucune position n’est demandée ou affichée. Le contour reste visible si le fond IGN échoue ; fermeture, réouverture et recentrage sont disponibles. « Copier le lien » et le partage natif utilisent uniquement l’adresse publique de l’événement sélectionné, sans paramètres, fragment ou identifiant participant. Un refus du presse-papiers propose un champ sélectionnable ; l’annulation du partage n’est pas une erreur de comptage.

## Vérifications réalisées

Le retrait des mentions de version de test et de démonstration passe 254 tests unitaires et PostgreSQL, les 14 parcours Chromium mobile et les 6 parcours production/PWA existants, avec types sans erreur ni avertissement et build Node réussi. La migration `0002` est appliquée localement. Son test couvre un nom utilisateur commençant déjà par le préfixe, une description personnalisée à préserver, le seed audité et une imitation sans audit, la conservation des colonnes hors texte/métadonnées et celle des présences, compteurs et audits, puis l’idempotence du rejeu.

La programmation du début et le défaut de 4 h passent la suite complète de 253 tests unitaires et PostgreSQL, avec types sans erreur ni avertissement et build Node réussi. Les vérifications couvrent UTC été/hiver et fuseau différent de Paris, dates civiles invalides, heure inexistante ou répétée, durées écoulées aux changements d’heure et de jour, début passé encore ouvert, refus d’une fenêtre déjà finie sans ligne persistée, recherche d’un événement à +60 jours, refus serveur de compter avant ouverture, compatibilité des anciens hash et rejeux concurrents après expiration. Les 14 parcours Chromium mobile et les 6 parcours production/PWA passent : saisie 14:30 Paris depuis un navigateur Los Angeles avec fin à 18:30 et UTC exact, filtre « À venir », bouton fermé avant ouverture, horaires passés, reprise à horaires explicites inchangés, formulaire à 320 px sans débordement et prévisualisation sous CSP sans GPS, présence, création ni appel navigateur à un tiers. La recette des horaires programmés n’exige ni nouvelle dépendance ni migration.

L’ajout du périmètre public et du partage est vérifié avec 172 tests unitaires, les 12 parcours Chromium mobile existants et 6 tests du build de production. Les quatre nouveaux parcours vérifient le contour exact et entièrement cadré, le chargement de la carte au clic, sa fermeture/réouverture, Axe A/AA, le lien canonique nettoyé, le refus de copie avec sélection manuelle et le partage simulé avec annulation. Aucun appel GPS, aucune requête de présence/statut/création, aucune présence en base, aucune requête du navigateur vers un fournisseur tiers et aucune violation CSP ne sont observés dans ces parcours. Le fond, le presse-papiers et le partage sont simulés ; la feuille de partage native reste à qualifier sur téléphone physique. Types et build sont validés. Les résultats ci-dessous décrivent aussi les recettes antérieures des autres fonctionnalités.

L’extension précédente des durées jusqu’à 72 heures a été vérifiée avec 143 tests unitaires, 11 intégrations PostgreSQL de création et les 3 parcours navigateur de création/découverte. Les huit durées sont proposées dans l’interface ; les quatre nouvelles durées donnent l’écart exact entre début et fin et le rejeu d’une création de 72 h conserve ses horaires.

- Types Svelte/TypeScript et service worker : zéro erreur et zéro avertissement.
- Build de production avec adaptateur Node : réussi. Avant la carte, l’ensemble JS/CSS compressé pesait 58,5 Ko ; avec création et horaires, carte publique et partage, il représente environ 134 Ko. Leaflet est importé à l’affichage de la carte, mais le service worker actuel précache tous les assets immuables : le budget global initial de 100 Ko est donc dépassé. Les tuiles sont demandées à l’ouverture explicite des cartes ; ni elles ni les recherches de communes ne sont nécessaires pour compter. Le précache sélectif est une optimisation ultérieure à mesurer sur téléphone.
- 141 tests unitaires/intégration réussis : 122 unitaires et 19 scénarios sur PostgreSQL réel. Les ajouts couvrent géométrie, recherche locale, passerelles cartographiques bornées, création sans présence, concurrence/idempotence, payload modifié, bascule du mode démo, invalidation du catalogue et rôle SQL de création limité. Les rayons entiers intermédiaires et la limite de 10 km sont vérifiés côté contrat et PostgreSQL, avec un point à 9 km dedans et à 11 km dehors. Les scénarios de comptage existants restent verts.
- 12 parcours Chromium mobile réussis : les 9 parcours précédents et 3 nouveaux sur création sans GPS, absence de présence automatique, POST strict de configuration publique, réponse de création perdue puis reprise du même UUID, recherche de proximité sans coordonnées dans les requêtes/URL. La saisie du rayon vérifie le défaut 500 m, les valeurs invalides/vides bloquées, une valeur libre de 750 m et la création réelle d’une fixture de 10 km dans la base de test.
- 2 tests du build de production réussis : PWA existante (rechargement hors ligne, confirmation après reconnexion, absence de cache des endpoints individuels) et carte interactive sous CSP sans appel GPS ni requête du navigateur à un fournisseur tiers. Le cercle de 10 km reste entièrement visible grâce au recadrage automatique. Les fournisseurs sont simulés dans les tests automatisés ; le fond IGN et la recherche réelle de Paris ont aussi été vérifiés dans l’aperçu local.
- Axe A/AA sur les pages vérifiées ; clair/sombre et largeurs 320 à 1280 px : aucune violation ou débordement observé. Cela ne remplace pas une recette avec lecteurs d’écran et téléphones physiques.
- `npm audit --omit=dev` : aucun avis de vulnérabilité connu signalé au moment de la recette ; cela ne garantit pas l’absence de vulnérabilité.
- Caddyfile validé dans un conteneur éphémère avec `caddy validate`. Aucun domaine publié ni certificat public obtenu.

## Charge synthétique locale

Serveur compilé et base de test sur la même machine, HTTP loopback sans proxy/TLS ni réseau mobile. POST répartis sur 64 ou 128 requêtes concurrentes ; le p95 part de la première tentative, inclut les retries mais exclut l’attente avant l’affectation à un worker. La durée inclut la réception du total final par SSE.

| Participants synthétiques | Lecteurs SSE | p95 confirmation | Durée de charge | Pic RSS serveur échantillonné |
|---|---|---|---|---|
| 1 000 | 200 | 106 ms | 3,15 s | 178,6 Mio |
| 5 000 | 5 000 | 206 ms | 9,28 s | 430,7 Mio |

Dans les deux cas, nombre de présences = compteur attendu ; 100 rejeux retournent `already_counted` sans incrément. Tous les lecteurs reçoivent le total final via un canal partagé. Le second cas rencontre 51 réponses `429` à l’ouverture des SSE, résolues par reprises bornées ; aucune erreur réseau/lecteur n’a été observée.

Ces résultats ne certifient ni un débit de production, ni la résistance à un botnet, ni la capacité radio d’une manifestation. Aucune optimisation en buckets n’a été nécessaire à cette recette locale.

Reproduction après migration de la base de test et `npm run build` :

```sh
npm run test:load
TOTAL=5000 READERS=5000 CONCURRENCY=128 npm run test:load
```

Le harness refuse une DB non-loopback ou dont le nom ne finit pas par `_test`, démarre son serveur sur 5177, n’utilise jamais la base de démonstration et nettoie son seul événement. Ne pas exécuter en même temps que les intégrations ou parcours navigateur : les agrégats nationaux de fixtures seraient mélangés pendant les assertions.

## État de la roadmap

- E1–E11 : fonctionnalités techniques implémentées et vérifiées localement.
- E0 : arbitrages techniques retenus ; validation juridique, responsable et bases légales, consentement/droits/retrait, durée exacte d’identité locale et petites cohortes encore à décider.
- E12 : réconciliation/finalisation et purge disponibles ; droits individuels et réapplication des effacements à la restauration dépendent encore de la décision E0 et ne sont pas présentés comme livrés.
- E13 : build, charge locale, recette de production et configuration CI/proxy fournis. Déploiement européen, sauvegardes/PITR, restauration de l’hébergeur, contrôles de rétention et charge sur cette infrastructure restent à réaliser. La CI a été écrite mais n’a pas été exécutée sur un service distant.
- E14 : aucun pilote réel ou essai physique effectué. Safari/iOS, Firefox/Brave réels, lecteur d’écran, périmètre à pied et réseau radio saturé restent à qualifier.

La collecte réelle est désactivée par défaut. Les validations et adaptations E0/E12 doivent précéder son activation ; changer un drapeau ne les réalise pas.

La cible d’hébergement choisie par l’utilisateur est désormais Clever Cloud. Les fichiers Node/Caddy existants sont une base historique ; configuration Clever Cloud, domaine, secrets, logs plateforme, migrations de production, sauvegardes et recette SSE sur l’hébergeur restent à réaliser. La création publique nécessite également une procédure de signalement/modération avant une ouverture nationale.
