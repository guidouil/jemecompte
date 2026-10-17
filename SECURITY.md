# Sécurité et limites

Ce MVP est un comptage volontaire, pas un scrutin. L’unicité des présences porte sur un identifiant événementiel conservé. Pour les soutiens à distance, cet identifiant évite les doublons sur un événement et un marqueur journalier distinct limite une identité de navigateur à un événement soutenu par jour de Paris. Ce marqueur change chaque jour et est conservé séparément sans référence d’événement. Suppression du stockage, autre navigateur, plusieurs appareils, client modifié et faux GPS restent possibles : aucune unicité humaine n’est garantie.

Les soutiens ne demandent aucun GPS et ne prouvent aucune présence locale. Une présence acceptée remplace le soutien du même événement sans compter deux fois cette identité dans ses deux compteurs ; elle ne libère pas le choix de soutien déjà consommé ce jour-là. Une présence dans un autre événement reste autorisée. Le compteur principal additionne présence et soutien avec leur détail ; les agrégats restent distincts. Ce total ne mesure ni la présence physique ni des humains uniques.

Les identifiants sont pseudonymes. Le serveur peut observer les requêtes, y compris leur événement et les marqueurs reçus ensemble ; la séparation des tables n’empêche pas cette observation ni les corrélations réseau. Les marqueurs journaliers expirés sont supprimés par les demandes de soutien et la tâche de purge. Les détails événementiels suivent l’échéance fin + 48 h ; sauvegardes et journaux ont leurs rétentions propres.

Ne publiez aucune donnée participante, IP, clé locale, pseudonyme, dump ou requête contenant ces données dans un rapport de sécurité. Fournissez un scénario reproductible avec des événements et identifiants fictifs. Le porteur doit définir un canal privé de signalement avant le lancement public.

Gardez les dépendances verrouillées, les secrets hors Git, l’accès SSH et les rôles PostgreSQL séparés. Ne rendez jamais le serveur Node directement accessible si l’adresse client est lue dans un header de proxy. Ne journalisez ni bodies ni paramètres SQL.

Les événements réels sont désactivés par défaut. `REAL_EVENTS_APPROVED=true` exige une décision opérationnelle explicite après les validations de PLAN.md ; ce drapeau ne crée aucune conformité juridique.
