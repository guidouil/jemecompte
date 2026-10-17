<script lang="ts">
  import { page } from '$app/state';
</script>

<svelte:head><title>{page.status === 404 ? 'Page introuvable' : 'Service indisponible'} — JeMeCompte</title></svelte:head>

<section class="information-page error-page">
  <p class="error-code" aria-hidden="true">{page.status}</p>
  <p class="eyebrow">{page.status === 404 ? 'CETTE PAGE N’EST PAS ICI' : 'ON REPREND DÈS QUE POSSIBLE'}</p>
  <h1>{page.status === 404 ? 'Rien à compter ici.' : 'Une petite pause.'}</h1>
  <p class="information-lead">{page.status === 404 ? 'Le lien a peut-être changé, ou ce rassemblement n’est pas disponible.' : 'Le service ne peut pas afficher cette page pour le moment. Aucune participation supplémentaire n’est confirmée par cet écran.'}</p>
  <a href="/" class="secondary-button">Revenir à l’accueil <span aria-hidden="true">↗</span></a>
</section>

<style>
  .error-page { max-width: 800px; }
  .error-code { display: inline-flex; align-items: center; justify-content: center; min-width: 74px; min-height: 48px; padding: 10px 18px; margin-bottom: 22px; border: 1px solid var(--line); border-radius: 24px; background: var(--surface-soft); font-size: 17px; font-weight: 800; font-variant-numeric: tabular-nums; }
</style>
