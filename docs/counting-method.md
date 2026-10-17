# Ce que compte JeMeCompte

Le compteur principal additionne les **participations déclarées acceptées par le service** et les **soutiens à distance**, avec le détail des deux catégories sous le total. Leurs agrégats restent distincts, dans les limites ci-dessous. Ce total ne mesure ni une présence physique ni des humains uniques. Un soutien exprime un choix sans vérifier une position ; il n’affirme aucune présence dans le périmètre. Deux portées sont distinguées : un rassemblement localisé dans son périmètre public, ou une commune entière. Aucune de ces portées ne constitue une estimation exhaustive de la foule, un décompte d'humains uniques ni une mesure des personnes encore présentes.

## Comptages de commune entière

Un comptage de ville couvre le contour administratif publié de la commune, y compris ses parties disjointes. Il ne désigne aucun lieu, parcours ou horaire de manifestation. Une personne située à son domicile dans la commune peut donc être admise : sa déclaration ne prouve pas une participation à une manifestation. Le compteur porte la mention « participations déclarées dans cette commune ».

Le lot du 17 octobre propose 20 grandes communes métropolitaines, de **7 h à 19 h en heure de Paris**, soit une fenêtre de comptage de 12 heures. Les contours de l'[API Geo](https://geo.api.gouv.fr/decoupage-administratif/communes) sont conservés sans simplification, îles et portions séparées comprises. Sources et empreintes sont disponibles dans le [lot de préparation](city-counts-17-octobre.md).

Depuis l'accueil, une commune correspondante exige un choix explicite avant la création de l'identité et l'envoi d'une participation. Sur sa page, le bouton indique « Me compter dans cette ville » et la portée est affichée avant l'action. Le serveur exige aussi un marqueur de portée `city` ; un ancien client qui ne connaît pas ce type de comptage ne peut pas l'ajouter implicitement. Ce marqueur ne constitue ni une preuve GPS ni une preuve de consentement juridique.

Les totaux des rassemblements localisés et ceux des communes entières sont calculés et affichés séparément, sans addition des deux familles. Une même personne peut contribuer à plusieurs événements, y compris dans les deux familles ; aucun de ces totaux ne mesure des personnes uniques.

## Découvrir un comptage

La recherche filtre localement le nom et la ville du catalogue chargé, sans accents. Le badge distingue « rassemblement » et « commune entière ». Les filtres temporels excluent les événements terminés, fermés, annulés ou non publiés. Un événement en pause reste visible avec son état. Le catalogue fourni contient au maximum 500 événements, en privilégiant ceux en cours puis à venir : son absence de résultat ne prouve pas l'absence d'un comptage ou d'un rassemblement.

« Autour de moi » demande explicitement un relevé ponctuel, sans suivi continu. La position, même approximative, reste dans la mémoire de la page. Elle n'est ni envoyée à JeMeCompte, ni inscrite dans l'URL, ni mise en stockage local. Un rayon de 5, 25 ou 100 km filtre et classe les résultats à partir du centre approximatif des périmètres. Cette distance à vol d'oiseau est indicative ; un centre de bbox peut notamment se situer hors d'un polygone concave. Elle ne vaut pas contrôle de présence. Le retrait du filtre ou sa réinitialisation ne demande aucun nouveau relevé.

## Création guidée publique

Le parcours commence par la recherche d'un événement existant pour limiter les doublons. Sans compte, le créateur choisit une commune : par défaut, son contour administratif officiel est chargé pour un comptage de commune entière. L'option rassemblement localisé permet de placer explicitement un centre public sur la carte. Il donne ensuite un nom au comptage. La création n'appelle pas le GPS et ne réutilise pas la position de découverte. Une confirmation explicite avertit que le nom, la commune, le centre, le périmètre et les horaires seront publics. Il ne faut pas y placer une adresse personnelle.

Pour un rassemblement localisé, le périmètre est un cercle dont le rayon est **réglable de 100 mètres à 10 kilomètres, avec 500 mètres par défaut**. Un rayon de 500 m couvre 1 km de large ; un rayon de 10 km couvre 20 km de large et environ 314 km². Une zone étendue peut inclure des personnes éloignées du rassemblement. Le chiffre porte donc sur les participations déclarées dans le périmètre choisi et ne garantit pas la présence physique au rassemblement, même lorsque le contrôle local de position réussit. Le périmètre public donne le contexte nécessaire pour lire ce chiffre.

Le comptage peut ouvrir immédiatement ou à une date et une heure de Paris choisies, pour **1, 2, 4, 8, 12, 24, 48 ou 72 heures**, avec 4 h par défaut. La durée mesure les heures réellement écoulées depuis le début retenu : 72 h correspondent à trois fois 24 h, sans remise à zéro quotidienne. Une même identité locale ne participe qu'une fois sur tout l'événement, même s'il dure plusieurs jours. Le formulaire public crée les deux portées avec une confirmation adaptée. Le serveur obtient lui-même le contour communal officiel ; aucun contour arbitraire n'est accepté depuis le navigateur.

