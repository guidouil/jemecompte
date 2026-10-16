# Recette avant un pilote réel

La réussite d'une démonstration locale ne vaut pas autorisation de collecte réelle. Garder `REAL_EVENTS_APPROVED=false` tant que les éléments bloquants ne sont pas résolus.

## Décisions produit et confidentialité

- [ ] Responsable de traitement et opérateurs identifiés ; décisions E0 relues par un conseil compétent : bases légales, contexte sensible, article 82, analyse AIPD, information/consentement et petites cohortes.
- [ ] Procédure de droits/retrait décidée, implémentée et testée, y compris concurrence, agrégats, preuve proportionnée et restauration. Le prototype local ne la fournit pas encore.
- [ ] Notices publiques fidèles aux traitements réellement déployés ; code, méthode, licence, prestataires, durées et contact sécurité disponibles.
- [ ] Définition publique des compteurs validée : participations déclarées, aucune promesse d'unicité humaine ou de preuve GPS.

## Événement et téléphones

- [ ] Événement réel distinct des démonstrations et essais ; aucun participant fictif dans son chiffre. UUID, ville et protocole stables.
- [ ] Polygone préparé, validé puis testé à pied ; horaires et frontières compréhensibles. Géofence gelée ou suspendue/versionnée avant modification.
- [ ] Chrome/Android et Safari/iOS réels testés, plus Firefox et Brave ; refus de permission, mauvaise précision, hors zone, double clic, reprise après réponse perdue, clôture et stockage bloqué.
- [ ] Pas de permission avant clic ; gros bouton utilisable, contraste, zoom, clavier, VoiceOver/TalkBack et messages d'attente vérifiés.

## Infrastructure et capacité

- [ ] HTTPS canonique, Caddy seul devant Node, DB privée, comptes/roles distincts et privilèges réellement éprouvés.
- [ ] Corps lents/volumineux, budgets HTTP, pool borné, cache/coalescence, déconnexions SSE et NAT partagé testés sur la chaîne cible.
- [ ] Charge mesurée sur cette infrastructure avec enveloppe annoncée et rapport : débit, p95/p99, erreurs, mémoire, attente des verrous, reconnexion collective et fraîcheur. Les objectifs à 5 000 clients du plan ne sont pas des résultats déjà obtenus.
- [ ] Aucun GPS/pseudonyme/IP conservé dans logs, métriques, outils d'erreurs, CDN ou prestataire ; vérification par données sentinelles fictives.
- [ ] Purge fin + 48 h planifiée toutes les 15 minutes, code de retour et retard supervisés ; réconciliation et statut individuel expiré vérifiés.
- [ ] Sauvegardes/WAL chiffrés et rétention 7 jours vérifiée ; restauration isolée, purge préalable et epoch supérieur testés avec un ancien onglet ouvert.

## Exploitation le jour prévu

- [ ] Opérateur disponible, accès SSH testé, suspension/clôture et runbook répétés ; statut public préparé en cas d'incident.
- [ ] Recette finale sur événement fictif distinct, puis décision explicite d'ouverture réelle après levée des blocages. Activer le drapeau ne remplace aucune de ces validations.
- [ ] Après événement : clôture, réconciliation, purge constatée, revue agrégée de l'expérience et publication des limites/incidents affectant le chiffre.
