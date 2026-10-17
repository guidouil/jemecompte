<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { createParticipationFlow } from '#lib/client/participation';
  import { createSupportFlow, type SupportFlowState } from '#lib/client/support';
  import { subscribeCounters } from '#lib/client/counter-stream';
  import { mergeCounterSnapshots } from '#lib/client/counter-snapshot';
  import BrandMark from './BrandMark.svelte';
  import EventDiscovery from './EventDiscovery.svelte';
  import EventPerimeter from './EventPerimeter.svelte';
  import EventShare from './EventShare.svelte';
  import type { CounterSnapshot, FlowState, PublicEvent } from '#lib/shared/types';

  interface Props {
    events: PublicEvent[];
    selectedEvent: PublicEvent | null;
    snapshot: CounterSnapshot | null;
    nationalTotal: string;
    nationalCityTotal?: string;
    nationalSupportTotal?: string;
    nationalCitySupportTotal?: string;
    nationalLoadedAt?: string | null;
    serviceAvailable: boolean;
  }

  let { events, selectedEvent, snapshot, nationalTotal, nationalCityTotal, nationalSupportTotal, nationalCitySupportTotal, nationalLoadedAt, serviceAvailable }: Props = $props();
  let selectedOverride = $state<PublicEvent | null>(null);
  let latestSnapshot = $state<CounterSnapshot | null>(null);
  let flowState = $state<FlowState>({ phase: 'idle', message: '' });
  let supportState = $state<SupportFlowState>({ phase: 'idle', message: '' });
  let confirmationTotal = $state<string | null>(null);
  let verifying = $state(false);
  let verifyingSupport = $state(false);
  let online = $state(true);
  let ready = $state(false);
  let now = $state(Date.now());
  let connection = $state<'live' | 'reconnecting' | 'offline'>('reconnecting');
  let flow: ReturnType<typeof createParticipationFlow> | undefined;
  let supportFlow: ReturnType<typeof createSupportFlow> | undefined;

  const numberFormat = new Intl.NumberFormat('fr-FR');
  const dateFormat = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit'
  });
  const updateDateFormat = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const STALE_SNAPSHOT_MS = 60_000;

  let currentEvent = $derived(selectedOverride ?? selectedEvent);
  let isCity = $derived(currentEvent?.countingScope === 'city');
  let cityChoices = $derived(flowState.choices?.some((event) => event.countingScope === 'city') ?? false);
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
  let currentSupportState = $derived(supportState.eventId === currentEvent?.id ? supportState : null);
  let supportBusy = $derived(supportState.phase === 'submitting');
  let supportPending = $derived(supportState.phase === 'pending');
  let supported = $derived(currentSupportState?.phase === 'supported');
  let counted = $derived(flowState.phase === 'counted' || flowState.phase === 'already_counted' || currentSupportState?.phase === 'present');
  let noEvents = $derived(!currentEvent && events.length === 0);
  let disabled = $derived(!ready || !serviceAvailable || !online || noEvents || busy || supportBusy || supportPending || counted || ended || notStarted || paused || flowState.phase === 'pending' || flowState.phase === 'choosing');
  let supportDisabled = $derived(!ready || !serviceAvailable || !online || busy || supportBusy || supportPending || counted || supported || ended || notStarted || paused || flowState.phase === 'pending' || flowState.phase === 'choosing');
  let participationTotal = $derived(currentEvent ? currentSnapshot?.total : nationalTotal);
  let supportTotal = $derived(currentEvent ? currentSnapshot?.supportTotal : nationalSupportTotal);
  let total = $derived(serviceAvailable ? combinedCount(participationTotal, supportTotal) : '—');
  let snapshotAge = $derived(currentSnapshot ? Math.max(0, now - Date.parse(currentSnapshot.serverTime)) : 0);
  let staleSnapshot = $derived(Boolean(currentSnapshot && snapshotAge >= STALE_SNAPSHOT_MS));
  let snapshotIsCity = $derived((currentSnapshot?.countingScope ?? currentEvent?.countingScope) === 'city');
  let nationalParticipations = $derived(currentSnapshot?.nationalTotal ?? nationalTotal);
  let nationalSupports = $derived(currentSnapshot ? currentSnapshot.nationalSupportTotal : nationalSupportTotal);
  let national = $derived(serviceAvailable ? combinedCount(nationalParticipations, nationalSupports) : '—');
  let nationalCities = $derived(serviceAvailable ? combinedCount(nationalCityTotal, nationalCitySupportTotal) : '—');
  let nationalLoadTime = $derived(nationalLoadedAt && Number.isFinite(Date.parse(nationalLoadedAt)) ? nationalLoadedAt : null);
  let buttonText = $derived(
    flowState.phase === 'locating' ? isCity ? 'VÉRIFICATION DANS LA COMMUNE…' : 'VÉRIFICATION SUR PLACE…' :
    flowState.phase === 'submitting' ? verifying ? 'VÉRIFICATION EN COURS…' : 'COMPTAGE EN COURS…' :
    counted ? 'VOUS ÊTES COMPTÉ·E' :
    ended ? 'COMPTAGE TERMINÉ' :
    paused ? 'COMPTAGE EN PAUSE' :
    notStarted ? 'BIENTÔT OUVERT' :
    !serviceAvailable ? 'SERVICE INDISPONIBLE' :
    noEvents ? 'AUCUN COMPTAGE' :
    !online ? 'VOUS ÊTES HORS LIGNE' : isCity ? 'ME COMPTER DANS CETTE VILLE' : 'JE ME COMPTE'
  );

  function formatCount(value: string) {
    try { return numberFormat.format(BigInt(value)); } catch { return '—'; }
  }

  function availableCount(value: string | undefined) {
    return serviceAvailable && value !== undefined ? formatCount(value) : '—';
  }

  function combinedCount(presences: string | undefined, supports: string | undefined) {
    if (presences === undefined || supports === undefined) return '—';
    try { return numberFormat.format(BigInt(presences) + BigInt(supports)); } catch { return '—'; }
  }

  function formatAge(milliseconds: number) {
    if (milliseconds < 60_000) return 'moins d’une minute';
    const minutes = Math.floor(milliseconds / 60_000);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    return `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
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
      if (next.eventId) supportFlow?.markPresent(next.eventId);
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

  async function verifyParticipation() {
    if (!currentEvent || !flow || !ready || !online || !serviceAvailable || busy || supportBusy || supportPending || counted || flowState.phase === 'choosing') return;
    verifying = true;
    try { await flow.verify(currentEvent.id); }
    finally { verifying = false; }
  }

  function support() {
    if (currentEvent && !supportDisabled) void supportFlow?.support(currentEvent.id);
  }

  async function verifySupport() {
    if (!currentEvent || !supportFlow || !ready || !online || !serviceAvailable || busy || supportBusy || counted || flowState.phase === 'pending' || flowState.phase === 'choosing') return;
    verifyingSupport = true;
    try { await supportFlow.verify(currentEvent.id); }
    finally { verifyingSupport = false; }
  }

  onMount(() => {
    online = navigator.onLine;
    now = Date.now();
    const updateConnection = () => { online = navigator.onLine; now = Date.now(); };
    window.addEventListener('online', updateConnection);
    window.addEventListener('offline', updateConnection);
    document.addEventListener('visibilitychange', updateConnection);
    const timer = window.setInterval(() => { now = Date.now(); }, 15_000);
    flow = createParticipationFlow({
      getEvents: () => events,
      onChange: receiveFlow,
      onEvent: (event) => { selectedOverride = event; },
      onSnapshot: receiveSnapshot
    });
    supportFlow = createSupportFlow({
      getEvents: () => currentEvent
        ? [...events.filter((event) => event.id !== currentEvent.id), currentEvent] : events,
      onChange: (next) => { supportState = next; },
      onSnapshot: receiveSnapshot
    });
    ready = true;
    return () => {
      flow?.destroy();
      supportFlow?.destroy();
      window.clearInterval(timer);
      window.removeEventListener('online', updateConnection);
      window.removeEventListener('offline', updateConnection);
      document.removeEventListener('visibilitychange', updateConnection);
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
    <p class="eyebrow">UN GESTE SIMPLE. UNE MOBILISATION COLLECTIVE.</p>
    <a class="intro-method-link" href="/comment-ca-marche">Le principe <span aria-hidden="true">↗</span></a>
  </div>

  <div class="count-stage">
    <div class="action-column">
      {#if currentEvent}
        <div class="event-meta"><span>{currentEvent.cityName}</span><span>{isCity ? 'COMMUNE ENTIÈRE' : 'RASSEMBLEMENT'}</span></div>
      {/if}
      <h1 id="count-title" class="hero-title" class:event-title={currentEvent !== null}>{#if currentEvent}{currentEvent.name}{:else}JE ME<br />COMPTE{/if}</h1>
      <p class="hero-signature">On est là, on se compte</p>
      <p class="hero-description">{#if isCity}Un comptage dans toute la commune.<br />Déclarez votre participation ou votre soutien.{:else if currentEvent}Sur place ou à distance,<br />faites compter votre mobilisation.{:else}Votre présence compte. Votre soutien aussi.<br />Participez à la mobilisation qui vous rassemble.{/if}</p>

      {#if currentEvent}
        <div class="event-context">
          <p>{#if isCity}Fenêtre de comptage :<br />{/if}Du {dateFormat.format(new Date(currentEvent.startsAt))}<br />au {dateFormat.format(new Date(currentEvent.endsAt))} <span class="muted">(heure de Paris)</span></p>
          {#if isCity}<p id="city-scope-note" class="notice">Ce comptage couvre la commune entière de {currentEvent.cityName}. Cette page ne confirme aucun lieu ni horaire de manifestation. Être dans la commune ne prouve pas une participation à une manifestation.</p>{/if}
          {#if currentEvent.description}<p class="event-description">{currentEvent.description}</p>{/if}
          {#if ended}<p class="event-state">Ce comptage est terminé.</p>
          {:else if paused}<p class="event-state">Les nouvelles participations sont momentanément suspendues.</p>
          {:else if notStarted}<p class="event-state">{isCity ? 'Le comptage ouvrira à l’heure indiquée.' : 'Le comptage ouvrira au début de l’événement.'}</p>{/if}
        </div>
      {/if}

      <div class="presence-action">
      <div class="action-label"><span class="action-mode">{isCity ? 'DANS LA COMMUNE' : 'SUR PLACE'}</span><span class="action-detail">Présence déclarée</span></div>
      <button type="button" class="count-button" class:is-counted={counted} onclick={count} {disabled} aria-describedby={isCity ? 'privacy-promise city-scope-note participation-feedback' : 'privacy-promise participation-feedback'} aria-busy={busy}>
        <span>{buttonText}</span>
        <span aria-hidden="true">{counted ? '✓' : busy ? '· · ·' : '↗'}</span>
      </button>

      <p id="privacy-promise" class="privacy-promise"><strong>Présence sur place, sans inscription.</strong> Votre position précise est vérifiée dans votre navigateur et n’est pas envoyée à JeMeCompte.</p>
      <noscript><p class="notice">JavaScript est nécessaire pour vérifier votre position sur votre appareil et participer.</p></noscript>

      <div id="participation-feedback" class="participation-feedback" class:success-feedback={counted && confirmationTotal !== null} role="status" aria-live="polite" aria-atomic="true">
        {#if counted && confirmationTotal !== null}
          <p>{flowState.phase === 'already_counted' ? 'Vous êtes déjà compté·e.' : 'Vous êtes compté·e.'} <strong>{confirmationTotal}</strong> {isCity ? 'participations déclarées dans cette commune.' : 'participations enregistrées pour cet événement.'}</p>
        {:else if flowState.message}<p class:error-message={flowState.phase === 'error'}>{flowState.message}</p>{/if}
      </div>

      {#if currentEvent && !counted && flowState.phase !== 'pending' && flowState.phase !== 'choosing'}
        <div class="participation-recovery">
          <button type="button" class="text-button" disabled={!online || !ready || !serviceAvailable || busy || supportBusy || supportPending} onclick={() => void verifyParticipation()} aria-describedby="participation-recovery-help" aria-busy={verifying}>{verifying ? 'Vérification de ma participation…' : ended || paused ? 'Vérifier si je suis déjà compté·e' : 'Vérifier ma participation'}</button>
          <p id="participation-recovery-help">Retrouvez une confirmation sur ce navigateur, sans demander votre position. Cette vérification n’ajoute aucune participation.</p>
        </div>
      {/if}

      </div>

      <div class="support-action">
        <div class="action-label"><span class="action-mode">À DISTANCE</span><span class="action-detail">Soutien déclaré</span></div>
        {#if currentEvent}
          <button type="button" class="secondary-button support-button" class:is-supported={supported} onclick={support} disabled={supportDisabled} aria-describedby="support-help support-feedback" aria-busy={supportBusy}>
            <span>{supportBusy ? verifyingSupport ? 'Vérification de mon soutien…' : 'Soutien en cours…' : counted ? 'Votre présence est comptée' : supported ? 'Votre soutien est compté' : 'Je soutiens à distance'}</span>
            <span aria-hidden="true">{supported || counted ? '✓' : '↗'}</span>
          </button>
        {:else}
          <a class="secondary-button support-button" href="#rassemblements" aria-describedby="support-help">Choisir un événement à soutenir <span aria-hidden="true">↗</span></a>
        {/if}
        <p id="support-help" class="support-help"><strong>Aucune géolocalisation.</strong> Un seul événement soutenu par jour, selon l’heure de Paris, et un seul soutien par événement. Un identifiant conservé dans ce navigateur limite les doublons, sans compte ni nom demandé. Il peut être effacé dans les réglages de confidentialité du site.</p>
        <div id="support-feedback" class="support-feedback" class:success-feedback={supported} role="status" aria-live="polite" aria-atomic="true">
          {#if currentSupportState?.message}<p class:error-message={currentSupportState.phase === 'error'}>{currentSupportState.message}</p>{/if}
          {#if supported}<p>Vous venez finalement sur place ? Vous pouvez déclarer votre présence ci-dessus : elle remplacera votre soutien.</p>{/if}
        </div>
        {#if currentEvent && !supported && !counted}
          <div class="support-recovery">
            <button type="button" class="text-button" disabled={!online || !ready || !serviceAvailable || busy || supportBusy || flowState.phase === 'pending' || flowState.phase === 'choosing'} onclick={() => void verifySupport()} aria-busy={verifyingSupport}>{verifyingSupport ? 'Vérification de mon soutien…' : 'Vérifier mon soutien'}</button>
            <p>Retrouvez une confirmation sur ce navigateur. Cette vérification n’ajoute aucun soutien.</p>
          </div>
        {/if}
        {#if currentSupportState?.phase === 'pending'}
          <div class="notice">
            <p><strong>Confirmation du soutien en attente.</strong> Le serveur a peut-être reçu votre soutien. Aucun envoi automatique n’est effectué.</p>
            <button type="button" class="text-button" disabled={!online || !ready || !serviceAvailable || busy || supportBusy} onclick={() => void supportFlow?.retry()}>Vérifier puis réessayer le soutien <span aria-hidden="true">↗</span></button>
          </div>
        {:else if currentSupportState?.phase === 'error' && !ended && !paused && !notStarted && currentSupportState.code !== 'daily_limit_reached' && currentSupportState.code !== 'details_expired'}
          <button type="button" class="text-button" disabled={!online || !ready || !serviceAvailable || busy || supportBusy || flowState.phase === 'pending'} onclick={() => void supportFlow?.retry()}>Réessayer le soutien <span aria-hidden="true">↗</span></button>
        {/if}
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
            {#if currentEvent}<button type="button" class="secondary-button" disabled={!online || !ready || !serviceAvailable || busy || supportBusy || supportPending} onclick={() => void verifyParticipation()}>Vérifier ma participation</button>{/if}
            <button type="button" class="text-button" disabled={!online || supportBusy || supportPending} onclick={() => void flow?.retry()}>Réessayer l’envoi</button>
          </div>
        </div>
      {:else if flowState.phase === 'error' && !ended && !paused && !notStarted}
        <button type="button" class="text-button" disabled={!online || supportBusy || supportPending} onclick={() => void flow?.retry()}>Réessayer <span aria-hidden="true">↗</span></button>
      {/if}

      {#if flowState.phase === 'choosing' && flowState.choices?.length}
        <div class="event-choices">
          <h2>{cityChoices ? flowState.choices.length === 1 ? 'Confirmer ce comptage de commune' : 'Quel comptage ?' : 'Quel rassemblement ?'}</h2>
          <p>{flowState.choices.length === 1 ? 'Une zone de commune entière correspond à votre position. Choisissez explicitement ce comptage pour continuer.' : 'Plusieurs périmètres correspondent à votre position.'}</p>
          {#if cityChoices}<p id="city-choice-note">Un comptage de commune couvre toute la commune. Il ne confirme aucun lieu de manifestation et ne prouve pas une participation à une manifestation.</p>{/if}
          {#each flowState.choices as event (event.id)}
            <button type="button" class="event-choice" onclick={() => void flow?.select(event.id)} aria-describedby={event.countingScope === 'city' ? 'city-choice-note' : undefined}><span><strong>{event.name}</strong><small>{event.cityName}{event.countingScope === 'city' ? ' · Commune entière' : ''}</small></span>{#if event.countingScope === 'city'}<span class="city-choice-action">ME COMPTER DANS CETTE VILLE</span>{:else}<span aria-hidden="true">↗</span>{/if}</button>
          {/each}
        </div>
      {/if}
    </div>

    <div class="counter-column" data-counting-scope={isCity ? 'city' : 'gathering'}>
      <div class="counter-heading"><span class="eyebrow">{isCity ? 'LE COMPTEUR DE LA COMMUNE' : currentEvent ? 'LE COMPTEUR DU RASSEMBLEMENT' : 'AUJOURD’HUI, EN FRANCE · RASSEMBLEMENTS LOCALISÉS'}</span><span class="counter-symbol" aria-hidden="true"><BrandMark /></span></div>
      <p class="counter-number" aria-label={total === '—' ? 'Total des participations et soutiens indisponible' : currentEvent ? `${total} participations et soutiens ${isCity ? 'pour ce comptage de commune' : 'pour cet événement'}` : `${total} participations et soutiens aujourd’hui en France pour les rassemblements localisés`}>{total}</p>
      <p class="counter-caption">participations et soutiens<br />{isCity ? 'pour ce comptage de commune' : currentEvent ? 'pour cet événement' : 'aujourd’hui en France'}</p>
      <div class="counter-breakdown">
        <p><strong>{availableCount(participationTotal)}</strong><span>participations<br />{isCity ? 'dans la commune' : 'sur place'}</span></p>
        <p><strong>{availableCount(supportTotal)}</strong><span>soutiens à distance</span></p>
      </div>
      {#if serviceAvailable && supportTotal === undefined}<p class="counter-unavailable">Le total des soutiens est momentanément indisponible.</p>{/if}
      <div class="counter-footnote">
        {#if currentEvent && currentSnapshot}
          <span class="connection-dot" class:disconnected={connection !== 'live' || !online || staleSnapshot} aria-hidden="true"></span>
          <div>
            <p>{!online || connection === 'offline' ? 'Hors ligne · dernier chiffre reçu' : staleSnapshot ? 'Chiffre ancien · actualisation en attente' : connection === 'live' ? 'Compteur connecté' : 'Actualisation en cours…'}</p>
            <p class="counter-updated">Dernière mise à jour : <time datetime={currentSnapshot.serverTime}>{updateDateFormat.format(new Date(currentSnapshot.serverTime))}</time> (heure de Paris), il y a {formatAge(snapshotAge)}.</p>
          </div>
        {:else if currentEvent}<p>Le compteur de ce comptage est momentanément indisponible.</p>
        {:else if serviceAvailable}<p>Ces déclarations ne représentent pas un nombre de personnes uniques.</p>
        {:else}<p>Le total national est momentanément indisponible.</p>{/if}
      </div>
      {#if staleSnapshot}<p class="notice counter-stale-warning" role="status">Ce chiffre date de plus d’une minute et peut avoir évolué. Attendez une nouvelle mise à jour du serveur.</p>{/if}
      {#if integrity === 'anomaly'}<p class="notice">Une anomalie est en cours d’examen. Ce chiffre est à interpréter avec prudence.</p>{/if}
      {#if currentEvent}
      <div class="national-count" data-counting-scope={currentSnapshot && snapshotIsCity ? 'city' : 'gathering'}><span>AUJOURD’HUI, EN FRANCE · {currentSnapshot && snapshotIsCity ? 'COMMUNES ENTIÈRES' : 'RASSEMBLEMENTS LOCALISÉS'}</span><strong>{national}</strong><p>participations et soutiens<br />{availableCount(nationalParticipations)} participations {currentSnapshot && snapshotIsCity ? 'dans les communes' : 'sur place'} · {availableCount(nationalSupports)} soutiens à distance<br /><span class="muted">Une personne peut contribuer à plusieurs comptages.</span></p></div>
      {/if}
      {#if !currentSnapshot}
        <div class="national-count" data-counting-scope="city"><span>AUJOURD’HUI, EN FRANCE · COMMUNES ENTIÈRES</span><strong>{nationalCities}</strong><p>participations et soutiens<br />{availableCount(nationalCityTotal)} participations dans les communes · {availableCount(nationalCitySupportTotal)} soutiens à distance</p></div>
        <p class="national-families-note">Ces comptages ont des portées différentes. Une même personne peut contribuer aux deux familles.</p>
        {#if nationalLoadTime}<p class="national-loaded-at">Total chargé le <time datetime={nationalLoadTime}>{updateDateFormat.format(new Date(nationalLoadTime))}</time> (heure de Paris). Actualisez la page pour le mettre à jour.</p>{/if}
      {/if}
    </div>
  </div>

  {#if !currentEvent}
    <EventDiscovery {events} {serviceAvailable} />
  {:else}
    <nav class="discovery-links" aria-label="Autres comptages"><a href="/#rassemblements">Rechercher d’autres comptages <span aria-hidden="true">↗</span></a><a href="/creer">Créer un rassemblement <span aria-hidden="true">↗</span></a></nav>
  {/if}

  <div class="method-link-row"><p>Un comptage volontaire.<br />Pas une estimation de toute la foule.</p><a href="/comment-ca-marche">Comment ça marche ? <span aria-hidden="true">↗</span></a></div>
</section>

<style>
  .intro-line { gap: 20px; }
  .intro-line .eyebrow { max-width: none; color: var(--muted); }
  .intro-method-link { flex-shrink: 0; min-height: 44px; display: inline-flex; align-items: center; gap: 8px; font-size: 12px; text-decoration: none; }
  .intro-method-link:hover { text-decoration: underline; }
  .count-stage { grid-template-columns: minmax(0, 1.12fr) minmax(0, 1fr); align-items: start; }
  .action-column { min-width: 0; }
  .hero-title { overflow-wrap: anywhere; }
  .hero-title.event-title { margin-top: 18px; font-size: clamp(36px, 4.6vw, 62px); line-height: 1.05; letter-spacing: -0.055em; text-wrap: balance; }
  .hero-signature { color: var(--accent-ink); margin-top: 22px; font-family: Georgia, 'Times New Roman', serif; font-size: clamp(24px, 2.7vw, 33px); font-style: italic; line-height: 1.25; letter-spacing: -0.045em; }
  .event-title + .hero-signature { margin-top: 15px; font-size: 25px; }
  .hero-description { margin-top: 18px; font-size: 18px; line-height: 1.55; letter-spacing: -0.025em; }
  .event-meta { justify-content: flex-start; flex-wrap: wrap; gap: 8px 14px; color: var(--accent-ink); font-size: 10px; line-height: 1.5; }
  .event-meta span:last-child { color: var(--muted); }
  .event-context { margin-top: 22px; padding-top: 18px; }
  .event-context > p { font-size: 13px; line-height: 1.7; }
  .event-context > .notice { font-size: 12px; }
  .event-description { color: var(--muted); white-space: pre-line; overflow-wrap: anywhere; }
  .presence-action { margin-top: 26px; padding: 20px; border: 1px solid var(--line); border-radius: 24px; background: var(--surface); }
  .action-label { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
  .action-mode { color: var(--accent-ink); font-size: 10px; font-weight: 800; letter-spacing: 0.1em; line-height: 1.5; }
  .action-detail { color: var(--muted); font-size: 11px; line-height: 1.5; text-align: right; }
  .count-button { margin-top: 14px; min-height: 76px; padding: 18px 20px; border-radius: 16px; font-size: 20px; line-height: 1.3; }
  .count-button.is-counted { color: var(--success); border-color: var(--success); background: var(--success-surface); }
  .privacy-promise { max-width: none; margin-top: 13px; font-size: 12px; line-height: 1.6; }
  .participation-recovery { margin-top: 8px; }
  .participation-recovery p { color: var(--muted); font-size: 12px; line-height: 1.6; }
  .participation-recovery .text-button { padding-bottom: 5px; font-size: 12px; }
  .participation-feedback p { margin-top: 14px; font-size: 13px; line-height: 1.6; }
  .participation-feedback.success-feedback, .support-feedback.success-feedback { margin-top: 14px; padding: 14px 15px; border: 1px solid var(--success); border-radius: 14px; color: var(--success); background: var(--success-surface); animation: confirm 240ms ease-out; }
  .success-feedback::before { content: '✓'; display: block; font-weight: 800; font-size: 22px; line-height: 1; margin-bottom: 6px; }
  .participation-feedback.success-feedback p, .support-feedback.success-feedback p { margin-top: 0; color: var(--success); font-weight: 500; }
  .success-feedback strong { font-weight: 800; }
  .participation-feedback .error-message, .support-feedback .error-message { padding: 13px 14px; border: 1px solid var(--error); border-radius: 12px; color: var(--error); background: var(--surface); }
  .support-action { margin-top: 14px; padding: 20px; border: 1px solid var(--line); border-radius: 24px; background: var(--surface-soft); }
  .support-action .action-mode { color: var(--ink); }
  .support-button { width: 100%; justify-content: space-between; margin-top: 14px; border-color: var(--ink); border-radius: 16px; min-height: 62px; font-size: 16px; text-align: left; background: var(--surface); }
  .support-button > span:last-child { font-size: 23px; flex-shrink: 0; }
  .support-button.is-supported { color: var(--success); border-color: var(--success); background: var(--success-surface); }
  .support-help, .support-recovery p { color: var(--muted); font-size: 12px; line-height: 1.65; margin-top: 11px; }
  .support-help strong { color: var(--ink); }
  .support-feedback { color: var(--success); font-size: 13px; line-height: 1.7; }
  .support-feedback p { margin-top: 12px; }
  .support-feedback.success-feedback p + p { margin-top: 8px; }
  .support-recovery { margin-top: 5px; }
  .support-recovery p { margin-top: 0; }
  .support-recovery .text-button { font-size: 12px; padding-bottom: 5px; }
  .event-tools { min-width: 0; margin-top: 22px; }
  .counter-column { border: 1px solid var(--line); border-radius: 28px; padding: 28px; background: var(--surface); }
  .counter-heading { gap: 16px; align-items: center; }
  .counter-heading > .eyebrow { max-width: 230px; font-size: 10px; line-height: 1.7; color: var(--muted); }
  .counter-symbol { display: block; width: 56px; height: 56px; flex-shrink: 0; }
  .counter-symbol :global(svg) { width: 100%; height: 100%; }
  .counter-number { margin-top: 30px; font-size: clamp(76px, 9.2vw, 124px); letter-spacing: -0.075em; line-height: 1; }
  .counter-caption { margin-top: 12px; font-size: clamp(23px, 2.3vw, 29px); line-height: 1.2; letter-spacing: -0.045em; text-wrap: balance; }
  .counter-breakdown { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; margin-top: 26px; padding: 20px 0; border-block: 1px solid var(--line); }
  .counter-breakdown p { display: flex; flex-direction: column; gap: 7px; min-width: 0; font-size: 12px; line-height: 1.5; color: var(--muted); }
  .counter-breakdown p + p { border-left: 1px solid var(--line); padding-left: 16px; }
  .counter-breakdown strong { color: var(--ink); font-size: 29px; line-height: 1; letter-spacing: -0.04em; font-weight: 800; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .counter-breakdown p:first-child strong { color: var(--accent-ink); }
  .counter-unavailable { margin-top: 10px; color: var(--muted); font-size: 12px; line-height: 1.7; }
  .counter-footnote { align-items: flex-start; margin-top: 16px; }
  .counter-footnote .connection-dot { margin-top: 6px; }
  .counter-footnote p { font-size: 12px; line-height: 1.6; }
  .counter-updated { margin-top: 5px; }
  .counter-stale-warning { margin-top: 12px; }
  .national-count { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 8px 16px; margin-top: 24px; padding-top: 22px; }
  .national-count > span { font-size: 9px; line-height: 1.7; letter-spacing: 0.08em; }
  .national-count > strong { grid-column: 2; grid-row: 1 / 3; margin: 0; font-size: 31px; letter-spacing: -0.045em; overflow-wrap: anywhere; max-width: 5em; }
  .national-count > p { font-size: 11px; line-height: 1.7; }
  .national-families-note, .national-loaded-at { margin-top: 12px; color: var(--muted); font-size: 11px; line-height: 1.7; }
  .event-choices { border: 1px solid var(--line); background: var(--surface); border-radius: 20px; padding: 20px; }
  .event-choices h2 { line-height: 1.4; }
  .event-choice { padding-inline: 8px; border-radius: 10px; }
  .city-choice-action { align-self: center; max-width: 150px; font-size: 11px; font-weight: 700; line-height: 1.5; text-align: right; }
  .discovery-links { display: flex; flex-wrap: wrap; gap: 12px 28px; padding-top: 22px; }
  .discovery-links a { display: inline-flex; align-items: center; min-height: 44px; font-size: 13px; gap: 9px; }
  .method-link-row { border-top: 1px solid var(--line); margin-top: 35px; }
  @keyframes confirm { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
  @media (max-width: 1000px) and (min-width: 701px) {
    .count-stage { gap: 30px; }
    .presence-action, .support-action { padding: 17px; }
    .counter-column { padding: 23px; }
    .counter-number { font-size: 90px; }
    .count-button { padding: 17px; font-size: 18px; }
    .support-button { font-size: 15px; }
    .action-detail { font-size: 10px; }
  }
  @media (max-width: 700px) {
    .intro-line { align-items: center; gap: 12px; }
    .intro-line .eyebrow { max-width: 220px; font-size: 9px; line-height: 1.6; letter-spacing: 0.08em; }
    .intro-method-link { font-size: 11px; }
    .count-stage { grid-template-columns: minmax(0, 1fr); margin-top: 24px; gap: 24px; }
    .hero-title.event-title { margin-top: 14px; font-size: clamp(34px, 9vw, 53px); letter-spacing: -0.05em; }
    .hero-signature { margin-top: 18px; font-size: 26px; }
    .event-title + .hero-signature { font-size: 23px; }
    .hero-description { margin-top: 15px; font-size: 17px; }
    .presence-action { margin-top: 22px; padding: 16px; border-radius: 22px; }
    .count-button { min-height: 72px; margin-top: 13px; padding: 17px; font-size: 19px; }
    .support-action { padding: 16px; border-radius: 22px; }
    .support-button { min-height: 60px; font-size: 15px; }
    .privacy-promise, .participation-recovery p, .support-help, .support-recovery p { font-size: 12px; }
    .counter-column { padding: 24px; border-radius: 24px; }
    .counter-number { margin-top: 24px; font-size: clamp(82px, 25vw, 116px); letter-spacing: -0.07em; }
    .counter-caption { font-size: 26px; margin-top: 10px; }
    .counter-breakdown { margin-top: 22px; padding-block: 19px; }
    .counter-symbol { width: 52px; height: 52px; }
    .counter-heading > .eyebrow { font-size: 9px; }
    .national-count { gap: 7px 14px; }
    .national-count > strong { font-size: 30px; }
    .discovery-links { gap: 5px 20px; }
    .discovery-links a { font-size: 12px; }
    .event-choices { padding: 17px; }
    .event-choice { gap: 10px; }
    .city-choice-action { max-width: 120px; font-size: 10px; }
    .method-link-row { margin-top: 28px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .participation-feedback.success-feedback, .support-feedback.success-feedback { animation: none; }
  }
</style>