Le label « Ouvert par un participant » indique une création communautaire, pas une vérification indépendante du rassemblement ou de son périmètre. Le classement technique de test reste appliqué tant que la collecte réelle n'a pas été validée et activée ; il ne constitue pas un badge public de vérification.

**Créer un événement ne crée aucune présence et n'incrémente aucun compteur.** Le créateur doit ensuite utiliser « Je me compte » dans les mêmes conditions que les autres participants. Aucun identifiant de participant n'est utilisé pour la création. Un identifiant de requête propre à cette création permet de réessayer sans ouvrir plusieurs événements après une réponse perdue ; il ne sert pas d'identité permanente du créateur.

Les tuiles du fond IGN, la recherche de communes et leurs contours officiels transitent par le serveur JeMeCompte. Les fournisseurs reçoivent l'IP du serveur ainsi que les références de tuiles ou le nom de commune, sans relais direct de l'IP du visiteur. L'infrastructure JeMeCompte reçoit néanmoins ces demandes et peut en déduire la zone consultée ; ce n'est pas le GPS privé du participant. Le cache cartographique est borné en RAM, avec une validité maximale de 24 heures, sans journal associant les cartes consultées aux IP ou aux présences. Les journaux du proxy et les durées de purge effectives doivent être vérifiés lors du déploiement.

La création possède des limites séparées du comptage, basées sur un HMAC temporaire d'IP avec une clé éphémère, en RAM et sur une fenêtre d'une heure. Ce signal n'est pas associé à l'événement en base, à une identité locale ou à un parcours entre rassemblements. Il freine certains abus sans certifier une personne ni empêcher tous les doublons ou toutes les créations malveillantes.

## Une participation

Après un clic volontaire, le navigateur demande ou utilise sa permission de géolocalisation pour un relevé ponctuel. Le client officiel vérifie la précision puis le polygone public de l'événement. Les coordonnées restent en mémoire le temps du test et ne figurent pas dans la requête à JeMeCompte. Le fournisseur de localisation du navigateur peut avoir son propre traitement ; le service ne le contrôle pas.

Une clé aléatoire locale produit un identifiant propre à l'événement. Le serveur refuse une seconde insertion du même couple événement/identifiant. L'insertion et l'incrément SQL sont atomiques ; un nouvel affichage « compté » exige un commit serveur. Le jour d'acceptation provient de l'heure PostgreSQL dans le fuseau `Europe/Paris`.

Le compteur d'événement est cumulatif sur toute sa durée, même s'il traverse minuit. Le changement de jour ne réinitialise ni ce compteur ni l'unicité du couple événement/identifiant. Le détail des participations du jour, au niveau national ou d'une ville, additionne les participations nouvellement acceptées ce jour français, **uniquement dans la même famille de portée**. Le compteur principal y ajoute les soutiens du jour, dont l'agrégat reste séparé. Une même personne participant à deux événements peut être comptée deux fois dans le total de sa famille. Les identifiants de présence ne permettent pas de la reconnaître entre événements ; le marqueur quotidien des soutiens décrit ci-dessous a une portée distincte.

Les événements fictifs conservent un classement technique séparé. Leurs agrégats nationaux et par ville sont séparés de ceux des événements réels. Le seed de démonstration ne crée aucune présence.

## Un soutien à distance

Le soutien est possible pendant la fenêtre d’ouverture du comptage, sans compte, nom, e-mail ni géolocalisation. Il concerne aussi bien un rassemblement localisé qu’une commune entière, sans affirmer que la personne se trouve dans cette zone.

Une identité locale peut soutenir **un seul événement par journée de Paris**, toutes portées confondues, et **une seule fois un même événement sur toute sa durée**. Le serveur décide du jour selon son horloge dans le fuseau `Europe/Paris`. Un événement qui traverse minuit ne peut donc pas recevoir un second soutien de cette identité le lendemain. Un autre événement peut être soutenu le jour suivant. Le choix du jour ne se transfère pas vers un autre événement.

Une identité déjà comptée présente dans un événement ne peut pas le soutenir en plus. Si elle a d’abord soutenu cet événement, une présence acceptée selon le parcours habituel remplace atomiquement son soutien : le compteur de soutien diminue et celui de présence augmente. Un refus ou un échec du contrôle de présence laisse le soutien inchangé. Le choix de soutien déjà consommé reste bloqué pour la journée concernée après conversion. Une présence à un autre événement et un soutien le même jour restent autorisés.

