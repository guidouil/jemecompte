<script lang="ts">
  import { onMount } from 'svelte';
  import type { GeoJSON, GeoJSONOptions, Map, TileLayer } from 'leaflet';
  import 'leaflet/dist/leaflet.css';
  import type { PublicEvent } from '#lib/shared/types';

  let { event }: { event: PublicEvent } = $props();
  const uid = $props.id();
  let container = $state<HTMLDivElement>();
  let ready = $state(false);
  let failed = $state(false);
  let online = $state(true);
  let tilesLoading = $state(false);
  let tilesFailed = $state(false);
  let beyondTileScale = $state(false);
  let map: Map | undefined;
  let tiles: TileLayer | undefined;
  let outline: GeoJSON | undefined;
  let disposed = false;
  let loadTimer: ReturnType<typeof setTimeout> | undefined;
  let batchFailed = false;
  let mapMessage = $derived(!ready ? '' : !online ? 'Vous êtes hors ligne. Le contour public reste visible ; le fond de carte peut être incomplet.' :
    beyondTileScale ? 'À cette échelle, seul le contour est affiché. Zoomez pour voir le fond de carte.' :
    tilesFailed ? 'Le fond de carte est indisponible ou incomplet. Le contour public reste visible.' :
    tilesLoading ? 'Chargement du fond de carte…' : '');

  function clearLoadTimer() {
    if (loadTimer !== undefined) clearTimeout(loadTimer);
    loadTimer = undefined;
  }

  function recenter() {
    if (map && outline) map.fitBounds(outline.getBounds(), { padding: [25, 25], maxZoom: 17, animate: false });
  }

  function retryTiles() {
    if (!online || !tiles || !map || map.getZoom() < 5) return;
    tilesFailed = false;
    tiles.redraw();
  }

  async function initialize() {
    failed = false;
    ready = false;
    clearLoadTimer();
    map?.remove();
    map = undefined;
    tiles = undefined;
    outline = undefined;
    try {
      const library = await import('leaflet');
      if (disposed || !container) return;
      map = library.map(container, { zoomControl: false, scrollWheelZoom: false, minZoom: 1, maxZoom: 19,
        worldCopyJump: false, preferCanvas: false });
      map.getContainer().setAttribute('role', 'region');
      map.getContainer().setAttribute('aria-label', `Carte du périmètre public : ${event.name}`);
      map.getContainer().setAttribute('aria-describedby', `${uid}-help`);
      library.control.zoom({ zoomInTitle: 'Agrandir la carte', zoomOutTitle: 'Réduire la carte' }).addTo(map);
      map.attributionControl.setPrefix(false);
      // Display the published geometry directly, including custom team perimeters.
      const options: GeoJSONOptions & { smoothFactor: number } = {
        interactive: false, smoothFactor: 0,
        style: { color: '#125b39', weight: 3, fillColor: '#42b976', fillOpacity: 0.22, className: 'public-event-perimeter' }
      };
      outline = library.geoJSON(event.geofence, options).addTo(map);
      if (!outline.getBounds().isValid()) throw new Error('Invalid public perimeter.');
      recenter();
      const updateScale = () => { if (!disposed) beyondTileScale = Boolean(map && map.getZoom() < 5); };
      map.on('zoomend', updateScale);
      updateScale();
      tiles = library.tileLayer('/api/map/tiles/{z}/{x}/{y}', {
        minZoom: 5, maxZoom: 19, noWrap: true, updateWhenIdle: true, keepBuffer: 1,
        attribution: 'Plan © <a href="https://www.ign.fr/" target="_blank" rel="noreferrer">IGN</a> · Licence Ouverte'
      });
      tiles.on('loading', () => {
        if (disposed) return;
        batchFailed = false;
        tilesLoading = true;
        tilesFailed = false;
        clearLoadTimer();
        loadTimer = setTimeout(() => {
          if (!disposed) { tilesLoading = false; tilesFailed = true; }
        }, 12_000);
      });
      tiles.on('tileerror', () => { if (!disposed) { batchFailed = true; tilesFailed = true; } });
      tiles.on('load', () => {
        if (!disposed) { clearLoadTimer(); tilesLoading = false; tilesFailed = batchFailed; }
      });
      tiles.addTo(map);
      ready = true;
    } catch {
      if (!disposed) { clearLoadTimer(); failed = true; map?.remove(); map = undefined; }
    }
  }

  onMount(() => {
    online = navigator.onLine;
    const connectionChanged = () => {
      online = navigator.onLine;
      if (online) retryTiles();
    };
    window.addEventListener('online', connectionChanged);
    window.addEventListener('offline', connectionChanged);
    void initialize();
    return () => {
      disposed = true;
      clearLoadTimer();
      window.removeEventListener('online', connectionChanged);
      window.removeEventListener('offline', connectionChanged);
      map?.remove();
      map = undefined;
      tiles = undefined;
      outline = undefined;
    };
  });
</script>

<div class="public-map-wrapper">
  <div class="public-perimeter-map" bind:this={container}></div>
  {#if !ready && !failed}<p class="map-placeholder" role="status">Chargement de la carte…</p>{/if}
  {#if failed}<div class="map-placeholder"><p role="status">La carte n’a pas pu être affichée. Le comptage reste disponible.</p><button type="button" class="secondary-button" onclick={() => void initialize()}>Réessayer la carte</button></div>{/if}
</div>

{#if mapMessage}<p class="map-feedback" role="status" aria-live="polite" aria-atomic="true">{mapMessage}</p>{/if}
<div class="map-actions">
  <button type="button" class="text-button" disabled={!ready} onclick={recenter}>Recentrer le périmètre</button>
  {#if ready && tilesFailed && online && !beyondTileScale}<button type="button" class="text-button" onclick={retryTiles}>Réessayer le fond de carte</button>{/if}
</div>
<p id={`${uid}-help`} class="map-help"><span class="legend-line" aria-hidden="true"></span> Le contour vert indique le périmètre public. Au clavier : flèches pour déplacer la carte, + et − pour zoomer.</p>

<style>
  .public-map-wrapper { position: relative; margin-top: 13px; border: 1px solid var(--line); isolation: isolate; background: #e5e9e1; }
  .public-perimeter-map { width: 100%; height: 310px; background: #e5e9e1; color: #18251d; font-family: inherit; }
  .map-placeholder { position: absolute; inset: 0; z-index: 500; display: flex; flex-direction: column; justify-content: center; gap: 16px; padding: 22px; background: #e5e9e1; color: #18251d; font-size: 12px; line-height: 1.7; }
  .map-placeholder .secondary-button { align-self: flex-start; color: #18251d; border-color: #18251d; }
  .map-feedback { color: var(--muted); font-size: 11px; line-height: 1.7; margin-top: 10px; }
  .map-actions { display: flex; flex-wrap: wrap; gap: 0 18px; }
  .map-actions .text-button { font-size: 11px; }
  .map-help { color: var(--muted); font-size: 10px; line-height: 1.7; }
  .legend-line { display: inline-block; width: 18px; height: 3px; background: #125b39; vertical-align: middle; margin-right: 4px; }
  .public-perimeter-map :global(.leaflet-control-attribution) { font-size: 10px; line-height: 1.5; color: #222; }
  .public-perimeter-map :global(.leaflet-control-attribution a) { color: #125b39; }
  .public-perimeter-map :global(.leaflet-control-zoom a) { width: 44px; height: 44px; line-height: 44px; color: #18251d; background: #fff; }
  @media (max-width: 700px) { .public-perimeter-map { height: 285px; } }
</style>
