<script lang="ts">
  import { onDestroy, onMount, type Component } from 'svelte';
  import { summarizePerimeter } from '#lib/shared/perimeter-summary';
  import type { PublicEvent } from '#lib/shared/types';

  let { event }: { event: PublicEvent } = $props();
  const uid = $props.id();
  let expanded = $state(false);
  let ready = $state(false);
  let loading = $state(false);
  let failed = $state(false);
  let MapComponent = $state<Component<{ event: PublicEvent }> | null>(null);
  let generation = 0;
  let disposed = false;
  let summary = $derived(summarizePerimeter(event.geofence, event.countingScope));

  function formatLength(meters: number) {
    return meters >= 1_000 ? `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 }).format(meters / 1_000)} km` :
      `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(meters)} m`;
  }

  function formatArea(squareMeters: number) {
    return squareMeters >= 1_000_000 ? `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 }).format(squareMeters / 1_000_000)} km²` :
      `${new Intl.NumberFormat('fr-FR', { maximumSignificantDigits: 3 }).format(squareMeters)} m²`;
  }

  async function loadMap() {
    const request = ++generation;
    loading = true;
    failed = false;
    try {
      const module = await import('./EventPerimeterMap.svelte');
      if (!disposed && request === generation) MapComponent = module.default;
    } catch {
      if (!disposed && request === generation) failed = true;
    } finally {
      if (!disposed && request === generation) loading = false;
    }
  }

  function toggle() {
    if (!ready) return;
    expanded = !expanded;
    if (!expanded) {
      generation += 1;
      loading = false;
      failed = false;
    } else if (!MapComponent) {
      void loadMap();
    }
  }

  onMount(() => { ready = true; });
  onDestroy(() => { disposed = true; generation += 1; });
</script>

<section class="event-perimeter" aria-labelledby={`${uid}-heading`}>
  <div class="perimeter-header"><h3 id={`${uid}-heading`}>Zone de comptage</h3><button type="button" class="text-button" onclick={toggle} disabled={!ready} aria-expanded={expanded} aria-controls={`${uid}-map-panel`}>{expanded ? 'Masquer le périmètre' : 'Voir le périmètre'} <span aria-hidden="true">{expanded ? '−' : '+'}</span></button></div>
  <p class="perimeter-summary">{#if event.countingScope === 'city'}Toute la commune · contour administratif{:else if summary.kind === 'circle' && summary.approximateRadiusMeters !== null}Rayon approx. : {formatLength(summary.approximateRadiusMeters)}{:else}Périmètre personnalisé{/if}{#if summary.approximateAreaSquareMeters !== null}<span class="summary-separator" aria-hidden="true"> · </span>Superficie approx. : {formatArea(summary.approximateAreaSquareMeters)}{/if}</p>
  <p class="position-note">Votre position n’est pas affichée sur cette carte.</p>
  <div id={`${uid}-map-panel`} hidden={!expanded}>
    {#if expanded}
      {#if loading}<p class="map-loading" role="status">Chargement du périmètre…</p>
      {:else if failed}<div class="map-import-error" role="status"><p>La carte n’a pas pu être chargée. Vérifiez votre connexion puis réessayez. Le comptage reste disponible.</p><button type="button" class="secondary-button" onclick={() => void loadMap()}>Réessayer la carte</button></div>
      {:else if MapComponent}
        {#key `${event.id}:${event.geofenceVersion}`}<MapComponent {event} />{/key}
      {/if}
    {/if}
  </div>
</section>

<style>
  .event-perimeter { margin-top: 16px; padding-top: 9px; border-top: 1px solid var(--line); }
  .perimeter-header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0 15px; }
  .perimeter-header h3 { font-size: 12px; font-weight: 700; margin: 0; }
  .perimeter-header .text-button { display: inline-flex; align-items: center; gap: 9px; font-size: 11px; }
  .perimeter-summary, .position-note { color: var(--muted); font-size: 11px; line-height: 1.7; }
  .position-note { margin-top: 4px; }
  .map-loading, .map-import-error { margin-top: 12px; font-size: 12px; line-height: 1.7; padding: 15px; background: var(--notice); }
  .map-import-error .secondary-button { margin-top: 12px; }
  @media (max-width: 420px) { .summary-separator { display: block; font-size: 0; } }
</style>
