# ADR 002 — PostgreSQL, admission et exploitation

Le service public utilise PostgreSQL avec un pool `pg` paresseux et borné à 15 connexions. Drizzle décrit le schéma ; les instructions critiques restent des requêtes SQL paramétrées. Aucun accès DB n'est ouvert pendant l'import des modules ou le build.

## Migration

`DATABASE_URL=… npm run db:migrate` applique les fichiers SQL numérotés de `drizzle/` dans l'ordre. Le runner sérialise les migrations avec un verrou consultatif, applique chaque fichier dans une transaction et vérifie son checksum aux exécutions suivantes. Une migration déjà appliquée ne doit jamais être modifiée. Le rôle d'exécution des migrations est distinct du rôle public en production.

Les migrations initiales sont relues et maintenues explicitement. `drizzle.config.ts` décrit le schéma pour l'outillage ; avant d'adopter la génération automatique, établir et vérifier le snapshot/journal Drizzle correspondant à cette base. Ne pas appliquer une seconde création des mêmes tables générée sans baseline.

## Admission et lecture

Le protocole respecte `FOR SHARE` sur l'événement, vérification du doublon, heure `clock_timestamp()` après le verrou, insertion conditionnelle et incrément du compteur dans la même transaction. Une présence ne stocke que l'événement, 32 octets opaques et le jour français. Les compteurs et révisions sont des chaînes décimales dans les réponses JSON ; aucune perte de précision JavaScript.

Les snapshots utilisent une seule instruction SQL : total de l'événement, total du jour en France, ville, révisions et métadonnées appartiennent au même snapshot MVCC. Les démonstrations `is_test=true` et les événements réels ont des agrégats nationaux/ville séparés. Un brouillon n'est jamais exposé publiquement.

`COUNTER_EPOCH` est un entier décimal positif, par défaut `1`. Après une restauration pouvant faire reculer les révisions, augmenter cette valeur dans la configuration d'exploitation conservée hors de la base restaurée, redémarrer les processus/flux puis remettre le service en ligne. L'epoch ne doit pas revenir en arrière.

## Administration

L'accès aux scripts suppose SSH nominatif, aucune route publique d'administration. `ADMIN_OPERATOR` désigne l'opérateur dans l'audit ; sinon le nom de compte système est utilisé. Le journal contient uniquement configuration publique, action, raison et opérateur.

- `npm run admin -- import event.json --dry-run` valide sans connexion DB ni écriture.
- `npm run admin -- import event.json` crée ou modifie un brouillon ; la publication est séparée.
- `npm run admin -- publish UUID --reason '…'`, `pause UUID`, `close UUID` pilotent les transitions sous verrou exclusif.
- `npm run admin -- seed-demo` crée un événement explicitement fictif autour de la place de la République à Paris, ouvert 24 heures et sans présence initiale. Ce n'est pas un événement réel.
- `npm run db:reconcile -- UUID [--finalize]` vérifie les jours sous verrou exclusif. Une divergence n'est jamais réparée automatiquement.
- `npm run db:purge -- --expired` réconcilie puis purge les événements arrivés à `endsAt + 48 h`. Planifier cette commande toutes les 15 minutes, avec supervision des échecs. Le marqueur d'expiration et la suppression sont atomiques ; les compteurs sont conservés et l'événement ne peut plus être rouvert. `npm run db:purge -- UUID` ne permet pas de forcer une échéance.

La purge des sauvegardes/WAL reste une configuration d'exploitation à vérifier auprès de l'hébergeur, pas une propriété du DELETE applicatif. Le runner ne promet aucune reprise absolue après perte catastrophique de la base.

## Création publique guidée

La migration additive `0001_community_events.sql` distingue `creation_source=team|community` et conserve un hash SHA-256 des seuls champs publics d'une création communautaire. Le `requestId` aléatoire devient l'UUID de l'événement. Un rejeu normalisé identique retrouve l'événement ; une configuration différente avec ce même UUID est un conflit, sans réécriture. Aucun identifiant participant, créateur, IP ou secret local n'est associé à cette opération. Le hash n'est pas publié dans l'API.

`POST /api/events/create` reçoit une confirmation explicite de publication du centre choisi, un nom, une commune/code déclarés, un rayon réglable entre 100 et 10 000 m et une durée parmi 1/2/4/8/12/24/48/72 h. L'interface propose 500 m par défaut. Il ouvre immédiatement un événement à partir de l'heure PostgreSQL, sans présence et sans ligne d'audit d'opérateur. La fin correspond aux heures écoulées depuis cet instant : 72 h représentent trois fois 24 h. Le passage à minuit ne remet à zéro ni le compteur d'événement ni la contrainte d'unicité événement/identifiant ; une même identité locale reste comptée une seule fois sur toute la durée. Sans approbation réelle, l'événement est une démonstration explicitement nommée ; le rejeu reste une démonstration même après changement du drapeau.

