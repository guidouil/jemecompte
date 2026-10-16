# État de l’implémentation et recette locale

16 octobre 2026. Le « Go » suivant la revue de `PLAN.md` a lancé l’implémentation ; le plan reste le document de conception historique.

## Espace privé de gestion `/gui`

Un [back-office privé](admin.md) permet de rechercher tous les comptages, réels et de test, avec pagination de 40 éléments, leurs totaux et le nombre de participations encore conservées. Un seul mot de passe ouvre une session de huit heures ; l'empreinte scrypt et le secret de signature sont configurés côté serveur. Sans configuration valide, l'accès reste fermé. La commande `npm run admin:password` prépare ces deux variables sans modifier les environnements.

La suppression demande de recopier le lien court exact du comptage. Elle verrouille l'événement et supprime atomiquement l'événement, toutes ses participations et ses compteurs. Elle conserve un audit minimal sans identifiant participant. Le pool administratif accepte un rôle distinct via `ADMIN_DATABASE_URL` ; le rôle public n'a pas à recevoir les permissions de suppression. Les caches de totaux sont invalidés après commit, les flux de l'événement supprimé sont fermés et les autres compteurs acceptent les agrégats diminués selon la date de lecture serveur, sans rétablir un ancien total reçu en retard.

La connexion, les actions et les données `/gui` sont protégées côté serveur. Les réponses portent `no-store` et `noindex`, y compris les données SvelteKit, erreurs, redirections et chemins encodés. Le service worker exclut l'espace privé du cache et de toute restitution hors connexion. Les formulaires restent utilisables sans JavaScript ; la politique de referrer privée transmet l'origine au serveur pour leur protection CSRF et ne transmet aucun referrer vers une autre origine.

**Recette actuelle sous Node 24.22.0 : 389 tests unitaires et PostgreSQL, 28 parcours Chromium mobile et 9 parcours du build de production/PWA réussis ; types et service worker sans erreur ni avertissement, build Node réussi.** La suppression concurrente avec admission/purge/réconciliation, le rollback en cas d'échec de l'audit, les agrégats diminués, la connexion/déconnexion, le refus des suppressions non authentifiées ou mal confirmées, les formulaires sans JavaScript, l'accessibilité à 320 px et l'exclusion du cache privé sont vérifiés.

Le code est préparé localement. Aucun mot de passe réel ni environnement de production n'a été configuré et aucun comptage existant n'a été supprimé par ces travaux.

## Comptages communaux du 17 octobre

À la demande de l'utilisateur, la création communautaire reste ouverte et un [lot de 20 grandes communes métropolitaines](city-counts-17-octobre.md) est préparé pour le **17 octobre 2026, 07 h–19 h Europe/Paris**, soit 12 heures. Chaque configuration possède un UUID et un lien stables, une portée `city` et le contour administratif API Geo sans simplification. Marseille, Toulon et Saint-Étienne conservent leurs géométries à plusieurs parties ; aucun contour n'est remplacé par un cercle.

La migration additive `0003_counting_scope.sql` conserve les événements historiques en portée `gathering`. Les pages, la découverte, les boutons, QR et affiches distinguent commune entière et rassemblement localisé. Une déclaration dans la commune ne prouve aucune participation à une manifestation ; aucun lieu ou horaire de manifestation n'est confirmé. Les totaux nationaux et municipaux restent séparés par portée et par mode réel/test. Depuis l'accueil, même une seule commune correspondante demande un choix avant identité ou soumission. Le marqueur d'admission `countingScope: "city"` empêche une ancienne PWA d'admettre silencieusement une commune avec son ancien contexte de rassemblement.

Les limites des périmètres publics de rassemblement restent inchangées. Les contours administratifs sont bornés à 10 000 sommets et 250 Kio, sans trous ni recouvrement. Le formulaire de création exclut les communes entières de ses suggestions de doublons et reste utilisable avec un catalogue contenant des MultiPolygon. Les boutons de carte et de QR restent désactivés jusqu'à leur initialisation pour ne pas perdre le premier clic sur chargement lent.

Le dry-run `npm run cities:prepare` valide les 20 configurations et leurs empreintes sans accès DB. L'import explicite en brouillons est atomique, ne crée aucune présence ni compteur et peut être rejoué sans changement d'audit ou de version, y compris avec des UUID en majuscules. Les collisions, configurations différentes ou modes opposés annulent le lot. La publication est séparée et ne peut pas activer le garde de collecte réelle.

**Recette des comptages communaux avant ajout du back-office, sous Node 24.22.0 : 335 tests unitaires et PostgreSQL, 25 parcours Chromium mobile et 8 parcours du build de production/PWA réussis ; types et service worker sans erreur ni avertissement, build Node réussi.** Les tests couvrent la migration depuis l'ancien schéma avec conservation des données, le lot des 20 contours, l'idempotence/concurrence/rollback, les deux familles de compteurs, les anciens clients, le choix explicite sans POST ni identité préalable, le parcours direct de commune, les QR/affiches, les territoires disjoints et l'accessibilité à 320 px. Les dialogues de partage/impression restent simulés ; les téléphones physiques et l'hébergement cible restent à qualifier.

