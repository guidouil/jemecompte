<script lang="ts">
  import { onMount } from 'svelte';
  import { approximateDistance, discoverEvents, DiscoveryLocationError, locateForDiscovery } from '#lib/client/discovery';
  import type { DiscoveryPeriod, DiscoveryPosition } from '#lib/client/discovery';
  import type { PublicEvent } from '#lib/shared/types';

  let { events, serviceAvailable }: { events: PublicEvent[]; serviceAvailable: boolean } = $props();

  const uid = $props.id();
  const dateFormat = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
  });
  let query = $state('');
  let period = $state<DiscoveryPeriod>('all');
  let radiusKm = $state(25);
  let position = $state.raw<DiscoveryPosition | null>(null);
  let locating = $state(false);
  let locationMessage = $state('');
  let now = $state(Date.now());
  let ready = $state(false);
  let generation = 0;
  let disposed = false;
  let results = $derived(discoverEvents(events, { query, period, now, position, radiusKm }));

  async function locate() {
    if (locating || !ready || !serviceAvailable) return;
    const request = ++generation;
    locating = true;
    position = null;
    locationMessage = 'Recherche de votre position…';
    try {
      const next = await locateForDiscovery();
      if (disposed || request !== generation) return;
      position = next;
      locationMessage = 'Recherche de proximité activée. Votre position reste dans la mémoire de cette page.';
    } catch (error) {
      if (disposed || request !== generation) return;
      locationMessage = error instanceof DiscoveryLocationError ? error.message :
        'La recherche autour de vous est indisponible. Cherchez par nom ou par ville.';
    } finally {
      if (!disposed && request === generation) locating = false;
    }
  }

  function forgetPosition() {
    generation += 1;
    position = null;
    locating = false;
    locationMessage = 'La position n’est plus utilisée. Vous consultez le catalogue sans filtre de distance.';
  }

  function reset() {
    forgetPosition();
    query = '';
    period = 'all';
    radiusKm = 25;
  }

  onMount(() => {
    ready = true;
    const timer = window.setInterval(() => { now = Date.now(); }, 30_000);
    return () => {
      disposed = true;
      generation += 1;
      window.clearInterval(timer);
    };
  });
</script>

