# Backoffice privé `/gui`

Le backoffice permet à l’opérateur de consulter les comptages et d’en supprimer un avec ses participations. Il utilise une connexion par mot de passe, sans création de compte public. Son chemin n’est pas un secret : l’authentification et les contrôles serveur protègent les opérations.

## Configuration

Configurer dans le gestionnaire privé de l’hébergeur les deux variables suivantes :

- `ADMIN_PASSWORD_HASH` : empreinte scrypt produite par la commande dédiée.
- `ADMIN_SESSION_SECRET` : secret aléatoire propre à cette instance, d’au moins 32 octets, conservé dans le gestionnaire de secrets.

Lancer `npm run admin:password` dans un terminal privé. La commande demande un mot de passe de 16 à 256 caractères, masque la saisie puis demande confirmation. Elle accepte aussi l’entrée standard pour une utilisation non interactive ; le mot de passe ne doit jamais être passé comme argument de commande. Elle produit les deux affectations `ADMIN_PASSWORD_HASH` et `ADMIN_SESSION_SECRET`, avec un nouveau secret aléatoire de session. Copier leurs valeurs dans le gestionnaire privé de l’hébergeur. L’outil ne modifie aucun fichier d’environnement et ne configure pas automatiquement la production. Sa sortie contient des informations sensibles : ne pas l’enregistrer dans un journal public, un ticket, une capture ou Git.

Une configuration absente ou invalide ferme l’accès. Utiliser l’origine HTTPS canonique configurée pour l’application. Vérifier les paramètres de confiance du proxy : l’adresse client servant aux limites de connexion ne doit pas provenir d’un en-tête arbitraire envoyé par le navigateur.

En développement, les pages ouvertes avec `localhost` ou `127.0.0.1` sont redirigées vers l’hôte local déclaré dans `ORIGIN`, à protocole et port identiques. Cela aligne l’adresse du formulaire, le cookie et le contrôle d’origine. Recharger un onglet déjà ouvert sur l’autre adresse avant de se connecter. Les requêtes POST restent strictement limitées à l’origine configurée.

La session expire après une heure au maximum ou quinze minutes sans requête privée authentifiée. Son cookie est `HttpOnly`, `SameSite=Strict`, limité au chemin `/gui`, et `Secure` en HTTPS. Il ne doit pas être stocké dans `localStorage`. La déconnexion révoque la session côté serveur puis efface le cookie ; une copie du jeton ne fonctionne plus. Une nouvelle connexion révoque le précédent jeton de ce navigateur. La signature est liée à l’empreinte du mot de passe et au secret : remplacer l’une ou l’autre variable invalide automatiquement toutes les sessions existantes.

Les sessions actives restent dans une mémoire bornée à 128 sessions, sans base ou service supplémentaire. Un redémarrage les invalide et oblige à se reconnecter. Ce fonctionnement exige **une seule instance applicative** ; avant d’en ajouter, partager le registre et les limites de connexion dans un stockage adapté. Le mot de passe est demandé à nouveau à chaque suppression. La connexion et la suppression ont chacune une limite de cinq tentatives par réseau et par minute ; elles partagent un plafond de trente tentatives par minute et un seul calcul scrypt simultané. Un jeton volé seul ne suffit donc pas à supprimer un comptage.

## Rôle PostgreSQL administratif

`ADMIN_DATABASE_URL` permet d’utiliser un rôle distinct pour le backoffice. Cette URL doit cibler **la même base et le même environnement que l’application**, avec des identifiants différents, et rester dans le gestionnaire privé de l’hébergeur. Si elle est absente, le backoffice utilise la connexion applicative existante ; une permission manquante doit être résolue en configurant le rôle administratif, sans élargir le rôle public. Le pool administratif est distinct et limité à deux connexions.

Prévoir `CONNECT` sur la base, `USAGE` sur le schéma concerné et les droits limités aux opérations du backoffice :