Les 20 configurations représentent environ 510 Ko de JSON compact et 157 Ko compressés avant sérialisation SSR. Le premier chargement d'un catalogue complet doit être qualifié sur réseau mobile dégradé. Le lot est préparé et vérifié localement ; aucun import, publication, déploiement ou activation de collecte réelle n'est effectué par cette recette.

## Premières priorités du 17 octobre

Les priorités de fiabilité et d'usage sur place sont implémentées localement :

- Catalogue, liens directs, total national, snapshots, SSE, admission et statut individuel suivent le même mode public. Le national de l'accueil ne force plus les données de test. Les caches sont séparés par mode ; aucun compteur ni événement existant n'est converti ou fusionné. Une ancienne demande de création appartenant à l'autre mode reçoit un conflit explicite sans événement ni redirection.
- Le compteur affiche l'heure du dernier snapshot serveur en heure de Paris, son ancienneté et un avertissement après une minute. L'accueil indique quand son total a été chargé. La vérification d'une participation fonctionne aussi pendant un événement ouvert après rechargement, sans GPS ni nouvelle présence.
- Après confirmation de publication, une création conserve uniquement sa configuration publique, son UUID et sa date dans le stockage de session de l'onglet. La reprise après rechargement est explicite et réutilise la même demande ; elle ne publie jamais automatiquement. Succès, rejet de validation ou abandon confirmé retirent la reprise ; une demande de plus de 24 h est retirée à sa prochaine lecture. Le stockage bloqué garde le parcours en mémoire avec un avertissement.
- QR généré localement à la demande, affiche imprimable sous la CSP existante et signalement d'erreur par courriel préparé. Aucun service QR tiers ni envoi de message automatique. `qrcode-generator` 2.0.4 est la seule nouvelle dépendance d'exécution ; `jsqr` 1.4.0 sert uniquement au décodage indépendant dans les tests.
- Métriques HTTP bornées pour écritures et ouvertures SSE : 429/503, saturation et panne sont distinguées sans conserver chemins, IP ou identifiants participants. Le [runbook du 17 octobre](runbook-17-octobre.md) décrit la surveillance, la pause, la clôture et les critères d'ouverture.

Recette de ces premières priorités sous **Node 24.22.0**, avec PostgreSQL 18 local : types et service worker sans erreur ni avertissement, build Node réussi, **294 tests unitaires/intégration**, **21 parcours Chromium mobile** et **8 parcours du build de production/PWA** réussis. Les nouveaux scénarios vérifient la séparation test/réel avec chiffres distincts et bascule des caches, la récupération sans GPS, la fraîcheur après reconnexion, la création après réponse perdue puis rechargement avec un seul événement, les rejets/abandons/expiration et le stockage bloqué. À 320 px, le QR effectivement rendu est décodé depuis ses pixels par jsQR ; l'impression vérifie CSS locale, texte hostile sans injection, absence de GPS/identité/participation/appel tiers et retour du focus. Le dialogue d'impression est simulé ; impression et scan sur appareils physiques restent à qualifier.

La charge de cette version confirme **5 000 présences et 5 000 lecteurs SSE**, 100 rejeux sans incrément, p95 confirmation de **211 ms**, charge de **9,215 s**, pic RSS échantillonné de **484,6 Mio**. Les 128 réponses 429 à l'ouverture des flux sont résolues par reprises bornées ; tous les lecteurs reçoivent le total final, sans échec réseau ou lecteur. Le serveur isolé est arrêté et sa fixture supprimée après la mesure. Ces chiffres concernent uniquement le loopback local, sans proxy/TLS ni réseau mobile ; ils ne certifient aucune capacité de Clever Cloud.

Le domaine public répond en HTTPS et son catalogue expose un événement classé test lors de la vérification en lecture seule du 16 octobre. Les changements ci-dessus ne sont pas déployés par cette recette ; aucun événement réel n'est créé ni la collecte activée. Restent la recette sur téléphones et sur l'hébergement cible, les décisions et adaptations de droits/retrait, ainsi que les preuves de purge, sauvegarde et restauration.

## Fonctionnement livré

SvelteKit 3.1 / Svelte 5, TypeScript strict, CSS natif clair/sombre, PostgreSQL 18, schéma Drizzle, migrations et CLI. Identité HMAC locale non exportable et sûre entre onglets ; géolocalisation ponctuelle et géofence locales ; API stricte sans coordonnées ; insertion et compteur par jour atomiques/idempotents ; national/ville par somme ; SSE partagé et polling de secours.

Cache PWA de données publiques, aucun POST/statut individuel caché, aucune file persistante de participations ni crédit hors ligne. Reprise d’une confirmation par statut, y compris après clôture. Rate limiting éphémère et borné, budgets de lecture/écriture, deadline du body, CSP avec nonces/hashes et exception par hash exacte pour l’annonceur accessible de SvelteKit.

