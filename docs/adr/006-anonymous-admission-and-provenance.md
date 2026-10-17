# Protection anonyme des admissions et provenance

Décision du 17 octobre 2026, après audit d’intégrité. Elle remplace le choix initial de ne pas ajouter de challenge au pilote. L’objectif est d’augmenter le coût des faux comptages sans compte participant, fingerprint, CAPTCHA ou fournisseur de sécurité tiers, sans nouvelle infrastructure payante.

## Admission

Les trois mutations publiques (présence, soutien, création) exigent une preuve de calcul SHA-256 automatique. Le serveur signe un nonce aléatoire, une expiration à deux minutes, une difficulté et l’empreinte de l’action, de l’événement et de sa déclaration stricte. Le mode test/réel fait partie de l’engagement. La difficulté est de 18 bits par défaut, bornée à 16–20. Elle est publique et ne dépend d’aucune caractéristique ou télémétrie du terminal. Le solveur utilise une bibliothèque SHA-256 locale verrouillée, cède régulièrement la main et s’arrête après huit secondes ; aucun calcul n’est lancé pendant la consultation ou une simple vérification de statut.

La vérification serveur exige une signature valide, une déclaration identique, un mode identique, une preuve non expirée et le calcul attendu. La consommation du nonce s’effectue dans la transaction de contribution ou de création. Les rejeux du même événement/identifiant restent idempotents. Les vérifications privées de statut restent sans preuve et ne créent rien. Aucun chemin HTTP de compatibilité sans preuve n’est maintenu : les anciennes PWA doivent recharger la page.

`admission_claims` conserve seulement SHA-256(nonce) et son expiration. La table n’a aucune référence d’événement, IP ou identifiant participant. La purge des marqueurs expirés fait partie de la maintenance toutes les 15 minutes, sans garantie d’effacement à la seconde lors d’un incident. `SELECT, INSERT` suffisent au rôle public ; `DELETE` appartient à la maintenance. Appliquer `0005_admission_claims.sql` avant le code. Les fonctions serveur directement appelées par la maintenance et les tests restent des frontières internes de confiance ; toutes les routes publiques passent obligatoirement par la vérification.

Le secret de signature est aléatoire en RAM par défaut. Une seule instance n’a donc aucun secret supplémentaire à configurer ; son redémarrage invalide les challenges en cours, qui peuvent être redemandés. `ADMISSION_SECRET` permet un secret partagé si nécessaire, sans jamais l’envoyer au client. Les autres budgets restent locaux au processus : une seule instance demeure recommandée. Aucun Redis ou service facturé à la requête n’est ajouté.

## Ressources et contrôle opérateur

Les budgets de lecture du corps sont séparés des budgets DB : trois secondes, 2 Kio, 128 lectures simultanées au total et huit par réseau. Les budgets réseau seconde/minute et les plafonds globaux restent nécessaires après une preuve valide. Le cache d’identités ne peut plus remplir celui des réseaux pour bloquer toutes les identités nouvelles. Les flux SSE sont réservés avant lecture DB, plafonnés à 64 par réseau et expirent après cinq minutes, avec reconnexion et polling existants. Ces limites doivent être qualifiées sur les réseaux mobiles partagés ; elles n’établissent pas une identité.

Les cadences agrégées par événement/minute restent dix minutes en RAM dans une structure bornée à 500 événements. Les métriques sont protégées ; elles ne retiennent ni payload, ni IP, ni identifiant individuel. Le seuil de revue est indicatif et ne modifie jamais automatiquement un chiffre. La modération affiche présences et soutiens séparément. Les sessions admin sont révocables et une suppression exige de nouveau le mot de passe.

Les nouveaux rassemblements localisés résolvent le nom officiel de commune et vérifient que le centre public appartient à son contour, avant publication. Le cercle peut déborder dans une autre commune. Les rejeux historiques n’appellent pas le fournisseur et ne réécrivent pas le comptage. Cette vérification n’atteste pas l’existence de la manifestation. Les contours des communes entières restent obtenus côté serveur.

## Transparence et limites

La [chaîne de provenance](../code-provenance.md) construit un manifeste des entrées et fichiers générés, prépare une archive autonome et produit une attestation GitHub. Un contrôleur indépendant peut comparer l’archive aux fichiers installés, puis les fichiers publics effectivement servis. L’endpoint et la page de transparence sont exclus du cache PWA. Le mode natif Clever, qui reconstruit, ne doit pas être présenté comme l’archive GitHub attestée.

Le calcul ne prouve ni humanité, ni GPS, ni unicité d’une personne. Des clients natifs ou spécialisés peuvent le résoudre plus rapidement ; des appareils lents peuvent devoir recommencer. Un défi très difficile serait lui-même un refus de service : ne pas augmenter sa difficulté sans mesure sur téléphones accessibles. Un QR public et un cookie signé n’apporteraient pas non plus d’unicité humaine ; ils ne sont pas ajoutés comme fausses garanties.

Le serveur et l’hébergeur voient le transport des requêtes. Les identifiants sont pseudonymes ; l’absence de compte ou de fingerprint ne garantit pas un anonymat réseau absolu. La provenance des fichiers ne démontre pas la vérité des déclarations, la configuration réelle ou l’absence de modification de la base. Les protections d’accès et les incidents connus doivent accompagner l’interprétation des chiffres.
