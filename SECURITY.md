# Sécurité et limites

Ce MVP est un comptage volontaire, pas un scrutin. L’unicité porte sur un identifiant événementiel conservé ; suppression du stockage, plusieurs appareils, client modifié et faux GPS restent possibles.

Ne publiez aucune donnée participante, IP, clé locale, pseudonyme, dump ou requête contenant ces données dans un rapport de sécurité. Fournissez un scénario reproductible avec des événements et identifiants fictifs. Le porteur doit définir un canal privé de signalement avant le lancement public.

Gardez les dépendances verrouillées, les secrets hors Git, l’accès SSH et les rôles PostgreSQL séparés. Ne rendez jamais le serveur Node directement accessible si l’adresse client est lue dans un header de proxy. Ne journalisez ni bodies ni paramètres SQL.

Les événements réels sont désactivés par défaut. `REAL_EVENTS_APPROVED=true` exige une décision opérationnelle explicite après les validations de PLAN.md ; ce drapeau ne crée aucune conformité juridique.
