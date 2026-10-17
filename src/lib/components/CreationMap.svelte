<script lang="ts">
  import { onMount } from 'svelte';
  import type { Map, LayerGroup } from 'leaflet';
  import 'leaflet/dist/leaflet.css';
  import { circlePolygon, type GeoPoint } from '#lib/shared/geo';
  import type { EventGeofence } from '#lib/shared/types';

  interface Props {
    view: GeoPoint;
    center: GeoPoint | null;
    radius: number;
    boundary?: EventGeofence | null;
    readonly?: boolean;
    onselect: (point: GeoPoint) => void;
  }
  let { view, center, radius, boundary = null, readonly = false, onselect }: Props = $props();
  let container: HTMLDivElement;
  let map: Map | undefined;
  let zone: LayerGroup | undefined;
  let leaflet: typeof import('leaflet') | undefined;
  let renderedRadius: number | undefined;
  let renderedReadonly = false;
  let renderedBoundary: EventGeofence | null | undefined;
  let ready = $state(false);
  let failed = $state(false);
  let tilesFailed = $state(false);
  let tilesReady = $state(false);
  let publicPolygon = $derived(boundary ?? (center ? circlePolygon(center, radius) : null));

  function selectMapCenter() {
    const point = map?.getCenter();
    if (point && !readonly && tilesReady && !tilesFailed) onselect([Number(point.lng.toFixed(6)), Number(point.lat.toFixed(6))]);
  }

  onMount(() => {
    let disposed = false;
    void import('leaflet').then((library) => {
      if (disposed) return;
      leaflet = library;
      map = library.map(container, { zoomControl: false, scrollWheelZoom: false, minZoom: 5, maxZoom: 19,
        worldCopyJump: false, maxBounds: [[-85, -180], [85, 180]], preferCanvas: false });
      map.setView([view[1], view[0]], 13);
      map.getContainer().setAttribute('aria-label', boundary ? 'Carte du contour administratif de la commune entière.' : 'Carte du lieu public. Déplacez la carte avec les flèches, puis utilisez le bouton Placer au centre.');
      library.control.zoom({ zoomInTitle: 'Agrandir la carte', zoomOutTitle: 'Réduire la carte' }).addTo(map);
      map.attributionControl.setPrefix(false);
      const tiles = library.tileLayer('/api/map/tiles/{z}/{x}/{y}', {
        minZoom: 5, maxZoom: 19, noWrap: true, updateWhenIdle: true, keepBuffer: 1,
        attribution: 'Plan © <a href="https://www.ign.fr/" target="_blank" rel="noreferrer">IGN</a> · Licence Ouverte'
      }).addTo(map);
      tiles.on('tileerror', () => { if (!disposed) tilesFailed = true; });
      tiles.on('tileload', () => { if (!disposed) { tilesReady = true; tilesFailed = false; } });
      zone = library.layerGroup().addTo(map);
      map.on('click', (event) => {
        if (!readonly && tilesReady && !tilesFailed) onselect([Number(event.latlng.lng.toFixed(6)), Number(event.latlng.lat.toFixed(6))]);
      });
      ready = true;
    }).catch(() => { if (!disposed) failed = true; });
    return () => { disposed = true; map?.remove(); map = undefined; };
  });

  $effect(() => {
    const point = view;
    if (ready) map?.setView([point[1], point[0]], 15, { animate: false });
  });

  $effect(() => {
    const point = center;
    const polygon = publicPolygon;
    const meters = radius;
    const reviewing = readonly;
    const commune = boundary;
    if (!ready || !zone || !leaflet) return;
    const radiusChanged = renderedRadius !== undefined && renderedRadius !== meters;
    const enteringReview = reviewing && !renderedReadonly;
    const boundaryChanged = renderedBoundary !== commune;
    renderedRadius = meters;
    renderedReadonly = reviewing;
    renderedBoundary = commune;
    // These effects synchronize Leaflet's external DOM; no component state is derived by assignment.
    zone.clearLayers();
    if (polygon) {
      const outline = leaflet.geoJSON(polygon, {
        style: { color: '#125b39', weight: 3, fillColor: '#42b976', fillOpacity: 0.22, className: commune ? 'creation-city-boundary' : 'creation-gathering-boundary' }, interactive: false
      }).addTo(zone);
      if (point && !commune) leaflet.circleMarker([point[1], point[0]], { radius: 6, color: '#fff', weight: 2,
        fillColor: '#125b39', fillOpacity: 1, interactive: false }).addTo(zone);
      // Repositioning the point only redraws the zone; preserve the user's zoom and viewport.
      if (radiusChanged || enteringReview || (commune && boundaryChanged)) {
        map?.fitBounds(outline.getBounds(), { padding: reviewing ? [30, 30] : [22, 22], maxZoom: 17, animate: false });
      }
    }
  });
</script>

<div class="map-wrapper">
  <div class="creation-map" bind:this={container}></div>
  {#if !ready}<p class="map-message" role="status">{failed ? 'La carte n’a pas pu être chargée. Vérifiez votre connexion puis rechargez cette page.' : 'Chargement de la carte…'}</p>{/if}
  {#if tilesFailed}<p class="tile-warning" role="status">{boundary ? 'Le fond de carte est indisponible. Le contour de la commune reste visible.' : 'Le fond de carte est indisponible. Attendez son retour pour choisir le lieu avec précision.'}</p>{/if}
</div>
{#if !readonly}
  <button type="button" class="secondary-button map-center-button" disabled={!ready || !tilesReady || tilesFailed} onclick={selectMapCenter}>Placer la zone au centre de la carte <span aria-hidden="true">＋</span></button>
  <p class="map-help">Touchez un lieu public pour placer la zone. Au clavier : flèches pour déplacer la carte, + et − pour zoomer, puis « Placer la zone au centre ».</p>
{/if}
{#if boundary}<p class="map-help">Le contour vert couvre toute la commune, y compris ses territoires disjoints. Aucun point ni rayon à choisir.</p>{/if}

<style>
  .map-wrapper { position: relative; margin-top: 18px; border: 1px solid var(--line); isolation: isolate; background: #e5e9e1; }
  .creation-map { height: 370px; width: 100%; color: #18251d; background: #e5e9e1; font-family: inherit; }
  .map-message { position: absolute; inset: 0; display: grid; place-content: center; padding: 26px; color: #18251d; background: #e5e9e1; font-size: 14px; }
  .tile-warning { position: absolute; bottom: 26px; left: 12px; right: 12px; background: #fff9dd; padding: 10px; color: #41351b; z-index: 500; font-size: 12px; }
  .map-center-button { width: 100%; margin-top: 12px; }
  .map-help { margin-top: 10px; font-size: 12px; color: var(--muted); }
  .creation-map :global(.leaflet-control-attribution) { font-size: 10px; line-height: 1.5; color: #222; }
  .creation-map :global(.leaflet-control-attribution a) { color: #125b39; }
  .creation-map :global(.leaflet-control-zoom a) { width: 44px; height: 44px; line-height: 44px; color: #18251d; background: #fff; }
  @media(max-width: 700px) { .creation-map { height: 320px; } }
</style>
