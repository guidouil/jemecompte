# Sécurité et limites

Ce MVP est un comptage volontaire, pas un scrutin. L’unicité des présences porte sur un identifiant événementiel conservé. Pour les soutiens à distance, cet identifiant évite les doublons sur un événement et un marqueur journalier distinct limite une identité de navigateur à un événement soutenu par jour de Paris. Ce marqueur change chaque jour et est conservé séparément sans référence d’événement. Suppression du stockage, autre navigateur, plusieurs appareils, client modifié et faux GPS restent possibles : aucune unicité humaine n’est garantie.

Les soutiens ne demandent aucun GPS et ne prouvent aucune présence locale. Une présence acceptée remplace le soutien du même événement sans compter deux fois cette identité dans ses deux compteurs ; elle ne libère pas le choix de soutien déjà consommé ce jour-là. Une présence dans un autre événement reste autorisée. Le compteur principal additionne présence et soutien avec leur détail ; les agrégats restent distincts. Ce total ne mesure ni la présence physique ni des humains uniques.

Les identifiants sont pseudonymes. Le serveur peut observer les requêtes, y compris leur événement et les marqueurs reçus ensemble ; la séparation des tables n’empêche pas cette observation ni les corrélations réseau. Les marqueurs journaliers expirés sont supprimés par les demandes de soutien et la tâche de purge. Les détails événementiels suivent l’échéance fin + 48 h ; sauvegardes et journaux ont leurs rétentions propres.

Ne publiez aucune donnée participante, IP, clé locale, pseudonyme, dump ou requête contenant ces données dans un rapport de sécurité. Fournissez un scénario reproductible avec des événements et identifiants fictifs. Le porteur doit définir un canal privé de signalement avant le lancement public.

Gardez les dépendances verrouillées, les secrets hors Git, l’accès SSH et les rôles PostgreSQL séparés. Ne rendez jamais le serveur Node directement accessible si l’adresse client est lue dans un header de proxy. Ne journalisez ni bodies ni paramètres SQL.

Les événements réels sont désactivés par défaut. `REAL_EVENTS_APPROVED=true` exige une décision opérationnelle explicite après les validations de PLAN.md ; ce drapeau ne crée aucune conformité juridique.

## Protections contre l’automatisation

Les API de présence, de soutien et de création exigent une preuve de calcul SHA-256 locale, signée par le serveur et liée à l’action, à l’événement, à la déclaration exacte et au mode test/réel. Elle expire après deux minutes. Un marqueur de consommation est inscrit dans la même transaction que la contribution ; un rollback ne dépense pas la preuve. Les anciennes API sans preuve sont refusées, sans exception pour les clients anciens. Les vérifications d’une contribution existante restent accessibles sans calcul.

Le calcul n’utilise aucun service tiers, CAPTCHA, fingerprint, compte, cookie supplémentaire ou mesure des caractéristiques du terminal. Sa difficulté est publique : 18 bits par défaut, configurable de 16 à 20. Le solveur local abandonne après huit secondes et rend régulièrement la main à l’interface. Les clients natifs et spécialisés conservent un avantage : ce coût freine l’automatisation, sans prouver l’humanité, la position ou l’unicité d’une personne. Aucun secret placé dans le navigateur ne peut fournir cette garantie.

Les marqueurs consommés ne contiennent que l’empreinte d’un nonce aléatoire et son expiration. Aucun événement, IP ou identifiant participant n’y est ajouté. Les marqueurs expirés sont supprimés par la purge planifiée toutes les 15 minutes. Le transport et le serveur peuvent observer les demandes : ni cette séparation ni les HMAC temporaires ne constituent un anonymat réseau absolu. Ne pas journaliser les bodies de `/api/admission` ou des autres API privées.

Les limites de réseau sont temporaires et restent dimensionnées pour un réseau mobile partagé. La lecture HTTP a un budget séparé des transactions ; les flux SSE ont un plafond par réseau et une durée finie. Les signaux d’activité par événement/minute restent dix minutes en RAM, sans identifiant individuel, et ne retirent jamais automatiquement des contributions. Ces protections sont locales au processus : conserver une seule instance tant que les budgets ne sont pas partagés. Des accès opérateur compromis ou une campagne distribuée peuvent encore fausser le chiffre.

La [preuve de provenance](docs/code-provenance.md) distingue l’archive attestée, les fichiers déployés et les déclarations de version du serveur. L’authenticité d’un programme ne démontre pas l’authenticité des participations ni celle de la base.
