<script lang="ts">
  import { page } from '$app/state';
</script>

<svelte:head><title>{page.status === 404 ? 'Page introuvable' : 'Service indisponible'} — JeMeCompte</title></svelte:head>

<section class="information-page error-page">
  <p class="eyebrow">{page.status === 404 ? 'CETTE PAGE N’EST PAS ICI' : 'ON REPREND DÈS QUE POSSIBLE'}</p>
  <h1>{page.status === 404 ? 'Rien à compter ici.' : 'Une petite pause.'}</h1>
  <p class="information-lead">{page.status === 404 ? 'Le lien a peut-être changé, ou ce rassemblement n’est pas disponible.' : 'Le service ne peut pas afficher cette page pour le moment. Aucune participation supplémentaire n’est confirmée par cet écran.'}</p>
  <a href="/" class="secondary-button">Revenir à l’accueil <span aria-hidden="true">↗</span></a>
</section>