<section id="rassemblements" class="discovery" aria-labelledby={`${uid}-heading`}>
  <div class="discovery-heading">
    <div><p class="eyebrow">TROUVER UN COMPTAGE</p><h2 id={`${uid}-heading`}>Où est-ce que ça compte ?</h2></div>
    <a href="/creer" class="create-link">Ouvrir un comptage <span aria-hidden="true">↗</span></a>
  </div>

  <div class="search-controls" role="search" aria-label="Rechercher un comptage">
    <div class="search-field"><label for={`${uid}-query`}>Nom ou ville</label><input id={`${uid}-query`} type="search" bind:value={query} placeholder="Paris, République…" autocomplete="off" spellcheck="false" disabled={!serviceAvailable} /></div>
    <div class="period-field"><label for={`${uid}-period`}>Quand ?</label><select id={`${uid}-period`} bind:value={period} disabled={!serviceAvailable}><option value="all">Tous pertinents</option><option value="current">En cours</option><option value="upcoming">À venir</option></select></div>
  </div>

  <div class="proximity-controls">
    <button type="button" class="secondary-button" onclick={locate} disabled={!ready || !serviceAvailable || locating} aria-busy={locating} aria-describedby={`${uid}-location-help`}>{locating ? 'Localisation…' : position ? 'Actualiser ma position' : 'Autour de moi'} <span aria-hidden="true">⌖</span></button>
    <div class="radius-field"><label for={`${uid}-radius`}>Rayon approximatif</label><select id={`${uid}-radius`} bind:value={radiusKm} disabled={!serviceAvailable}><option value={5}>5 km</option><option value={25}>25 km</option><option value={100}>100 km</option></select></div>
    {#if position || locating}<button type="button" class="text-button" onclick={forgetPosition}>Ne plus utiliser ma position</button>{/if}
  </div>

  <p id={`${uid}-location-help`} class="discovery-help">La localisation est facultative et ponctuelle. Elle n’est ni envoyée au serveur, ni ajoutée à l’adresse de la page, ni enregistrée par JeMeCompte.</p>
  <p class="location-feedback" role="status" aria-live="polite">{locationMessage}</p>

  {#if position}<p class="discovery-help distance-help">Les distances sont calculées à vol d’oiseau depuis le centre approximatif du périmètre. Elles ne prouvent pas votre présence sur place.</p>{/if}

  <div class="results-heading"><p role="status" aria-live="polite">{serviceAvailable ? `${results.length} comptage${results.length > 1 ? 's' : ''} trouvé${results.length > 1 ? 's' : ''}` : 'Catalogue indisponible'}</p><button type="button" class="text-button" onclick={reset}>Réinitialiser les filtres</button></div>

  {#if !serviceAvailable}
    <div class="empty-result"><h3>Le catalogue ne peut pas être chargé.</h3><p>Réessayez dans quelques instants avant de créer un rassemblement, pour pouvoir vérifier qu’il n’existe pas déjà.</p></div>
  {:else if !results.length}
    <div class="empty-result"><h3>Aucun comptage ne correspond à ces filtres.</h3><p>Essayez un autre nom, une autre ville ou un rayon plus grand. Les comptages terminés ou annulés sont masqués.</p><a href="/creer" class="secondary-button">Créer un rassemblement <span aria-hidden="true">↗</span></a><p>Vérifiez d’abord les autres filtres pour éviter de créer un doublon.</p></div>
  {:else}
    <ul class="discovery-results">
      {#each results as result (result.event.id)}
        <li><a href={`/evenements/${result.event.slug}`} class="discovery-result">
          <div class="result-city"><span class="city-symbol" aria-hidden="true">⌖</span><strong>{result.event.cityName}</strong>{#if result.distance !== null}<span>{approximateDistance(result.distance)}</span>{/if}</div>
          <div class="result-main"><h3>{result.event.name}</h3><p>{result.event.status === 'paused' || result.event.integrityStatus === 'suspended' ? 'En pause' : result.period === 'current' ? result.event.countingScope === 'city' ? 'Comptage ouvert' : 'En cours' : 'À venir'} <span aria-hidden="true">·</span> {#if result.event.countingScope === 'city'}Fenêtre : {/if}{dateFormat.format(new Date(result.event.startsAt))}{#if result.event.countingScope === 'city'} au {dateFormat.format(new Date(result.event.endsAt))}{/if} <span class="paris-time">(Paris)</span></p><div class="result-labels"><span>{result.event.countingScope === 'city' ? 'COMMUNE ENTIÈRE' : 'RASSEMBLEMENT'}</span>{#if result.event.creationSource === 'community'}<span>Ouvert par un participant</span>{/if}</div>{#if result.event.countingScope === 'city'}<p>Zone de déclaration dans toute la commune. Aucun lieu de manifestation confirmé.</p>{/if}</div>
          <span class="result-arrow" aria-hidden="true">↗</span>
        </a></li>
      {/each}
    </ul>
  {/if}

  <p class="catalogue-note">Tous pertinents : événements en cours et à venir. Les événements terminés, fermés ou annulés sont masqués.{#if events.length >= 500} <strong>Catalogue limité aux 500 premiers rassemblements ; d’autres peuvent exister.</strong>{/if}</p>
  <p class="duplicate-note">Vous organisez un autre rassemblement ? <a href="/creer">Créer son périmètre <span aria-hidden="true">↗</span></a> Cherchez d’abord ici pour éviter un doublon.</p>
</section>

<style>
  .discovery { padding-top: 35px; scroll-margin-top: 24px; border-top: 1px solid var(--line); }
  .discovery-heading { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; }
  .discovery-heading h2 { margin: 10px 0 0; font-size: clamp(27px, 3.4vw, 40px); letter-spacing: -1.3px; line-height: 1.15; }
  .discovery-heading .eyebrow { color: var(--accent-ink); }
  .create-link { font-size: 12px; font-weight: 600; padding: 12px 0; white-space: nowrap; }
  .create-link span { margin-left: 8px; }
  .search-controls { display: grid; grid-template-columns: minmax(0, 1fr) 220px; gap: 18px; margin-top: 27px; }
  label { display: block; font-size: 12px; font-weight: 700; margin-bottom: 8px; }
  input, select { width: 100%; min-height: 54px; padding: 13px 16px; border: 1px solid var(--line-strong); border-radius: 12px; color: var(--ink); background: var(--surface); font: inherit; font-size: 16px; }
  input::placeholder { color: var(--muted); opacity: 1; }
  input:disabled, select:disabled { opacity: 0.6; }
  .proximity-controls { display: flex; align-items: flex-end; flex-wrap: wrap; gap: 14px 20px; margin-top: 19px; }
  .radius-field { width: 160px; }
  .proximity-controls .secondary-button { min-height: 50px; gap: 18px; }
  .proximity-controls .secondary-button span { font-size: 20px; }
  .discovery-help { color: var(--muted); font-size: 12px; line-height: 1.7; max-width: 760px; margin-top: 12px; }
  .location-feedback { color: var(--ink); font-size: 13px; line-height: 1.6; }
  .location-feedback:not(:empty) { margin-top: 12px; padding: 14px 18px; border-radius: 12px; background: var(--surface-soft); }
  .distance-help { margin-top: 8px; }
  .results-heading { display: flex; justify-content: space-between; gap: 20px; align-items: center; margin-top: 22px; }
  .results-heading > p { color: var(--muted); font-size: 12px; }
  .results-heading .text-button { font-size: 11px; }
  .discovery-results { margin: 0; padding: 0; list-style: none; display: grid; gap: 12px; }
  .discovery-results li { border: 1px solid var(--line); border-radius: 18px; background: var(--surface); min-width: 0; }
  .discovery-result { display: grid; grid-template-columns: 150px minmax(0, 1fr) auto; gap: 24px; align-items: center; min-height: 112px; padding: 22px 24px; text-decoration: none; border-radius: 18px; transition: background 140ms; }
  .discovery-result:hover { background: var(--surface-soft); }
  .discovery-result:hover h3 { text-decoration: underline; text-underline-offset: 4px; }
  .city-symbol { display: inline-flex; width: 30px; height: 30px; align-items: center; justify-content: center; border-radius: 50%; background: var(--surface-soft); color: var(--accent-ink); margin-bottom: 6px; font-size: 20px; }
  .result-city strong { display: block; font-size: 14px; }
  .result-city > span:not(.city-symbol) { display: block; color: var(--muted); font-size: 11px; margin-top: 5px; }
  .result-main h3 { font-size: 17px; letter-spacing: -0.35px; line-height: 1.45; margin: 0; overflow-wrap: anywhere; }
  .result-main p { color: var(--muted); font-size: 12px; margin-top: 6px; }
  .result-main p > span[aria-hidden] { margin: 0 5px; }
  .paris-time { font-size: 10px; }
  .result-labels { display: flex; flex-wrap: wrap; gap: 6px 10px; margin-top: 10px; color: var(--accent-ink); font-size: 10px; font-weight: 600; }
  .result-labels:empty { display: none; }
  .result-arrow { font-size: 25px; }
  .empty-result { padding: 30px; border: 1px dashed var(--line-strong); border-radius: 18px; background: var(--surface); }
  .empty-result h3 { margin: 0; font-size: 17px; line-height: 1.5; }
  .empty-result p { font-size: 12px; color: var(--muted); margin-top: 8px; }
  .empty-result .secondary-button { margin-top: 20px; }
  .catalogue-note { font-size: 12px; line-height: 1.7; color: var(--muted); margin-top: 18px; }
  .catalogue-note strong { font-weight: 600; }
  .duplicate-note { font-size: 12px; line-height: 1.8; margin-top: 16px; }
  .duplicate-note a { font-weight: 600; }
  @media (max-width: 700px) {
    .discovery { padding-top: 27px; }
    .discovery-heading { flex-direction: column; align-items: flex-start; gap: 5px; }
    .discovery-heading h2 { font-size: 30px; }
    .create-link { padding: 10px 0; min-height: 44px; display: inline-flex; align-items: center; }
    .search-controls { grid-template-columns: minmax(0, 1fr); gap: 14px; margin-top: 16px; }
    input, select { font-size: 16px; }
    .proximity-controls { gap: 12px; }
    .proximity-controls .secondary-button { flex: 1; padding: 12px; white-space: nowrap; }
    .radius-field { width: 138px; }
    .radius-field label { font-size: 10px; }
    .proximity-controls .text-button { width: 100%; }
    .results-heading { gap: 12px; }
    .discovery-result { grid-template-columns: minmax(0, 1fr) auto; gap: 10px 15px; padding: 20px; }
    .result-city { grid-column: 1; display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; }
    .result-city strong { font-size: 11px; }
    .result-city > span:not(.city-symbol) { margin: 0; }
    .result-city .city-symbol { font-size: 18px; }
    .result-main { grid-column: 1; }
    .result-arrow { grid-column: 2; grid-row: 1 / 3; }
    .result-main h3 { font-size: 16px; }
    .empty-result { padding: 24px; }
  }
</style>