Ces coordonnées sont celles du **lieu public choisi pour l'événement**, distinctes du relevé privé de participation. Les bounding boxes métropole/DROM sont approximatives et ne vérifient ni une frontière nationale exacte ni la correspondance entre nom de commune, code et centre ; un appelant direct peut déclarer des métadonnées fausses. Les événements communautaires sont identifiés comme tels. La création ne prouve ni l'existence d'une manifestation ni l'autorité de son créateur.

Un rayon de 10 km définit une zone de 20 km de large, soit environ 314 km². Le contrôle de périmètre peut alors admettre la déclaration d'une personne éloignée du rassemblement. Les agrégats portent sur les participations déclarées dans la zone configurée ; ni le modèle de données ni le test géographique ne garantissent la présence physique au rassemblement. L'affichage du périmètre permet d'en comprendre l'étendue.

Le rôle public reçoit en plus un droit `INSERT` limité aux colonnes nécessaires :

```sql
GRANT INSERT (
  id, slug, name, city_code, city_name, description, geofence, starts_at,
  ends_at, status, is_test, creation_source, creation_request_hash
) ON events TO jemecompte_public;
```

Conserver le `SELECT ON events` décrit plus bas : `RETURNING *`, la détection de conflit et la comparaison de `creation_request_hash` en ont besoin. Aucun accès à `admin_audit` ni droit de modification des colonnes de configuration existantes n'est ajouté. Ce profil est vérifié sous un rôle transactionnel restreint ; l'utilisateur public du processus ne devient pas propriétaire.

Un limiteur séparé conserve en RAM seulement un HMAC réseau éphémère et des compteurs : dix tentatives valides par réseau et cent au total dans une fenêtre d'une heure par processus, capacité bornée, remise à zéro à rotation de clé/redémarrage. Il n'est lié ni à la clé locale ni aux présences. Un NAT partagé peut atteindre ce plafond ; un attaquant distribué ou des redémarrages peuvent le contourner. Les délais de reprise sont explicites.

Le catalogue publie au plus 500 événements, en privilégiant les événements actifs, puis à venir, puis historiques. L'interface doit signaler cette limite si elle est atteinte ; il ne s'agit pas d'un moteur de recherche exhaustif national. La création invalide le cache partagé ; une lecture plus ancienne encore en vol ne doit pas réinjecter un résultat obsolète dans ce cache.

## Blocage des collectes réelles

Sans `REAL_EVENTS_APPROVED=true`, une nouvelle présence non fictive et une publication non fictive sont refusées. Mettre ce drapeau à `true` est une décision d'exploitation explicitement autorisée, après résolution des exigences produit/juridiques de l'ADR 001. Le drapeau n'établit aucune conformité. Aucun champ de preuve de consentement/retrait n'est inventé dans ce schéma.

## Tests

Les intégrations utilisent exclusivement `TEST_DATABASE_URL` avec un nom de base terminant par `_test`. Elles ne réutilisent jamais `DATABASE_URL`, ne font aucun `TRUNCATE` et ne suppriment que leurs événements fictifs. Elles vérifient concurrence, rollback, fin après attente de verrou, reprise en doublon après clôture, isolation test/réel, bigint et purge.

L'exploitation doit encore créer et vérifier les privilèges minimum : rôle public en lecture sur `events`, insertion/lecture sur `presences`, lecture/insertion/mise à jour sur `event_counters`. Exception technique : `FOR SHARE` exige aussi un droit `UPDATE` sur au moins une colonne d'`events` ; accorder uniquement `UPDATE(updated_at)`, sans permission de modifier statut, identité, ville, horaires ou périmètre. Le service n'écrit pas cette colonne. Aucune écriture `admin_audit`, suppression de présences ou DDL n'est accordée. Migration, administration et purge utilisent un rôle distinct. Ce profil est vérifié dans une transaction de test avec `SET LOCAL ROLE` et rollback, sans modifier le rôle applicatif. Voir les [privilèges de SELECT PostgreSQL](https://www.postgresql.org/docs/current/sql-select.html) et l'[exemple d'exploitation](../../ops/deployment.md). Ne pas activer les logs de requêtes ou paramètres sur les chemins participants.
