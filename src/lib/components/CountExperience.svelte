<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { createParticipationFlow } from '#lib/client/participation';
  import { subscribeCounters } from '#lib/client/counter-stream';
  import { mergeCounterSnapshots } from '#lib/client/counter-snapshot';
  import EventDiscovery from './EventDiscovery.svelte';
  import EventPerimeter from './EventPerimeter.svelte';
  import EventShare from './EventShare.svelte';
  import type { CounterSnapshot, FlowState, PublicEvent } from '#lib/shared/types';

  interface Props {
    events: PublicEvent[];
    selectedEvent: PublicEvent | null;
    snapshot: CounterSnapshot | null;
    nationalTotal: string;
    serviceAvailable: boolean;
  }

  let { events, selectedEvent, snapshot, nationalTotal, serviceAvailable }: Props = $props();
  let selectedOverride = $state<PublicEvent | null>(null);
  let latestSnapshot = $state<CounterSnapshot | null>(null);
  let flowState = $state<FlowState>({ phase: 'idle', message: '' });
  let confirmationTotal = $state<string | null>(null);
  let online = $state(true);
  let ready = $state(false);
  let now = $state(Date.now());
  let connection = $state<'live' | 'reconnecting' | 'offline'>('reconnecting');
  let flow: ReturnType<typeof createParticipationFlow> | undefined;

  const numberFormat = new Intl.NumberFormat('fr-FR');
  const dateFormat = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit'
  });

  let currentEvent = $derived(selectedOverride ?? selectedEvent);
  let currentSnapshot = $derived(
    latestSnapshot?.eventId === currentEvent?.id ? latestSnapshot :
    snapshot?.eventId === currentEvent?.id ? snapshot : null
  );
  let status = $derived(currentSnapshot?.eventStatus ?? currentEvent?.status);
  let integrity = $derived(currentSnapshot?.integrityStatus ?? currentEvent?.integrityStatus);
  let ended = $derived(Boolean(currentEvent && (status === 'closed' || status === 'cancelled' || now >= Date.parse(currentSnapshot?.endsAt ?? currentEvent.endsAt))));
  let notStarted = $derived(Boolean(currentEvent && now < Date.parse(currentSnapshot?.startsAt ?? currentEvent.startsAt)));
  let paused = $derived(status === 'paused' || integrity === 'suspended');
  let busy = $derived(flowState.phase === 'locating' || flowState.phase === 'submitting');
  let counted = $derived(flowState.phase === 'counted' || flowState.phase === 'already_counted');
  let noEvents = $derived(!currentEvent && events.length === 0);
  let disabled = $derived(!ready || !serviceAvailable || !online || noEvents || busy || counted || ended || notStarted || paused || flowState.phase === 'pending' || flowState.phase === 'choosing');
  let total = $derived(currentSnapshot ? formatCount(currentSnapshot.total) : '—');
  let national = $derived(serviceAvailable ? formatCount(latestSnapshot?.nationalTotal ?? nationalTotal) : '—');
  let buttonText = $derived(
    flowState.phase === 'locating' ? 'VÉRIFICATION SUR PLACE…' :
    flowState.phase === 'submitting' ? 'COMPTAGE EN COURS…' :
    counted ? 'VOUS ÊTES COMPTÉ·E' :
    ended ? 'COMPTAGE TERMINÉ' :
    paused ? 'COMPTAGE EN PAUSE' :
    notStarted ? 'BIENTÔT OUVERT' :
    !serviceAvailable ? 'SERVICE INDISPONIBLE' :
    noEvents ? 'AUCUN RASSEMBLEMENT' :
    !online ? 'VOUS ÊTES HORS LIGNE' : 'JE ME COMPTE'
  );

  function formatCount(value: string) {
    try { return numberFormat.format(BigInt(value)); } catch { return '—'; }
  }

  function receiveSnapshot(next: CounterSnapshot) {
    const previous = latestSnapshot?.eventId === next.eventId ? latestSnapshot :
      snapshot?.eventId === next.eventId ? snapshot : undefined;
    latestSnapshot = mergeCounterSnapshots(previous, next);
    now = Date.now();
  }

  function receiveFlow(next: FlowState) {
    flowState = next;
    if (next.phase === 'counted' || next.phase === 'already_counted') {
      const confirmed = latestSnapshot?.eventId === next.eventId ? latestSnapshot :
        snapshot?.eventId === next.eventId ? snapshot : null;
      confirmationTotal = confirmed ? formatCount(confirmed.total) : null;
    } else {
      confirmationTotal = null;
    }
  }

  function count() {
    if (!disabled) void flow?.count(currentEvent?.id);
  }

  onMount(() => {
    online = navigator.onLine;
    const updateConnection = () => { online = navigator.onLine; };
    window.addEventListener('online', updateConnection);
    window.addEventListener('offline', updateConnection);
    const timer = window.setInterval(() => { now = Date.now(); }, 15_000);
    flow = createParticipationFlow({
      getEvents: () => events,
      onChange: receiveFlow,
      onEvent: (event) => { selectedOverride = event; },
      onSnapshot: receiveSnapshot
    });
    ready = true;
    return () => {
      flow?.destroy();
      window.clearInterval(timer);
      window.removeEventListener('online', updateConnection);
      window.removeEventListener('offline', updateConnection);
    };
  });

  $effect(() => {
    const eventId = currentEvent?.id;
    if (!eventId || !ready || !serviceAvailable) return;
    // This effect owns the external subscription; snapshots arrive through callbacks.
    return untrack(() => subscribeCounters(eventId, {
      onSnapshot: receiveSnapshot,
      onConnectionChange: (next) => { connection = next; }
    }));
  });