Événements et compteurs de test séparés des réels. Le seed ne crée aucune présence. La démo locale reste à zéro tant qu’un utilisateur ne participe pas. Les tests utilisent exclusivement des fixtures fictives dans `jemecompte_test` et nettoient leurs données.

Présentation publique : mentions « version de test », « démonstration », badges de test et suffixes automatiques retirés des pages, listes, pied de page et messages. Les nouvelles créations gardent le nom saisi sans préfixe. La migration ciblée `0002_public_event_wording.sql` nettoie les anciens textes générés reconnus, y compris le seed identifié par son audit, et préserve les textes saisis, liens, hashs, horaires, compteurs et participations. Les contrôles techniques de collecte et la séparation interne `is_test` restent configurés comme auparavant.

Création participative ajoutée : carte IGN/Leaflet sans GPS, choix d’une commune puis d’un centre public, rayon réglable de 100 m à 10 km avec 500 m par défaut, durée de 1, 2, 4, 8, 12, 24, 48 ou 72 h avec 4 h par défaut, récapitulatif et confirmation avant publication. L’ouverture est immédiate par défaut, ou choisie par date et heure de Paris (Europe/Paris), indépendamment du fuseau de l’appareil. Le début et la fin sont récapitulés ; les heures inexistantes ou répétées lors des changements d’heure demandent un autre choix. La durée correspond aux heures réellement écoulées depuis le début (72 h = trois fois 24 h). Le serveur valide que la fin d’une nouvelle création n’est pas déjà passée ; un rassemblement commencé et encore ouvert est accepté. Le comptage reste fermé avant le début programmé et aucune participation n’est rétrodatée. Le compteur et l’unicité de l’identité locale restent attachés à l’événement entier, sans remise à zéro par jour. Les comptages voisins sont proposés pour éviter les doublons ; créer ne compte personne. Horaires serveur, UUID de demande et hash de configuration publique assurent l’idempotence des reprises, y compris après la fin et avec les anciennes demandes sans début explicite. La programmation utilise les colonnes horaires existantes, sans nouvelle migration après `0001`. Le catalogue garde sa limite de 500 et son tri temporel, avec suppression de la précédente borne future à 30 jours. Aucune identité durable de créateur. Les nouvelles créations sont fictives en mode démo.

La taille de la zone change la portée du compteur : 10 km de rayon représentent 20 km de large et environ 314 km². Une telle zone peut inclure des personnes éloignées du rassemblement. Le compteur décrit des participations déclarées dans le périmètre choisi, sans garantie de présence physique au rassemblement.

Recherche ajoutée : nom/ville sans accents, période, proximité facultative à 5/25/100 km calculée localement, refus de localisation et remise à zéro. Catalogue borné à 500, non exhaustif. Tuiles IGN et noms de communes transitent par des passerelles aux fournisseurs fixes, sans transfert des headers ou IP des visiteurs. Voir [ADR 003](adr/003-community-events.md).

Outils du rassemblement ajoutés sous le bouton de comptage : « Voir le périmètre » affiche à la demande le GeoJSON exact, y compris les zones personnalisées concaves, avec une superficie approximative et un rayon approximatif pour les cercles reconnus. Aucune position n’est demandée ou affichée. Le contour reste visible si le fond IGN échoue ; fermeture, réouverture et recentrage sont disponibles. « Copier le lien » et le partage natif utilisent uniquement l’adresse publique de l’événement sélectionné, sans paramètres, fragment ou identifiant participant. Un refus du presse-papiers propose un champ sélectionnable ; l’annulation du partage n’est pas une erreur de comptage.

## Recettes antérieures

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
- E0 : responsable et contact publiés dans la notice ; validation des bases légales, consentement/droits/retrait, durée exacte d’identité locale et petites cohortes encore à décider.
- E12 : réconciliation/finalisation et purge disponibles ; droits individuels et réapplication des effacements à la restauration dépendent encore de la décision E0 et ne sont pas présentés comme livrés.
- E13 : domaine HTTPS et catalogue accessibles ; build, charge locale, recette du build de production et configuration CI/proxy fournis. Sauvegardes/PITR, restauration de l’hébergeur, contrôles de rétention et charge sur l'infrastructure cible restent à vérifier. La CI a été écrite mais n’a pas été exécutée sur un service distant dans cette recette.
- E14 : aucun pilote réel ou essai physique effectué. Safari/iOS, Firefox/Brave réels, lecteur d’écran, périmètre à pied et réseau radio saturé restent à qualifier.

La collecte réelle est désactivée par défaut. Les validations et adaptations E0/E12 doivent précéder son activation ; changer un drapeau ne les réalise pas.

L’hébergement choisi est Clever Cloud et le domaine public est accessible. Les fichiers Node/Caddy existants sont une base historique ; configuration de l'instance, logs plateforme, migrations de production, sauvegardes et recette SSE sur l’hébergeur restent à vérifier avec des preuves d'exploitation. Le lien de signalement prépare un courriel et la modération utilise la CLI ; un opérateur disponible et un délai de traitement restent à organiser avant une ouverture nationale.
