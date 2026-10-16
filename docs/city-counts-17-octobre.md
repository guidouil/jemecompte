# Préparer les comptages de ville du 17 octobre 2026

Le [manifeste](../data/events/2026-10-17-cities.json) contient 20 configurations avec UUID et liens stables pour des comptages réels, un par commune, de **7 h à 19 h le 17 octobre 2026, heure de Paris** (`05:00Z` à `17:00Z`). Le périmètre est toute la commune : il ne désigne aucun lieu ou parcours et ne confirme aucun rassemblement. La création communautaire reste accessible et conserve ses propres périmètres.

Villes préparées : **Paris, Marseille, Lyon, Toulouse, Nice, Nantes, Montpellier, Strasbourg, Bordeaux, Lille, Rennes, Toulon, Reims, Saint-Étienne, Le Havre, Villeurbanne, Dijon, Angers, Grenoble et Nîmes.** La présence de ces configurations dans le dépôt ne les importe ni ne les publie.

Les communes sont sélectionnées sur leur population municipale INSEE 2023, dans les limites territoriales de 2025, populations en vigueur en 2026. Les [sources](../data/events/2026-10-17-cities.sources.json) consignent les URL publiques, centres administratifs et empreintes SHA-256 des contours API Geo conservés sans simplification. Marseille, Toulon et Saint-Étienne ont un `MultiPolygon` ; aucun territoire insulaire ou disjoint n'est remplacé par un cercle ou supprimé. Les centres sont des données administratives et ne sont pas des lieux de manifestation.

La commande commence toujours par valider le manifeste et les empreintes. **Sans option, elle n'ouvre aucune connexion DB et n'écrit rien** :

```sh
npm run cities:prepare
```

Après revue des 20 configurations, utiliser l'environnement administratif choisi explicitement. La commande suivante importe le lot entier en **brouillons**, sans participation et sans activer la collecte réelle :

```sh
npm run cities:prepare -- --apply --reason 'Préparation revue des vingt comptages communaux du 17 octobre'
```

Une réexécution identique ne change ni versions, ni dates de mise à jour, ni audit. Toute divergence de configuration, collision d'UUID/lien, identité déjà utilisée dans le mode test ou état incompatible annule le lot entier. La commande ne remplace même pas un brouillon différent : résoudre et relire la divergence avant de poursuivre. Un lot publié et identique peut être relu/importé sans changement ; un comptage suspendu, clôturé ou finalisé n'est pas rouvert.

La publication est une **action séparée**, après import et décision d'ouverture consignée dans le [runbook](runbook-17-octobre.md). Elle exige que l'environnement administratif ait déjà `REAL_EVENTS_APPROVED=true` ; la commande ne définit ni ne modifie ce drapeau. Elle refuse un lot incomplet ou un brouillon expiré et publie atomiquement les brouillons exacts :

```sh
npm run cities:prepare -- --publish --reason 'Ouverture décidée et recette cible vérifiée pour le 17 octobre'
```

Pour un autre manifeste relu, fournir ensemble ses configurations et ses sources : `--file CHEMIN.json --sources SOURCES.json`. `--apply`, `--publish` et `--dry-run` sont mutuellement exclusifs. Les tests d'intégration nécessitent une `TEST_DATABASE_URL` dédiée dont le nom se termine par `_test` ; ils ne déduisent jamais une base de test de l'URL de production. La présence de ces fichiers dans le dépôt n'atteste ni un import ni une publication en production.
