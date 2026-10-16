# Périmètre livré et décisions de confidentialité

16 octobre 2026 — implémentation locale autorisée après revue de PLAN.md.

## Décisions techniques appliquées

Monolithe SvelteKit 3 stable, Svelte 5, TypeScript strict, CSS natif, PostgreSQL 18 et Drizzle. HMAC-SHA-256 local non exportable dans IndexedDB ; aucune rotation automatique pendant ce pilote technique. Aucun fingerprint, GPS serveur, compte participant, tracker tiers, CAPTCHA ou crédit hors ligne.

Les compteurs additionnent des participations événementielles. Le national utilise le jour d’acceptation Europe/Paris. Les événements de test sont explicitement marqués et leurs compteurs sont séparés des événements réels. Aucune présence de démonstration n’est créée par le seed.

## État de validation

**Le code et la démonstration technique ne constituent pas une validation juridique.** Responsable de traitement, bases articles 6/9, exemption article 82, nécessité d’AIPD/DPO, information/consentement, exercice des droits et petites cohortes restent à valider par le porteur avec un conseil compétent avant un pilote réel.

Le serveur refuse la publication et toute nouvelle inscription à un événement non-test tant que `REAL_EVENTS_APPROVED` n’est pas explicitement activé. Cette configuration n’est ni une preuve de conformité ni une mesure d’authentification administrateur. Elle évite un lancement réel accidentel avec le schéma du prototype.

Le schéma de démonstration ne prétend pas prouver un consentement. Aucun mécanisme de retrait individuel incomplet n’est présenté comme opérationnel. La décision E0 doit encore préciser secret de retrait/vérificateur, règles d’agrégat, concurrence avec des admissions, suppression et réapplication après restauration. Les migrations nécessaires doivent précéder la première collecte réelle.

Les coordonnées ne sortent pas du module de géolocalisation du client officiel. Le navigateur et son fournisseur de localisation, les connexions IP et le contrôle du client par son utilisateur restent des limites explicites.

## Rétentions techniques

- Présences : échéance fin + 48 h ; commande de purge idempotente prévue toutes les 15 minutes, avec réconciliation et marqueur atomiques.
- Géolocalisation : uniquement mémoire le temps du test ; aucun stockage persistant.
- Identité locale : clé conservée dans le navigateur, suppression manuelle possible ; durée cible de 12 mois et expiration sûre à décider avant utilisation durable.
- Signaux de limitation : HMAC éphémères, RAM bornée, expiration au plus une heure ; pas de liaison à la table de présences.
- Pages publiques cachées : 24 heures au maximum ; aucun POST ou statut individuel caché.
- Exploitation future : erreurs expurgées 7 jours, audit admin 6 mois, sauvegardes 7 jours selon le plan ; l’infrastructure locale ne simule pas une politique contractuelle d’hébergeur.

## À vérifier avant activation réelle

Tous les points E0/E12, téléphones réels, périmètre terrain, charge sur infrastructure cible, accès/roles DB restreints, backups/restauration, rétention de toutes les couches et tests de droits. La démo locale ne valide ni la capacité de 5 000 connexions en production ni la disponibilité du réseau mobile.
