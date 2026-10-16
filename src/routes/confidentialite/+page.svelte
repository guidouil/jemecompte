<script lang="ts">
  import { eraseLocalIdentity } from '#lib/client/identity';
  let confirmErase = $state(false);
  let erasing = $state(false);
  let eraseMessage = $state('');

  async function erase() {
    erasing = true;
    eraseMessage = '';
    try {
      await eraseLocalIdentity();
      confirmErase = false;
      eraseMessage = 'L’identité locale a été effacée de ce navigateur. Les éventuelles participations déjà reçues par le serveur ne sont pas supprimées par cette action.';
    } catch {
      eraseMessage = 'L’effacement n’a pas pu être confirmé. Vous pouvez réessayer ou utiliser les réglages du navigateur pour effacer les données de ce site.';
    } finally {
      erasing = false;
    }
  }
</script>

<svelte:head>
  <title>Confidentialité — JeMeCompte</title>
  <meta name="description" content="Les données utilisées par JeMeCompte, leurs durées de conservation, les limites de l’anonymat et votre contact pour exercer vos droits." />
</svelte:head>

<article class="information-page">
  <a href="/" class="back-link">← Retour au comptage</a>
  <p class="eyebrow">CONFIDENTIALITÉ</p>
  <h1>Compter.<br />Sans vous suivre.</h1>
  <p class="information-lead">Vous pouvez vous compter sans compte, sans donner votre nom, votre adresse e-mail ou votre numéro de téléphone. Votre position précise reste dans votre navigateur.</p>
  <p class="policy-date">Dernière mise à jour : <time datetime="2026-10-16">16 octobre 2026</time></p>

  <aside class="privacy-summary" aria-label="Les engagements essentiels">
    <p><strong>Pas de GPS enregistré.</strong> La vérification de votre position se fait sur votre appareil, sans suivi continu.</p>
    <p><strong>Pas de suivi publicitaire.</strong> Aucun outil de mesure d’audience, pixel marketing ou empreinte numérique de votre appareil.</p>
    <p><strong>Un comptage, pas un fichier de noms.</strong> Un identifiant temporairement conservé par événement permet d’éviter les doublons.</p>
  </aside>

  <nav class="privacy-navigation" aria-label="Sur cette page">
    <a href="#donnees">Données et durées</a>
    <a href="#hebergement">Hébergement</a>
    <a href="#droits">Vos droits et contact</a>
    <a href="#erase-heading">Effacer sur cet appareil</a>
  </nav>

  <section class="prose-section" aria-labelledby="responsable">
    <h2 id="responsable">Qui est responsable du service ?</h2>
    <p>JeMeCompte.fr est un projet porté en nom propre par <strong>Guillaume Darbonne</strong>, responsable du traitement des données du service. Pour toute question ou demande : <a href="mailto:guidouil@gmail.com">guidouil@gmail.com</a>.</p>
    <p>Les données servent à recevoir votre déclaration de présence, éviter qu’une même identité locale soit comptée plusieurs fois pour un événement, publier les compteurs et protéger la disponibilité du service. Elles ne sont ni vendues ni utilisées pour de la publicité ou du profilage commercial.</p>
  </section>

  <section class="prose-section" aria-labelledby="donnees">
    <h2 id="donnees">Quelles données, pour combien de temps ?</h2>
    <dl class="data-list">
      <div>
        <dt>Votre position précise</dt>
        <dd>Utilisée ponctuellement dans la mémoire du navigateur pour vérifier le périmètre ou rechercher les rassemblements proches. Le site ne la transmet pas à son serveur et ne l’enregistre pas. Aucun historique de déplacement n’est constitué.</dd>
      </div>
      <div>
        <dt>Votre participation</dt>
        <dd>Le serveur conserve trois éléments : l’événement, un identifiant pseudonyme propre à cet événement et le jour du comptage. Cette ligne ne contient ni nom, ni IP, ni coordonnées GPS, ni heure précise de participation.<span class="retention">Suppression programmée à partir de 48 heures après la fin de l’événement ; les totaux sont conservés.</span></dd>
      </div>
      <div>
        <dt>Le secret de votre navigateur</dt>
        <dd>Créé aléatoirement sur votre appareil, il permet de retrouver le même identifiant pour un événement. Ce secret n’est pas envoyé au serveur.<span class="retention">Conservé dans le stockage du navigateur, sans expiration automatique, jusqu’à son effacement par vous ou par le navigateur.</span></dd>
      </div>
      <div>
        <dt>Les signaux de protection</dt>
        <dd>L’application utilise temporairement l’IP et l’identifiant pseudonyme de participation, dans le contexte de l’événement, pour limiter les requêtes excessives. Les signaux calculés restent en mémoire et ne sont pas enregistrés avec les participations.<span class="retention">Fenêtres de limitation allant jusqu’à une heure. Les entrées expirées sont nettoyées lors de l’activité du service ou à son redémarrage, sans archivage en base.</span></dd>
      </div>
      <div>
        <dt>Les événements et leurs compteurs</dt>
        <dd>Nom, commune, description éventuelle, périmètre, horaires et totaux sont publics. La création ne conserve pas de compte ou d’identité de créateur.<span class="retention">Conservés sans échéance automatique, pour garder les résultats et le contexte du comptage.</span></dd>
      </div>
      <div>
        <dt>Les actions d’administration</dt>
        <dd>Un journal distinct conserve l’opérateur, le motif et les modifications des événements pour leur gestion. Il ne constitue pas un historique des participants.<span class="retention">Suppression des entrées de plus de six mois lors de la tâche de purge.</span></dd>
      </div>
    </dl>
    <p>La tâche de purge s’exécute toutes les 15 minutes. Un incident ou une incohérence des compteurs peut retarder une suppression et nécessiter une intervention : 48 heures est l’échéance prévue, pas une garantie d’effacement à la seconde près. Les copies de sauvegarde ont un cycle de conservation distinct, décrit ci-dessous.</p>
    <p><strong>« Sans compte » ne signifie pas « aucune donnée stockée ».</strong> L’identifiant change d’un événement à l’autre et n’est pas votre identité civile. Il reste cependant une donnée pseudonyme tant qu’il est conservé. Nous ne promettons pas un anonymat absolu ni l’impossibilité de toute corrélation, notamment par les données réseau.</p>
  </section>

  <section class="prose-section" aria-labelledby="localisation">
    <h2 id="localisation">La localisation reste sur votre appareil</h2>
    <p>Après votre action et l’autorisation du navigateur, le site compare votre position au périmètre public de l’événement. Le serveur reçoit le résultat de cette vérification, l’identifiant propre à l’événement et les versions du protocole et du périmètre ; il ne reçoit pas le point GPS.</p>
    <p>« Autour de moi » calcule également les distances sur votre appareil. La position n’est pas ajoutée à l’adresse de la page ni au stockage du site. Les filtres s’appliquent localement au catalogue chargé, limité à 500 rassemblements.</p>
    <p>Le navigateur, le système de votre téléphone et leur fournisseur de localisation peuvent traiter des données pour déterminer votre position, selon leurs propres règles. L’autorisation native de géolocalisation est une permission technique ; elle ne remplace pas un éventuel consentement juridique au traitement d’une participation.</p>
  </section>

  <section class="prose-section" aria-labelledby="navigateur">
    <h2 id="navigateur">Ce qui reste dans votre navigateur</h2>
    <p>Le secret local sert uniquement à l’unicité par événement. Aucun cookie publicitaire, identifiant de suivi entre sites, outil de fingerprinting ou Google Analytics n’est intégré. Les polices et les ressources de l’interface sont servies par JeMeCompte.</p>
    <p>La PWA peut conserver des fichiers et des pages publiques consultées pour fonctionner en réseau dégradé. Les pages et compteurs peuvent être réaffichés hors connexion pendant 24 heures après leur mise en cache ; ce délai ne garantit pas la suppression physique de tous les fichiers à 24 heures. Le cache ne contient pas de position GPS ni de file d’attente de participations.</p>
    <p>Ces pages peuvent révéler les rassemblements consultés à une personne ayant accès à votre appareil. Le bouton en bas de cette page efface seulement le secret local. Pour supprimer aussi les pages et fichiers en cache, utilisez l’effacement des données du site dans les réglages du navigateur.</p>
  </section>

  <section class="prose-section" aria-labelledby="hebergement">
    <h2 id="hebergement">Hébergement, journaux et sauvegardes</h2>
    <p>L’application et sa base de données sont hébergées chez <a href="https://www.clever-cloud.com/" rel="noreferrer">Clever Cloud</a>, dans la région de Paris, en France. Le responsable du service et les personnes habilitées chez l’hébergeur peuvent accéder aux données nécessaires à leurs missions techniques. Aucune liste de participants n’est publiée.</p>
    <p><strong>L’infrastructure reçoit votre adresse IP.</strong> Les journaux d’accès de Clever Cloud peuvent contenir l’IP, une localisation approximative déduite de celle-ci, la date, la méthode et le chemin de la requête. Ce chemin peut indiquer l’événement consulté. Il ne s’agit pas de votre position GPS. Ces journaux sont distincts des lignes de participation et des signaux temporaires de l’application.</p>
    <p>La <a href="https://www.clever.cloud/developers/doc/develop/observability/logs/" rel="noreferrer">documentation de Clever Cloud</a> annonce une conservation habituelle des journaux de sept jours, avec des exceptions possibles. <strong>La durée effective de l’ensemble des journaux d’accès et d’infrastructure de ce site reste à confirmer auprès de l’hébergeur.</strong> Ils ne suivent pas la purge des participations à 48 heures. Leur contenu est décrit dans la <a href="https://www.clever.cloud/developers/doc/develop/observability/access-logs/" rel="noreferrer">documentation des journaux d’accès</a>.</p>
    <p>Des sauvegardes de la base sont prévues chez l’hébergeur. La <a href="https://www.clever.cloud/developers/doc/deploy/databases/postgresql/#database-daily-backup-and-retention" rel="noreferrer">politique PostgreSQL par défaut de Clever Cloud</a> prévoit une sauvegarde quotidienne conservée sept jours. Une participation supprimée de la base active peut donc encore figurer dans une copie antérieure jusqu’à sa rotation. La configuration effective et la procédure de restauration restent à vérifier ; nous ne présentons pas ces copies comme immédiatement effacées ni leur chiffrement comme vérifié.</p>
  </section>

  <section class="prose-section" aria-labelledby="creation">
    <h2 id="creation">Si vous créez un rassemblement</h2>
    <p>Vous placez vous-même un point sur la carte et confirmez sa publication. La création ne demande pas votre GPS et ne reprend pas la position utilisée pour une recherche de proximité. <strong>Le lieu et les informations saisis deviennent publics.</strong> Choisissez un lieu public et ne renseignez pas d’adresse privée ou d’informations personnelles sur d’autres personnes. Créer un événement ne vous compte pas automatiquement.</p>
    <p>Les recherches de communes passent par notre serveur vers l’API Découpage administratif (<a href="https://geo.api.gouv.fr/decoupage-administratif/communes" rel="noreferrer">geo.api.gouv.fr</a>) et le fond de carte provient de l’<a href="https://geoservices.ign.fr/" rel="noreferrer">IGN</a>. Ces fournisseurs reçoivent l’IP de notre serveur ainsi que la commune recherchée ou les références des tuiles demandées, sans transmission directe de votre IP. Notre infrastructure peut, elle, voir la zone de carte demandée.</p>
    <p>Les réponses sont mises en cache en mémoire sur le serveur : validité d’une heure pour les communes et de 24 heures pour les tuiles. Les entrées peuvent rester en mémoire jusqu’à leur remplacement, leur éviction ou un redémarrage. Ces caches ne contiennent pas d’identifiant de participant.</p>
  </section>

  <section class="prose-section" aria-labelledby="limites">
    <h2 id="limites">Ce que le compteur permet de dire</h2>
    <p>Le chiffre indique combien de participations ont été acceptées pour un événement. Ce n’est ni un recensement exhaustif de la foule ni la garantie d’une personne unique par participation. Un autre navigateur, l’effacement du stockage ou une position falsifiée peuvent contourner les protections. Un périmètre large et un très petit groupe limitent également ce que l’on peut déduire du chiffre.</p>
    <p>Selon le rassemblement, une participation peut révéler des opinions politiques, des convictions ou une appartenance syndicale. La pseudonymisation ne supprime pas cette sensibilité. <strong>Les fondements juridiques applicables au comptage et, le cas échéant, aux données sensibles restent à faire valider.</strong> Cette page décrit le fonctionnement réel du service ; elle ne constitue pas une certification de conformité.</p>
    <p>Le protocole et le code sont publics : <a href="https://github.com/guidouil/jemecompte" rel="noreferrer">consulter le code source</a> ou <a href="/comment-ca-marche">comprendre la méthode et ses limites</a>.</p>
  </section>

  <section class="prose-section" aria-labelledby="droits">
    <h2 id="droits">Vos droits et votre contact</h2>
    <p>Pour une question, une demande d’accès, de rectification, d’effacement, de limitation ou d’opposition, ou le retrait d’un consentement lorsqu’il s’applique, contactez <strong>Guillaume Darbonne</strong> à <a href="mailto:guidouil@gmail.com">guidouil@gmail.com</a>. Les demandes sont examinées selon les données encore conservées et les droits applicables.</p>
    <p>Nous ne disposons pas de compte ou de nom permettant de retrouver automatiquement votre participation. Cela n’exclut pas vos droits : des informations complémentaires peuvent parfois permettre de traiter une demande. Nous ne collectons pas une nouvelle identité uniquement pour vous identifier. N’envoyez jamais votre secret local, vos coordonnées GPS ou une pièce d’identité spontanément ; indiquez d’abord l’événement concerné et votre demande.</p>
    <p>Après la purge, la base active ne contient plus de ligne individuelle à retrouver pour cet événement. Les compteurs restent conservés. Effacer votre navigateur ne retire pas une participation déjà reçue par le serveur.</p>
    <p>Si vous écrivez par e-mail, votre adresse et votre message sont reçus dans la messagerie Gmail du responsable pour traiter votre demande. Cette correspondance est distincte du comptage ; aucune purge automatique n’est actuellement appliquée à cette boîte. Limitez votre message aux informations utiles.</p>
    <p>Vous pouvez également adresser une réclamation à la <a href="https://www.cnil.fr/fr/adresser-une-plainte" rel="noreferrer">Commission nationale de l’informatique et des libertés (CNIL)</a>.</p>
  </section>

  <section class="erase-section" aria-labelledby="erase-heading">
    <p class="eyebrow">SUR CET APPAREIL</p>
    <h2 id="erase-heading">Effacer mon identité locale</h2>
    <p>Cette action retire le secret de ce navigateur. Elle ne supprime ni une participation reçue par le serveur, ni les pages en cache, ni les journaux de l’hébergeur. Vous pouvez perdre le moyen de reconnaître une participation passée. Pour une demande concernant le serveur, contactez-nous avant cet effacement.</p>
    {#if confirmErase}
      <div class="notice"><p><strong>L’effacement est irréversible pour ce navigateur.</strong> Vérifiez que vous n’avez pas une participation en attente dans un autre onglet.</p><div class="inline-actions"><button type="button" class="secondary-button" onclick={erase} disabled={erasing}>{erasing ? 'Effacement…' : 'Confirmer l’effacement local'}</button><button type="button" class="text-button" disabled={erasing} onclick={() => { confirmErase = false; }}>Annuler</button></div></div>
    {:else}
      <button type="button" class="secondary-button" onclick={() => { confirmErase = true; eraseMessage = ''; }}>Effacer sur ce navigateur</button>
    {/if}
    <p class="action-message" role="status" aria-live="polite">{eraseMessage}</p>
  </section>
</article>

<style>
  .policy-date { margin-top: 18px; color: var(--muted); font-size: 12px; }
  .privacy-summary { margin-top: 30px; padding: 23px 25px; border-left: 3px solid var(--green); background: var(--soft-green); }
  .privacy-summary p { font-size: 14px; line-height: 1.8; }
  .privacy-summary p + p { margin-top: 10px; }
  .privacy-navigation { display: flex; flex-wrap: wrap; gap: 6px 24px; padding: 20px 0; border-bottom: 1px solid var(--line); }
  .privacy-navigation a { display: inline-flex; align-items: center; min-height: 44px; font-size: 13px; }
  .data-list { margin: 24px 0 0; }
  .data-list > div { display: grid; grid-template-columns: 170px minmax(0, 1fr); gap: 24px; border-top: 1px solid var(--line); padding: 21px 0; font-size: 14px; line-height: 1.8; }
  .data-list > div:last-child { border-bottom: 1px solid var(--line); }
  .data-list dt { font-weight: 700; }
  .data-list dd { margin: 0; color: var(--muted); }
  .retention { display: block; margin-top: 8px; color: var(--ink); }
  .prose-section { scroll-margin-top: 24px; }
  @media (max-width: 600px) {
    .privacy-summary { padding: 18px; }
    .data-list > div { grid-template-columns: 1fr; gap: 7px; }
    .privacy-navigation { column-gap: 20px; }
  }
</style>
