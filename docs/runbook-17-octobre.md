# Exploitation du 17 octobre 2026

Préparation au 16 octobre. Ce document est une procédure à exécuter et à consigner ; il n'atteste ni un déploiement vérifié, ni une capacité nationale, ni une validation juridique. Conserver les preuves propres à l'instance dans `ops/` ou les outils privés de l'hébergeur, sans secrets, IP, identifiants participants ni corps de requêtes.

Une vérification ponctuelle de JeMeCompte.fr a obtenu une réponse HTTPS 200 le 16 octobre. La recette fonctionnelle et de charge sur la chaîne cible reste à effectuer ; cette réponse seule ne qualifie pas le comptage, SSE ou les opérations de maintenance.

## Décision avant diffusion des liens et QR

- [ ] Les décisions et adaptations encore ouvertes de l'[ADR 001](adr/001-product-and-privacy.md) et de la [recette pilote](pilot-checklist.md) sont résolues, notamment droits/retrait et restauration. La notice décrit les traitements réellement exécutés. Garder la collecte réelle désactivée si ces conditions ne sont pas remplies.
- [ ] Un opérateur et son relais sont disponibles, leur accès à l'instance fonctionne et les commandes de pause/clôture ont été répétées sur un événement fictif isolé.
- [ ] Les événements retenus ont un UUID/lien stable, les horaires du 17 octobre en heure de Paris et un périmètre testé sur place. Aucun chiffre fictif ni événement d'essai n'apparaît dans le parcours public réel. Accueil, page événement, API et SSE présentent les mêmes agrégats réels.
- [ ] Pour le [lot des 20 communes](city-counts-17-octobre.md), migration `0003_counting_scope.sql` appliquée avant le nouveau code ; badges et boutons « commune entière », limites exactes et fenêtre 07 h–19 h vérifiés. Les totaux communaux ne sont pas ajoutés aux rassemblements localisés. Une ancienne PWA sans marqueur de portée ne peut pas inscrire une déclaration communale.
- [ ] Sur la chaîne d'hébergement cible : HTTPS canonique, origine, chaîne de proxys, migrations appliquées, TLS PostgreSQL et rôles distincts ont été vérifiés selon le [déploiement](deployment.md). La recette fictive est isolée des chiffres réels. Une seule instance applicative est utilisée.
- [ ] Android/Chrome et iPhone/Safari physiques passent : permission refusée, position imprécise, hors zone, double clic, réponse perdue, reconnexion et stockage bloqué. La confirmation vient du serveur ; une coupure réseau ne crée aucun crédit hors ligne.
- [ ] Une charge sur une infrastructure de recette équivalente établit l'enveloppe annoncée, erreurs, délais de confirmation, mémoire, connexions DB, fraîcheur des chiffres et reconnexion collective. Le test local à 5 000 lecteurs ne constitue pas cette preuve. Ne pas lancer le harness local sur la production.
- [ ] La purge toutes les 15 minutes a un passage réussi et une alerte d'échec. Sauvegardes/WAL, rétention et restauration isolée ont été vérifiés ; les logs de chaque couche ont été inspectés avec des données sentinelles fictives.

**Go** : les points ci-dessus ont une preuve et un responsable, et la décision d'ouverture est consignée. **No-go collecte réelle** : un point bloquant reste ouvert, une fixture contribue aux chiffres publics ou les compteurs divergent. Le changement de `REAL_EVENTS_APPROVED` ne remplace pas ces vérifications. Préférer un pilote limité à l'enveloppe mesurée ; reporter les nouveautés sans rapport avec ces critères.

## Surveillance pendant l'événement

Préparer une sonde HTTPS externe sur la page et le compteur public d'un événement retenu. Une réponse HTTP 200 de la page seule ne suffit pas : vérifier aussi le contenu, la réponse du compteur et l'évolution attendue. Vérifier SSE depuis l'extérieur puis son repli en polling. Les alertes doivent arriver à l'opérateur ; le dépôt ne les configure pas automatiquement.

Interroger `/internal/metrics` avec le jeton configuré dans le gestionnaire privé de supervision, jamais dans une URL ou un journal. Sans jeton valide, la réponse est 404. Échantillonner toutes les 30 secondes et comparer les différences entre deux relevés du même `startedAt` : les compteurs sont en RAM et repartent de zéro au redémarrage.

| Signal | Lecture et action |
| --- | --- |
| `httpResponses.write` et `.stream` | Catégories fixes ; `429` est exclu de `4xx`, `503` de `5xx`. Les écritures regroupent création, présence et statut individuel ; les flux comptent uniquement l'ouverture HTTP, pas leurs déconnexions ultérieures. |
| `unavailabilityReasons` | `write_capacity` / `stream_capacity` : plafond atteint ; `write_failure` / `stream_failure` : erreur inattendue ; `other` : autre réponse 503 instrumentée. Comparer aux catégories HTTP, au pool et aux sondes. Le total `unavailable` comprend aussi d'autres chemins instrumentés. |
| `database.queued`, `connections`, `idle` | Une file persistante avec des 503 demande d'examiner capacité et blocages DB. Ne pas augmenter les limites sans mesure. |
| `memoryBytes`, `realtime.connections`, `realtime.channels` | Comparer à l'enveloppe mesurée et à la limite mémoire de l'instance ; rechercher croissance continue et vagues de reconnexions. |
| `server_error`, `rate_limited`, délais des sondes | Détecter une dégradation et vérifier une participation fictive dans l'environnement de recette. Les métriques internes ne mesurent pas le délai complet sur le réseau mobile. |
| `integrity.events[].minutes` | Agrégats par événement public et minute : nouvelles présences, nouveaux soutiens, conversions connues, preuves refusées et défis émis. Les retries déjà acceptés ne sont pas de nouvelles admissions. Les conversions sont un sous-ensemble des présences, sans admission supplémentaire. |