- `SELECT` sur les colonnes de métadonnées d’`events` utilisées par la liste, la recherche et le verrouillage ; `UPDATE(updated_at)` sur `events` permet le verrouillage `FOR UPDATE` sans donner de droit de modification sur les chiffres.
- `SELECT(event_id)` sur `presences`, pour compter et sélectionner les lignes à supprimer ; aucun accès à `anonymous_event_id` n’est nécessaire.
- `SELECT(event_id, count)` sur `event_counters`, pour compter et additionner les chiffres à supprimer.
- `SELECT(event_id)` sur `supports` et `SELECT(event_id, count)` sur `support_counters`, pour afficher et supprimer les soutiens, sans lire leurs identifiants individuels.
- `DELETE` sur `events`, `presences`, `event_counters`, `supports` et `support_counters`. Le backoffice n’a besoin d’aucun droit sur `daily_support_claims`.
- `SELECT(event_id)` et `UPDATE(event_id)` sur `admin_audit`, pour détacher l’historique avant la suppression de l’événement ; `INSERT` sur les colonnes nécessaires au nouvel audit.
- `USAGE` sur la séquence de l’identifiant d’`admin_audit`, pour enregistrer cet audit.

Les métadonnées d’`events` lues actuellement sont `id`, `slug`, `name`, `city_name`, `starts_at`, `ends_at`, `status`, `is_test`, `counting_scope` et `created_at`. Les colonnes d’audit insérées sont `event_id`, `operator`, `action`, `reason` et `configuration`. Ajuster ces autorisations si les requêtes évoluent ; ne pas attribuer `SUPERUSER`, la propriété du schéma ou un rôle de migration au backoffice. Les droits `SELECT` sur une colonne lue dans une condition restent nécessaires même lorsqu’un droit d’écriture est présent. Voir les règles PostgreSQL pour [UPDATE](https://www.postgresql.org/docs/current/sql-update.html) et les [verrouillages SELECT](https://www.postgresql.org/docs/current/sql-select.html).

## Suppression

La liste distingue les présences, les soutiens à distance et leur total ; les quantités individuelles encore conservées sont indiquées séparément. Relire le nom, la ville et l’identité publique du comptage avant de confirmer sa suppression en recopiant son lien court (`slug`) et en saisissant le mot de passe privé. L’opération serveur vérifie la session, le mot de passe et l’origine de la requête POST. Elle supprime atomiquement l’événement, toutes ses participations et ses compteurs associés ; elle ne crée aucune présence et ne réaffecte pas les participations à un autre comptage. La trace administrative est conservée sans identifiant de participant. Le mot de passe de confirmation n’est jamais renvoyé dans les données d’action et le champ est vidé après réponse.

Cette interface supprime uniquement un comptage entier avec son ensemble de participations. Elle ne liste pas les participants et ne permet pas de supprimer individuellement une participation.

La suppression affecte les totaux publics. Les clients connectés doivent recevoir les nouveaux agrégats, y compris lorsqu’ils diminuent. Les suppressions en base active ne constituent pas une purge immédiate des sauvegardes ou des journaux de l’hébergeur ; leurs durées restent celles de l’exploitation du service.

## Cache et accès hors connexion

Toutes les réponses `/gui`, y compris données SvelteKit, erreurs et redirections, doivent porter `Cache-Control: no-store`. Le service worker exclut explicitement `/gui` et ses descendants, `/gui/__data.json`, les requêtes d’action avec paramètres et, par précaution, l’ancien préfixe `/admin`. Il n’enregistre ni page administrative ni réponse publique redirigée vers le backoffice ; il ne propose aucun contenu administratif hors connexion.

Une génération de cache distincte invalide les anciens caches applicatifs lors de l’activation du nouveau service worker. L’activation nettoie aussi toute ancienne entrée privée du cache conservé. Le service worker attend normalement la fermeture des anciens clients avant activation : la nouvelle politique est effective après mise à jour du worker. Les cookies de session et les réponses HTTP privées restent soumis aux contrôles serveur et aux en-têtes `no-store` indépendamment du worker.