</script>

<section class="count-experience" aria-labelledby="count-title">
  <div class="intro-line">
    <p class="eyebrow"><span class="small-dot" aria-hidden="true"></span> LE COMPTAGE EST AUSSI UN GESTE CITOYEN.</p>
  </div>

  <div class="count-stage">
    <div class="action-column">
      <h1 id="count-title" class="hero-title">JE ME<br />COMPTE<span class="title-dot">.</span></h1>
      <p class="hero-description">Vous êtes sur place.<br />Faites compter votre présence.</p>

      {#if currentEvent}
        <div class="event-context">
          <div class="event-meta"><span>{currentEvent.cityName}</span><span>RASSEMBLEMENT</span></div>
          <h2>{currentEvent.name}</h2>
          <p>Du {dateFormat.format(new Date(currentEvent.startsAt))}<br />au {dateFormat.format(new Date(currentEvent.endsAt))} <span class="muted">(heure de Paris)</span></p>
          {#if currentEvent.description}<p class="event-description">{currentEvent.description}</p>{/if}
          {#if ended}<p class="event-state">Cet événement est terminé.</p>
          {:else if paused}<p class="event-state">Les nouvelles participations sont momentanément suspendues.</p>
          {:else if notStarted}<p class="event-state">Le comptage ouvrira au début de l’événement.</p>{/if}
        </div>
      {/if}

      <button type="button" class="count-button" class:is-counted={counted} onclick={count} {disabled} aria-describedby="privacy-promise participation-feedback" aria-busy={busy}>
        <span>{buttonText}</span>
        <span aria-hidden="true">{counted ? '✓' : busy ? '· · ·' : '↗'}</span>
      </button>

      <p id="privacy-promise" class="privacy-promise"><strong>Sans inscription.</strong> Votre position précise est vérifiée dans votre navigateur et n’est pas envoyée à JeMeCompte.</p>
      <noscript><p class="notice">JavaScript est nécessaire pour vérifier votre position sur votre appareil et participer.</p></noscript>

      <div id="participation-feedback" class="participation-feedback" role="status" aria-live="polite" aria-atomic="true">
        {#if counted && confirmationTotal !== null}
          <p>{flowState.phase === 'already_counted' ? 'Vous êtes déjà compté·e.' : 'Vous êtes compté·e.'} <strong>{confirmationTotal}</strong> participations enregistrées pour cet événement.</p>
        {:else if flowState.message}<p class:error-message={flowState.phase === 'error'}>{flowState.message}</p>{/if}
      </div>

      {#if currentEvent}
        {#key currentEvent.id}
          <div class="event-tools">
            <EventPerimeter event={currentEvent} />
            <EventShare event={currentEvent} />
          </div>
        {/key}
      {/if}

      {#if !serviceAvailable}
        <p class="notice">Le service est momentanément indisponible. Aucun comptage n’est confirmé. Réessayez un peu plus tard.</p>
      {:else if !online}
        <p class="notice">La connexion est coupée. Votre présence ne peut pas être confirmée hors ligne. Le dernier chiffre affiché peut dater.</p>
      {/if}

      {#if flowState.phase === 'pending'}
        <div class="notice">
          <p><strong>Confirmation en attente.</strong> Le serveur a peut-être reçu votre participation. Vérifiez avant de recommencer.</p>
          <div class="inline-actions">
            {#if currentEvent}<button type="button" class="secondary-button" disabled={!online} onclick={() => void flow?.verify(currentEvent.id)}>Vérifier ma participation</button>{/if}
            <button type="button" class="text-button" disabled={!online} onclick={() => void flow?.retry()}>Réessayer l’envoi</button>
          </div>
        </div>
      {:else if flowState.phase === 'error' && !ended && !paused && !notStarted}
        <button type="button" class="text-button" disabled={!online} onclick={() => void flow?.retry()}>Réessayer <span aria-hidden="true">↗</span></button>
      {/if}

      {#if currentEvent && (ended || paused) && !busy && !counted && flowState.phase !== 'pending'}
        <button type="button" class="text-button" disabled={!online || !ready || !serviceAvailable} onclick={() => void flow?.verify(currentEvent.id)}>Vérifier si je suis déjà compté·e</button>
      {/if}

      {#if flowState.phase === 'choosing' && flowState.choices?.length}
        <div class="event-choices">
          <h2>Quel rassemblement ?</h2>
          <p>Plusieurs périmètres correspondent à votre position.</p>
          {#each flowState.choices as event (event.id)}
            <button type="button" class="event-choice" onclick={() => void flow?.select(event.id)}><span><strong>{event.name}</strong><small>{event.cityName}</small></span><span aria-hidden="true">↗</span></button>
          {/each}
        </div>
      {/if}
    </div>

    <div class="counter-column">
      <div class="counter-heading"><span class="eyebrow">{currentEvent ? 'LE COMPTEUR DU RASSEMBLEMENT' : 'CHAQUE PRÉSENCE COMPTE'}</span><span class="counter-symbol" aria-hidden="true">+</span></div>
      <p class="counter-number" aria-label={currentSnapshot ? `${total} participations comptées pour cet événement` : 'Aucun rassemblement sélectionné'}>{total}</p>
      <p class="counter-caption">personnes se sont<br />comptées {currentEvent ? 'ici' : 'sur place'}<span class="title-dot">.</span></p>
      <div class="counter-footnote">
        {#if currentEvent && currentSnapshot}
          <span class="connection-dot" class:disconnected={connection !== 'live' || !online} aria-hidden="true"></span>
          <p>{!online || connection === 'offline' ? 'Hors ligne · dernier chiffre reçu' : connection === 'live' ? 'Compteur connecté' : 'Actualisation en cours…'}</p>
        {:else}<p>Le compteur de votre rassemblement apparaîtra après sa sélection.</p>{/if}
      </div>
      {#if integrity === 'anomaly'}<p class="notice">Une anomalie est en cours d’examen. Ce chiffre est à interpréter avec prudence.</p>{/if}
      <div class="national-count"><span>AUJOURD’HUI, EN FRANCE</span><strong>{national}</strong><p>participations enregistrées au total<br /><span class="muted">Une personne peut participer à plusieurs événements.</span></p></div>
    </div>
  </div>

  {#if !currentEvent}
    <EventDiscovery {events} {serviceAvailable} />
  {:else}
    <nav class="discovery-links" aria-label="Autres rassemblements"><a href="/#rassemblements">Rechercher d’autres rassemblements <span aria-hidden="true">↗</span></a><a href="/creer">Créer un rassemblement <span aria-hidden="true">↗</span></a></nav>
  {/if}

  <div class="method-link-row"><p>Un comptage volontaire.<br />Pas une estimation de toute la foule.</p><a href="/comment-ca-marche">Comment ça marche ? <span aria-hidden="true">↗</span></a></div>
</section>

<style>
  .event-tools { min-width: 0; }
  .discovery-links { display: flex; flex-wrap: wrap; gap: 12px 28px; padding-top: 22px; }
  .discovery-links a { display: inline-flex; align-items: center; min-height: 44px; font-size: 12px; gap: 9px; }
  @media (max-width: 700px) { .discovery-links { gap: 5px 20px; } }
</style>
