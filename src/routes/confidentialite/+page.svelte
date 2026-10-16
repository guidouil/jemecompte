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

<svelte:head><title>Confidentialité — JeMeCompte</title></svelte:head>

<article class="information-page">
  <a href="/" class="back-link">← Retour au comptage</a>
  <p class="eyebrow">CONFIDENTIALITÉ</p>
  <h1>Compter.<br />Sans vous suivre.</h1>
  <p class="information-lead">Aucune inscription. Aucun nom de participant demandé. Des données limitées au fonctionnement du comptage, avec une distinction claire entre discrétion et anonymat absolu.</p>
  <aside class="notice">Le responsable de traitement, les fondements juridiques, la procédure d’exercice des droits et les prestataires doivent être validés et publiés avant tout comptage réel. Cette page ne constitue pas une déclaration de conformité acquise.</aside>

  <section class="prose-section"><h2>Votre position précise</h2><p>Le client officiel l’utilise dans la mémoire du navigateur pour vérifier le périmètre. Il ne l’envoie pas à JeMeCompte, ne l’enregistre pas et n’en conserve pas d’historique. Aucun suivi continu n’est effectué.</p><p>Le navigateur, le système du téléphone ou leur fournisseur de localisation peuvent traiter des données pour obtenir cette position. L’autorisation native donne un accès technique ; elle ne remplace pas toute information ou tout accord requis pour un usage des données.</p></section>
  <section class="prose-section"><h2>Rechercher autour de vous</h2><p>Les filtres de nom, de ville et de période s’appliquent dans votre navigateur au catalogue chargé, limité à 500 rassemblements. Ils ne garantissent pas une recherche exhaustive.</p><p>« Autour de moi » demande un relevé ponctuel, après votre clic. Le calcul de distance est local ; aucune position de recherche n’est envoyée au serveur, conservée dans le stockage du site ou inscrite dans l’adresse de la page. Le filtre peut être retiré sans nouveau relevé. Cette recherche accepte une position approximative et ne prouve pas une présence dans le périmètre.</p></section>
  <section class="prose-section"><h2>Le lieu public que vous choisissez en créant</h2><p>La création guidée ne demande pas votre position GPS et ne reprend pas celle d’une recherche de proximité. Vous choisissez explicitement le centre du rassemblement sur une carte et confirmez sa publication. Le rayon public est réglable de 100 mètres à 10 kilomètres, avec 500 mètres par défaut.</p><p><strong>Le nom du rassemblement, sa commune, son centre, son périmètre et ses horaires deviennent publics.</strong> Ces données sont transmises au serveur et conservées avec l’événement. Choisissez un lieu public de rassemblement ; n’y indiquez pas une adresse personnelle. Créer un événement ne déclare pas automatiquement votre présence.</p><p>À 10 kilomètres de rayon, la zone couvre 20 kilomètres de large et environ 314 km². Une déclaration acceptée dans cette zone peut concerner une personne éloignée du rassemblement ; elle ne garantit pas sa présence physique au rassemblement. Le compteur doit être lu avec son périmètre public.</p><p>La recherche de communes officielles et les tuiles du fond de carte IGN passent par JeMeCompte. Le service reçoit donc les demandes de ville ou de carte. Les fournisseurs en amont reçoivent l’adresse IP du serveur, le nom de commune recherché ou les références des tuiles, sans transmission directe de l’IP du visiteur. Cette médiation ne rend pas la zone de carte consultée secrète pour l’infrastructure JeMeCompte.</p><p>Le cache cartographique du serveur est borné en mémoire, avec une validité maximale de 24 heures. Il n’est pas associé à un journal des IP de visiteurs ni aux identifiants de participation. Les détails de configuration et d’exploitation doivent être vérifiés avant un déploiement réel.</p></section>
  <section class="prose-section"><h2>Un identifiant pour chaque événement</h2><p>Un secret aléatoire reste dans le stockage local de votre navigateur. Il sert à produire un identifiant différent pour chaque événement. Le serveur reçoit cet identifiant et le rattache à l’événement pour empêcher les doublons de cette identité locale.</p><p>Ce sont des données pseudonymes, pas une garantie d’anonymisation. Selon le rassemblement, une participation peut révéler une opinion politique, une conviction ou une appartenance syndicale. Nous ne cherchons pas à reconstituer un parcours entre événements.</p><p>Le secret local n’est pas une preuve d’humanité ou de présence. Une page compromise peut utiliser une clé pourtant non exportable. La protection suppose aussi un navigateur et un serveur intègres.</p></section>
  <section class="prose-section"><h2>Le réseau et la protection du service</h2><p>Une connexion Internet expose nécessairement une adresse IP à l’infrastructure qui la reçoit. Le service l’utilise transitoirement pour acheminer les requêtes et limiter les abus. Les signaux anti-abus temporaires restent séparés des participations.</p><p>La limitation des créations utilise un signal HMAC d’IP avec une clé éphémère, en mémoire, sur des fenêtres d’une heure. Ce signal n’est ni un compte de créateur ni un identifiant de participant et n’est pas enregistré avec l’événement.</p><p>Aucun fingerprint, pixel publicitaire, Google Analytics ou suivi de session n’est intégré. Les polices et ressources du parcours sont servies par le site ; la carte et les communes utilisent les relais décrits plus haut. Aucun nom de participant, e-mail, numéro de téléphone ni coordonnées GPS ne sont demandés dans les requêtes de participation.</p></section>
  <section class="prose-section"><h2>Conservation : des durées à vérifier</h2><p>La cible du MVP est de supprimer les identifiants de participation à l’issue d’une courte fenêtre après l’événement, de ne conserver les signaux anti-abus qu’au maximum une heure et de garder les sauvegardes chiffrées sept jours au plus. Les compteurs agrégés peuvent être conservés plus longtemps.</p><p>Ces paramètres doivent être vérifiés dans la configuration du déploiement et publiés précisément avant une collecte réelle. Une suppression en base peut laisser temporairement une copie dans une sauvegarde ; la restauration doit appliquer les échéances et les demandes d’effacement déjà exécutées.</p></section>
  <section class="prose-section"><h2>Vos droits</h2><p>La procédure permettant d’exercer les droits, de retirer un éventuel consentement et de joindre le responsable doit être opérationnelle avant un vrai événement.</p><p>Effacer le stockage local est différent d’effacer une participation reçue par le serveur. La perte du secret local peut empêcher de retrouver les participations liées à ce navigateur. Un petit compteur peut également devenir révélateur si les personnes sont observables : ce risque doit être examiné avant publication.</p></section>

  <section class="erase-section" aria-labelledby="erase-heading">
    <p class="eyebrow">SUR CET APPAREIL</p>
    <h2 id="erase-heading">Effacer mon identité locale</h2>
    <p>Cette action retire le secret de ce navigateur. Elle ne retire pas vos participations du compteur serveur. Vous pourriez perdre le moyen de reconnaître une participation passée ou d’exercer certains droits avec cet appareil.</p>
    {#if confirmErase}
      <div class="notice"><p><strong>L’effacement est irréversible pour ce navigateur.</strong> Vérifiez que vous n’avez pas une participation en attente dans un autre onglet.</p><div class="inline-actions"><button type="button" class="secondary-button" onclick={erase} disabled={erasing}>{erasing ? 'Effacement…' : 'Confirmer l’effacement local'}</button><button type="button" class="text-button" disabled={erasing} onclick={() => { confirmErase = false; }}>Annuler</button></div></div>
    {:else}
      <button type="button" class="secondary-button" onclick={() => { confirmErase = true; eraseMessage = ''; }}>Effacer sur ce navigateur</button>
    {/if}
    <p class="action-message" role="status" aria-live="polite">{eraseMessage}</p>
  </section>
</article>
