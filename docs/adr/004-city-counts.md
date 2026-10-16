# Portée communale des comptages

Le 16 octobre 2026, l'utilisateur choisit de conserver la création communautaire et de préparer des comptages couvrant toute la ville pour le 17 octobre, à partir de 7 h pendant 12 heures. Il confirme explicitement la portée « toute la ville », avec affichage de cette portée.

## Modèle et lecture des chiffres

`counting_scope` distingue `gathering` (valeur des événements existants et des créations publiques) et `city` (commune entière préparée par administration). La distinction est une donnée explicite ; elle n'est déduite ni du nom ni de l'origine team/community. La migration additive `0003_counting_scope.sql` précède l'utilisation de ce code.

Une déclaration dans toute la commune ne démontre aucune présence à une manifestation : une personne chez elle peut satisfaire le périmètre. Les pages, résultats, boutons, QR et affiches nomment donc la commune entière et une fenêtre de comptage, sans présenter de lieu de manifestation confirmé. Les agrégats nationaux et municipaux filtrent à la fois le mode test/réel et la portée. L'accueil affiche deux familles distinctes, sans les additionner. L'unicité reste attachée à l'événement ; elle ne devient pas une unicité humaine entre familles ou entre communes.

## Géographie et parcours

Les 20 contours administratifs API Geo sont conservés sans simplification. Une commune peut être un Polygon ou un MultiPolygon, avec toutes ses portions disjointes. Les limites historiques des rassemblements restent 500 sommets et 50 Kio ; la portée communale administrative est bornée à 10 000 sommets au total et 250 Kio, sans trous ni recouvrement. Le formulaire public ne peut demander cette portée ni fournir de contour administratif arbitraire.

Depuis l'accueil, même un unique périmètre communal correspondant au GPS demande un choix avant identité et soumission. Un lien communal affiche la portée avant son bouton explicite. La requête d'admission communale doit inclure `countingScope: "city"` : les anciennes PWA ne peuvent pas admettre silencieusement une commune avec leur ancien libellé de rassemblement. GPS, précision et limites de confidentialité restent inchangés.

La création communautaire reste accessible. Les suggestions anti-doublon du formulaire excluent les comptages communaux, qui ont une autre portée ; le créateur peut toujours délimiter son rassemblement localisé.

## Lot et exploitation

Le lot décrit 20 grandes communes métropolitaines pour le 17 octobre 2026, de 07:00 à 19:00 Europe/Paris (`05:00Z` à `17:00Z`). Les UUID, liens et empreintes des géométries sont stables. Le dry-run ne lit aucune base ; l'import explicite est atomique, crée uniquement des brouillons et ne crée aucune présence. Un rejeu identique ne change ni versions ni audits. Les collisions et divergences sont refusées ; une publication est séparée et conserve le garde d'approbation réel.

Le [guide du lot](../city-counts-17-octobre.md) donne les commandes. Ces fichiers ne constituent ni une publication ni une activation. La recette du pilote, le réseau mobile, la capacité de l'hébergement et les décisions de droits/retrait restent des conditions distinctes.