Le secret local existant produit le même identifiant événementiel pour la présence et le soutien. Il produit aussi un marqueur de soutien propre à la journée de Paris, commun aux événements de cette journée. Le serveur ne reçoit jamais le secret. Le marqueur journalier est conservé dans une table distincte qui contient seulement le jour et le marqueur, sans événement ni heure précise. Il sert à refuser un deuxième choix du jour, sans identifiant global commun aux événements et durable entre journées. Cela ne prouve pas une identité humaine : plusieurs appareils, un autre navigateur, l’effacement du stockage ou un client modifié peuvent contourner ces limites.

Le compteur principal additionne participations et soutiens, avec le détail de chaque catégorie dessous. Les agrégats de soutien restent séparés des participations, des autres portées et du mode test/réel. Le total ne doit être présenté ni comme une mesure de présence physique ni comme un décompte d’humains uniques. Les soutiens n’ont aucune signification géographique, même lorsqu’ils sont affichés sur la fiche d’une commune.

Les lignes individuelles de soutien contiennent l’événement, son identifiant pseudonyme et le jour de réception. Elles suivent la même échéance de purge que les présences : fin d’événement + 48 h. Les agrégats sont conservés séparément. Les marqueurs journaliers des jours de Paris passés sont supprimés par les demandes de soutien et par la tâche de purge habituelle ; cette suppression n’est pas garantie à la seconde du passage à minuit. Les sauvegardes ont une rétention distincte. Le serveur peut observer les requêtes : conserver les marqueurs séparément ne garantit pas l’impossibilité de corrélations, notamment par le réseau. Voir [ADR 005](adr/005-remote-supports.md).

## Limites à conserver dans toute communication

- Effacer IndexedDB, utiliser un autre navigateur, la navigation privée ou plusieurs appareils peut produire plusieurs identités.
- Un client modifié peut falsifier le résultat de géofence ou le GPS et appeler directement l'API. La déclaration « dans la zone » n'est pas une preuve vérifiable de présence.
- Des limites réseau temporaires et la détection d'anomalies freinent certains abus ; elles n'identifient ni un humain ni tous les bots. Une anomalie est un motif d'investigation, pas une mesure chiffrée de fraude.
- Les personnes sans téléphone, réseau, permission GPS ou volonté de participer ne sont pas représentées.
- Les snapshots publics ont quelques secondes de retard ; en réseau dégradé, l'affichage peut être plus ancien. Une nouvelle participation hors ligne ne reçoit aucun crédit local et n'est pas admise rétroactivement après clôture.
- Une panne catastrophique peut faire perdre des participations pourtant confirmées selon le point de restauration disponible. Toute correction ou perte connue doit être expliquée publiquement.

Le détail événementiel de dédoublonnage des présences et soutiens est purgé à l'échéance proposée `endsAt + 48 h`, avec un passage prévu toutes les 15 minutes. Les agrégats finalisés restent conservés ; après purge, le service ne peut plus répondre si un ancien identifiant individuel avait participé. Les sauvegardes ont une rétention distincte à configurer.

Le code est ouvert sous licence MIT. La transparence inclut protocole, définition des chiffres, périmètres, incidents et rétentions ; elle n'autorise jamais la publication des lignes individuelles de présences. Les décisions de confidentialité et de droits encore ouvertes figurent dans [ADR 001](adr/001-product-and-privacy.md).

## Protection locale et examen des afflux

Une nouvelle présence, un soutien ou une création exige désormais une preuve de calcul SHA-256 automatique, sans service tiers ni CAPTCHA. Un challenge signé expire en deux minutes, est lié à la déclaration exacte et au mode de collecte, et ne peut être dépensé qu’une fois dans la transaction d’admission. La difficulté publique est de 18 bits par défaut (bornes 16–20). Le calcul s’exécute uniquement après une action explicite, rend la main à l’interface et s’arrête après huit secondes. Il n’envoie ni durée, ni caractéristiques du terminal, ni GPS. Les consultations et vérifications de statut n’en exigent pas. Les clients anciens doivent recharger la page pour participer : aucun chemin d’admission sans preuve n’est conservé.

La base conserve seulement l’empreinte d’un nonce consommé et son expiration, sans événement, IP ou identifiant participant. La purge planifiée supprime les marqueurs expirés. Les taux de demandes et contributions par événement/minute sont gardés dix minutes en RAM pour investigation, sans retracer un participant. Une cadence inhabituelle ne démontre pas une fraude et ne modifie pas automatiquement les totaux. Le back-office affiche désormais séparément présences, soutiens et somme.

La preuve de calcul augmente le coût d’une identité inventée ; elle ne rend pas l’identité civile, la position ou l’unicité humaine vérifiables. Une campagne disposant de plusieurs appareils ou d’outils spécialisés peut encore contourner ces freins. Les totaux doivent toujours être présentés comme des déclarations et soutiens, avec les incidents connus et le périmètre. La correspondance avec les sources GitHub se contrôle séparément par la [chaîne de provenance](code-provenance.md).