`integrity.events[].review=true` signifie **à examiner**, dès 120 nouvelles présences et soutiens acceptés dans une minute d'un événement. Ce seuil est réglable côté serveur avec `INTEGRITY_REVIEW_PER_MINUTE`, entier de 10 à 100 000 ; une valeur absente ou invalide utilise 120. Un pic légitime peut dépasser ce seuil : aucun total n'est supprimé et aucune admission n'est arrêtée automatiquement. Comparer les courbes de défis, refus et admissions avec le contexte du rassemblement avant d'agir. Les conversions seules ne constituent pas un signal de fraude.

Ces agrégats ne contiennent ni IP, ni identifiant participant, ni défi, ni corps de requête. La mémoire conserve dix tranches d'une minute et au plus 500 événements récemment actifs. `integrity.evictions` signale que des événements ont été écartés sous pression mémoire ; l'absence d'un événement ou d'une alerte ne prouve donc pas l'absence d'abus. Cette supervision est remise à zéro au redémarrage et ne remplace pas l'export régulier des seuls agrégats par l'opérateur.

Les lectures de corps JSON sont limitées séparément des opérations DB : 128 lectures simultanées au total, huit par réseau partagé, et trois secondes pour terminer un corps de 2 Kio maximum. Les budgets de requêtes par réseau couvrent une seconde et une minute, avec une enveloppe globale entre événements. Les adresses IPv6 d'un même préfixe `/64` partagent ces budgets et les plafonds de connexions ; une adresse IPv4 représentée en IPv6 partage le budget de son écriture IPv4 habituelle. Ce regroupement est calculé sans DNS, puis transformé en HMAC éphémère en RAM ; le préfixe n'est pas enregistré en base. Un flux SSE dure au plus cinq minutes avant reconnexion ; un réseau partagé dispose de 64 flux simultanés, puis le client utilise son repli HTTP. Ces seuils protègent une instance et doivent être vérifiés pendant la recette sur les réseaux mobiles ; une IP partagée ne représente pas une personne. Les limiteurs restent en RAM : conserver une seule instance tant qu'ils ne sont pas partagés.

Les limites réseau des spectateurs (ouverture SSE, compteurs et vérifications de statut) utilisent des compteurs et une capacité de cache distincts de ceux des nouvelles demandes (défis, présences, soutiens et créations). Un afflux de lectures ou le repli SSE vers les lectures HTTP ne consomme donc pas le quota réseau d'admission du réseau partagé. Les plafonds de chaque catégorie restent appliqués ; cette séparation ne réserve pas une connexion PostgreSQL à chaque catégorie.

Seuils initiaux d'investigation, à ajuster pendant la recette : deux échecs de sonde consécutifs, une file DB non vide pendant deux minutes, ou plus de 5 % de réponses `503` + `5xx` parmi les écritures sur deux minutes. Un écart entre présences et compteur impose une pause immédiate. Les métriques couvrent les chemins instrumentés du processus ; les échecs du proxy et de la plateforme nécessitent leur propre supervision.

## Incident, pause et reprise

1. Consigner heure Paris, symptômes, chiffres publics et métriques agrégées. Aucun payload participant ni diagnostic SQL brut. Préparer un message public factuel sur l'indisponibilité ou les limites du chiffre.
2. Avec l'environnement administratif distinct et l'UUID exact, suspendre les admissions de l'événement affecté :

   ```sh
   npm run admin -- pause UUID --reason 'Incident du 17 octobre : investigation'
   npm run db:reconcile -- UUID
   ```

3. Examiner instance, proxy, DB et réseau. Une réconciliation `mismatch` n'est jamais corrigée en inventant un total. Ne pas additionner les retries ni les tentatives non confirmées.
4. Après correction et recette, reprendre uniquement un événement encore ouvert et non finalisé :

   ```sh
   npm run admin -- publish UUID --reason 'Incident résolu et recette vérifiée'
   ```

5. Si la confiance ou le fonctionnement ne sont pas rétablis, conserver la pause ou clôturer. Publier les limites/incidents qui affectent l'interprétation du chiffre.

Une restauration requiert une procédure isolée : appliquer les effacements/purges requis, vérifier la cohérence, augmenter `COUNTER_EPOCH` hors de la base restaurée, redémarrer processus et flux, puis vérifier la reprise avec un ancien onglet avant de rouvrir. Aucune réouverture si les données restaurées ne respectent pas les décisions de rétention/retrait.

## Clôture et suivi

Avec le rôle administratif, après décision de clôture :

```sh
npm run admin -- close UUID --reason 'Clôture du rassemblement du 17 octobre'
npm run db:reconcile -- UUID --finalize
```

Suivre ensuite la commande planifiée, exécutée avec le rôle de maintenance distinct :

```sh
npm run db:purge -- --expired
```

La purge est éligible à la fin de chaque événement + 48 heures, puis au passage suivant du cron. Vérifier son résultat et le marqueur d'expiration ; une réconciliation divergente bloque la purge et déclenche une investigation. Le DELETE applicatif ne purge pas les sauvegardes ou les logs de l'hébergeur. Conserver le bilan agrégé et les incidents, puis vérifier les rétentions convenues.
