# Soutiens à distance et choix quotidien

17 octobre 2026 — ajout d’un soutien sans compte ni géolocalisation, distinct de la participation déclarée dans un périmètre.

## Règles de comptage

Un soutien exprime un choix pour un événement ouvert ; il ne prouve aucune présence physique, y compris pour un comptage de commune entière. Les portées `gathering` et `city`, les modes test/réel et les fenêtres d’ouverture restent applicables. Le compteur principal additionne présences et soutiens, avec leur détail dessous ; les agrégats restent distincts. Ce total ne mesure ni une présence physique ni des humains uniques. Les familles rassemblement localisé et commune entière restent présentées séparément.

Une identité locale peut soutenir un seul événement par journée `Europe/Paris`, toutes portées confondues, et une seule fois un même événement sur toute sa durée. Le jour vient de l’horloge serveur. Minuit permet un choix pour un autre événement, mais pas un nouveau soutien de l’événement déjà soutenu. Aucun transfert vers un autre événement n’est proposé pour le choix du jour.

Présence et soutien sont exclusifs pour une même identité dans un même événement. Une présence déjà acceptée empêche d’ajouter un soutien. Une nouvelle présence acceptée remplace un soutien existant de façon atomique : suppression du soutien, diminution de son compteur et ajout de la présence avec son incrément. Un refus de présence ne retire pas le soutien. La conversion ne libère pas le choix quotidien déjà consommé. Une présence à un autre événement et un soutien restent possibles le même jour.

## Identité et données conservées

La clé aléatoire HMAC non exportable reste dans IndexedDB. Elle produit un identifiant par événement, partagé par les parcours de présence et de soutien de cet événement. Un second domaine de dérivation produit un marqueur de soutien par jour de Paris, commun aux événements du jour et différent les autres jours. Ni la clé ni un identifiant global commun aux événements et durable entre journées ne sont transmis. Aucun nom, e-mail, compte participant, GPS ou fingerprint n’est demandé pour le soutien.

`supports` conserve seulement `event_id`, l’identifiant événementiel et le jour de réception. `support_counters` conserve les agrégats de soutien par événement et jour, séparés des compteurs de présence. `daily_support_claims` conserve seulement le jour et le marqueur journalier, sans référence d’événement ni horodatage précis. Une contrainte unique sur ce couple empêche deux choix concurrents du même jour. Les opérations d’admission et les changements de compteurs sont transactionnels.

Les marqueurs des jours de Paris passés sont supprimés lors des demandes de soutien et par la tâche de purge habituelle. Les détails individuels événementiels suivent l’échéance fin + 48 h ; les agrégats de présence et de soutien restent conservés après réconciliation. La purge peut être retardée par un incident ou une incohérence. Les sauvegardes et journaux suivent des rétentions distinctes.

## Garanties et limites

Le dédoublonnage porte sur une identité de navigateur, jamais sur un humain certifié. L’effacement des données, un autre navigateur, plusieurs appareils ou un client modifié permettent de contourner ces règles. L’effacement local ne retire aucune présence, aucun soutien ni marqueur déjà reçu par le serveur. La navigation privée et les restrictions de stockage ont les mêmes limites que pour les présences.

Les identifiants sont pseudonymes. Le serveur observe les requêtes, dont l’événement et les marqueurs reçus ensemble. La séparation des tables réduit les données conservées mais ne rend pas toute corrélation impossible. L’infrastructure reçoit l’IP et peut journaliser le chemin de l’événement. Aucun anonymat absolu ni absence de traitement réseau n’est promis. Le soutien peut révéler les mêmes opinions ou convictions sensibles qu’une participation ; les décisions de confidentialité, de droits et de bases légales existantes restent applicables.

## Exploitation

La migration créant `supports`, `support_counters` et `daily_support_claims` doit précéder le déploiement du code. Le rôle public reçoit `SELECT, INSERT, DELETE` sur `supports`, `SELECT, INSERT, UPDATE` sur `support_counters` et `SELECT, INSERT, DELETE` sur `daily_support_claims`. Les restrictions existantes sur `presences` restent en place. Le rôle de maintenance assure purge et réconciliation.

La recette couvre les doubles soumissions, deux soutiens concurrents vers des événements différents, la frontière de jour de Paris, les événements sur plusieurs jours, les refus et succès de conversion, la conservation du choix quotidien après conversion, la purge et la séparation des agrégats. Les interfaces et documents doivent distinguer déclaration locale et soutien sans localisation.
