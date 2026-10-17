<script lang="ts">
  import { AdmissionClientError, getAdmissionProof } from '#lib/client/admission';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import CreationMap from '#lib/components/CreationMap.svelte';
  import { distanceMeters, geofenceCenter, type GeoPoint } from '#lib/shared/geo';
  import { DEFAULT_EVENT_RADIUS_METERS, MIN_EVENT_RADIUS_METERS, MAX_EVENT_RADIUS_METERS, DEFAULT_EVENT_DURATION_MINUTES, EVENT_DURATIONS } from '#lib/shared/event-limits';
  import { parseParisDateTime, parisDateTimeParts, formatEventDateTime } from '#lib/shared/event-schedule';
  import { clearEventCreationDraft, loadEventCreationDraft, saveEventCreationDraft, type EventCreationDraft } from '#lib/client/event-creation-draft';
  import type { CountingScope, EventGeofence, PublicEvent } from '#lib/shared/types';
  import type { PageData } from './$types';

  interface Place { code: string; name: string; center: GeoPoint }
  let { data }: { data: PageData } = $props();
  let step = $state<1 | 2 | 3>(1);
  let cityQuery = $state('');
  let places = $state<Place[]>([]);
  let searching = $state(false);
  let placeMessage = $state('');
  let city = $state<Place | null>(null);
  let countingScope = $state<CountingScope>('city');
  let cityBoundary = $state<EventGeofence | null>(null);
  let boundaryLoading = $state(false);
  let boundaryMessage = $state('');
  let point = $state<GeoPoint | null>(null);
  let view = $state<GeoPoint>([2.347, 48.8589]);
  let radius = $state<number | undefined>(DEFAULT_EVENT_RADIUS_METERS);
  let duration = $state<number>(DEFAULT_EVENT_DURATION_MINUTES);
  let startMode = $state<'now' | 'custom'>('now');
  let startDate = $state('');
  let startTime = $state('');
  let now = $state(Date.now());
  let name = $state('');
  let confirmed = $state(false);
  let submitting = $state(false);
  let message = $state('');
  let pendingDraft = $state<EventCreationDraft | null>(null);
  let pendingBody = $derived(pendingDraft ? JSON.stringify(pendingDraft.payload) : null);
  let recoveredRequest = $state(false);
  let confirmAbandon = $state(false);
  let draftNotice = $state('');
  let storageNotice = $state('');
  let createdEvent = $state<PublicEvent | null>(null);
  let online = $state(true);
  let ready = $state(false);
  let searchController: AbortController | undefined;
  let boundaryController: AbortController | undefined;
  let heading: HTMLHeadingElement;
  const radiusPresets = [500, 1_000, 2_000, 5_000, 10_000];
  const numberFormat = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
  let validRadius = $derived(typeof radius === 'number' && Number.isInteger(radius) &&
    radius >= MIN_EVENT_RADIUS_METERS && radius <= MAX_EVENT_RADIUS_METERS);
  // An empty or out-of-range number field must never reach the map geometry calculation.
  let previewRadius = $derived(validRadius ? radius! : DEFAULT_EVENT_RADIUS_METERS);
  let validDuration = $derived(EVENT_DURATIONS.some((minutes) => minutes === duration));
  let parsedStart = $derived(startMode === 'custom' ? parseParisDateTime(startDate, startTime) : null);
  let startInstant = $derived(startMode === 'now' ? now : parsedStart?.status === 'valid' ? Date.parse(parsedStart.startsAt) : null);
  let endInstant = $derived(startInstant !== null && validDuration ? startInstant + duration * 60_000 : null);
  let scheduleError = $derived.by(() => {
    if (!validDuration) return 'Choisissez une des durées proposées.';
    if (startMode === 'custom') {
      if (!startDate || !startTime) return 'Renseignez la date et l’heure de début.';
      if (parsedStart?.status === 'nonexistent') return 'Cette heure n’existe pas à Paris lors du passage à l’heure d’été. Choisissez une autre heure.';
      if (parsedStart?.status === 'ambiguous') return 'Cette heure correspond à deux instants à Paris lors du passage à l’heure d’hiver. Choisissez une autre heure.';
      if (parsedStart?.status !== 'valid') return 'Indiquez une date et une heure de début valides.';
    }
    if (endInstant === null || !Number.isFinite(endInstant)) return 'Vérifiez le début et la durée du comptage.';
    if (endInstant <= now) return 'Avec cette durée, le comptage serait déjà terminé. Choisissez un début plus récent ou une durée plus longue.';
    return '';
  });
  let validSchedule = $derived(scheduleError === '');
  let startsInFuture = $derived(startMode === 'custom' && startInstant !== null && startInstant > now);
  let isCity = $derived(countingScope === 'city');
  let validZone = $derived(Boolean(city && (isCity ? cityBoundary && !boundaryLoading : point)));

  let nearby = $derived.by(() => {
    if (isCity) return data.events.filter((event) => event.countingScope === 'city' && event.cityCode === city?.code &&
      ['published', 'paused'].includes(event.status) && Date.parse(event.endsAt) > now).slice(0, 5);
    if (!point) return [] as PublicEvent[];
    const center = point;
    // A whole-commune participation is distinct from a local gathering, not a duplicate zone.
    return data.events.filter((event) => event.countingScope !== 'city' && event.geofence.type === 'Polygon' &&
        ['published', 'paused'].includes(event.status) && Date.parse(event.endsAt) > now)
      .map((event) => {
        const eventCenter = geofenceCenter(event.geofence);
        const extent = Math.max(...event.geofence.coordinates[0]!.map((vertex) => distanceMeters(eventCenter, vertex as GeoPoint)));
        return { event, distance: distanceMeters(center, eventCenter), extent };
      })
      // Bounding circles conservatively suggest overlapping zones, including large existing events.
      .filter(({ distance, extent }) => distance <= Math.max(1_500, previewRadius + extent))
      .sort((a, b) => a.distance - b.distance).slice(0, 5).map(({ event }) => event);
  });
  let validDetails = $derived(name.trim().length >= 3 && name.trim().length <= 120 && (isCity || validRadius) && validSchedule);
  // A lost response must remain retryable with its original body, even after its chosen end time.
  let canSubmit = $derived(ready && online && data.serviceAvailable && !submitting && !createdEvent && !confirmAbandon &&
    (Boolean(pendingBody) || validZone && validDetails && confirmed));

  function restoreDraft(draft: EventCreationDraft) {
    const payload = draft.payload;
    pendingDraft = draft;
    name = payload.name;
    countingScope = payload.countingScope === 'city' ? 'city' : 'gathering';
    const center = payload.countingScope === 'city' ? view : payload.publicCenter;
    city = { code: payload.cityCode, name: payload.cityName, center };
    cityQuery = payload.cityName;
    point = payload.countingScope === 'city' ? null : payload.publicCenter;
    view = center;
    radius = payload.countingScope === 'city' ? DEFAULT_EVENT_RADIUS_METERS : payload.radiusMeters;
    duration = payload.durationMinutes;
    startMode = payload.startsAt ? 'custom' : 'now';
    if (payload.startsAt) {
      const parts = parisDateTimeParts(Date.parse(payload.startsAt));
      startDate = parts.date;
      startTime = parts.time;
    }
    step = 3;
    confirmed = true;
    recoveredRequest = true;
    draftNotice = 'Une demande confirmée a été retrouvée dans cet onglet. Le serveur a peut-être déjà créé ce comptage. Reprenez la même demande pour retrouver sa confirmation ; aucun nouvel envoi n’est automatique.';
    if (payload.countingScope === 'city') void loadBoundary(city);
  }

  onMount(() => {
    online = navigator.onLine;
    now = Date.now();
    const saved = loadEventCreationDraft(now);
    if (saved.status === 'ready') restoreDraft(saved.draft);
    else if (saved.status === 'expired') draftNotice = 'Une ancienne demande de création a expiré après 24 heures dans cet onglet. Le comptage peut déjà exister : recherchez-le avant d’en créer un autre.';
    else if (saved.status === 'invalid') draftNotice = 'La demande enregistrée dans cet onglet est illisible et a été retirée. Un comptage peut déjà avoir été créé : recherchez-le avant de recommencer.';
    else if (saved.status === 'unavailable') storageNotice = 'Le stockage de cet onglet est indisponible. Vous pouvez continuer, mais gardez cette page ouverte jusqu’à la confirmation : une demande en attente serait perdue au rechargement.';
    ready = true;
    const update = () => { online = navigator.onLine; now = Date.now(); };
    const timer = window.setInterval(() => { now = Date.now(); }, 15_000);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      searchController?.abort();
      boundaryController?.abort();
      window.clearInterval(timer);
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
      document.removeEventListener('visibilitychange', update);
    };
  });

  async function searchCities(event: SubmitEvent) {
    event.preventDefault();
    searchController?.abort();
    const controller = new AbortController();
    searchController = controller;
    searching = true; placeMessage = ''; places = [];
    const timeout = window.setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(`/api/places?q=${encodeURIComponent(cityQuery.trim())}`, { signal: controller.signal });
      if (!response.ok) throw new Error('unavailable');
      const result = await response.json() as { places: Place[] };
      if (searchController !== controller) return;
      places = result.places;
      if (!places.length) placeMessage = 'Aucune ville trouvée. Essayez son nom complet.';
    } catch {
      if (searchController === controller) placeMessage = 'La recherche de villes est indisponible. Vérifiez la connexion et réessayez.';
    } finally {
      clearTimeout(timeout);
      if (searchController === controller) searching = false;
    }
  }

  function chooseCity(place: Place) {
    boundaryController?.abort();
    cityBoundary = null; boundaryMessage = ''; boundaryLoading = false;
    city = place; view = place.center; point = null; places = []; cityQuery = place.name;
    placeMessage = isCity ? `${place.name} sélectionnée.` : `${place.name} sélectionnée. Placez maintenant la zone sur un lieu public.`;
    confirmed = false;
    if (isCity) void loadBoundary(place);
  }

  async function loadBoundary(place: Place) {
    boundaryController?.abort();
    const controller = new AbortController();
    boundaryController = controller;
    cityBoundary = null; boundaryLoading = true; boundaryMessage = '';
    const timeout = window.setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(`/api/places/${encodeURIComponent(place.code)}/boundary`, { signal: controller.signal });
      if (!response.ok) throw new Error('unavailable');
      const result = await response.json() as Place & { geofence: EventGeofence };
      if (boundaryController !== controller || city?.code !== place.code || !isCity) return;
      if (result.code !== place.code || !result.geofence || !['Polygon', 'MultiPolygon'].includes(result.geofence.type)) throw new Error('invalid');
      cityBoundary = result.geofence;
      view = result.center;
      city = { code: result.code, name: pendingBody ? place.name : result.name, center: result.center };
      boundaryMessage = `Toute la commune de ${city.name} est sélectionnée, selon son contour administratif.`;
    } catch {
      if (boundaryController === controller) boundaryMessage = 'Le contour de la commune n’a pas pu être chargé. Réessayez pour sélectionner la ville entière.';
    } finally {
      clearTimeout(timeout);
      if (boundaryController === controller) boundaryLoading = false;
    }
  }

  function chooseScope(scope: CountingScope) {
    if (pendingBody || countingScope === scope) return;
    boundaryController?.abort(); boundaryController = undefined;
    countingScope = scope;
    cityBoundary = null; boundaryLoading = false; boundaryMessage = ''; confirmed = false;
    placeMessage = city ? isCity ? `${city.name} sélectionnée.` : `${city.name} sélectionnée. Placez maintenant la zone sur un lieu public.` : '';
    if (isCity && city) void loadBoundary(city);
  }

  function selectPoint(next: GeoPoint) { if (!pendingBody && !isCity) { point = next; confirmed = false; } }

  function formatLength(meters: number): string {
    return meters >= 1_000 ? `${numberFormat.format(meters / 1_000)} km` : `${numberFormat.format(meters)} m`;
  }

  function chooseStartMode(mode: 'now' | 'custom') {
    startMode = mode;
    now = Date.now();
    confirmed = false;
    if (mode === 'custom' && !startDate && !startTime) {
      const current = parisDateTimeParts(Math.floor(now / 60_000) * 60_000);
      startDate = current.date;
      startTime = current.time;
    }
  }

  function moveTo(next: 1 | 2 | 3) {
    if (pendingBody || submitting || createdEvent) return;
    now = Date.now();
    if (next === 3 && (!validDetails || !validZone)) {
      message = scheduleError || 'Vérifiez le nom et le périmètre du comptage.';
      return;
    }
    step = next; confirmed = false; message = '';
    // The heading persists across steps, so keyboard and screen-reader focus stays predictable.
    heading?.focus();
  }

  function abandonDraft() {
    if (!pendingDraft || submitting || !confirmAbandon) return;
    const cleared = clearEventCreationDraft();
    pendingDraft = null;
    recoveredRequest = false;
    confirmAbandon = false;
    createdEvent = null;
    city = null; point = null; name = ''; cityQuery = ''; places = []; placeMessage = '';
    boundaryController?.abort(); boundaryController = undefined;
    countingScope = 'city'; cityBoundary = null; boundaryLoading = false; boundaryMessage = '';
    radius = DEFAULT_EVENT_RADIUS_METERS; duration = DEFAULT_EVENT_DURATION_MINUTES;
    startMode = 'now'; startDate = ''; startTime = '';
    confirmed = false; step = 1; message = '';
    draftNotice = 'La reprise a été abandonnée dans cet onglet. Cela ne supprime aucun comptage déjà créé. Recherchez votre rassemblement avant d’en créer un nouveau.';
    if (!cleared) storageNotice = 'Le navigateur n’a pas confirmé l’effacement du stockage. L’ancienne demande peut réapparaître au rechargement ; vérifiez les rassemblements existants avant de recommencer.';
    heading?.focus();
  }

  async function create() {
    now = Date.now();
    if (!canSubmit) {
      if (!pendingBody && scheduleError) message = scheduleError;
      return;
    }
    if (!pendingBody) {
      if (!city || !validZone || !validDetails || !confirmed) return;
      const schedule = startMode === 'custom' && parsedStart?.status === 'valid' ? { startsAt: parsedStart.startsAt } : {};
      const saved = saveEventCreationDraft({ requestId: crypto.randomUUID(), name: name.trim(), cityCode: city.code,
        cityName: city.name, ...(isCity ? { countingScope: 'city' } : { publicCenter: point, radiusMeters: Number(radius) }), durationMinutes: Number(duration),
        ...schedule, publicLocationConfirmed: true }, now);
      if (saved.status === 'invalid') {
        message = 'Vérifiez le nom, la ville et les informations publiques avant de créer le comptage.';
        return;
      }
      pendingDraft = saved.draft;
      if (saved.status === 'unavailable') storageNotice = 'La demande reste seulement dans cette page : le stockage de cet onglet est indisponible. Ne rechargez pas et ne fermez pas cette page avant la confirmation pour éviter un doublon.';
      else draftNotice = 'La demande confirmée et ses informations publiques sont conservées dans cet onglet pendant 24 heures au maximum, pour reprendre avec le même identifiant après un rechargement.';
    }
    submitting = true; message = '';
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20_000);
    try {
      const declaration = JSON.parse(pendingBody!);
      const admission = await getAdmissionProof('create', undefined, declaration, controller.signal);
      const response = await fetch('/api/events/create', { method: 'POST', headers: { 'content-type': 'application/json' },
        cache: 'no-store', body: JSON.stringify({ ...declaration, admission }), signal: controller.signal });
      const result = await response.json() as { status: string; event?: PublicEvent };
      if (response.ok && result.event?.slug && result.event.id === pendingDraft?.payload.requestId && ['created', 'already_created'].includes(result.status)) {
        createdEvent = result.event;
        clearEventCreationDraft();
        pendingDraft = null;
        recoveredRequest = false;
        draftNotice = '';
        message = Date.parse(result.event.startsAt) > Date.now()
          ? `Comptage créé. Il ouvrira le ${formatEventDateTime(result.event.startsAt)}, heure de Paris.`
          : result.event.countingScope === 'city' ? 'Comptage créé. Vous pouvez déclarer votre participation dans cette commune pendant sa période d’ouverture.' : 'Comptage créé. Vous pouvez vous compter sur place pendant sa période d’ouverture.';
        try { await goto(`/evenements/${result.event.slug}`); }
        catch { message = 'Le comptage est créé. Ouvrez-le avec le lien ci-dessous pour retrouver sa page.'; }
        return;
      }
      if (response.status === 400) {
        clearEventCreationDraft();
        pendingDraft = null;
        recoveredRequest = false;
        confirmAbandon = false;
        draftNotice = '';
        confirmed = false;
        message = result.status === 'invalid_location' ? 'Le lieu choisi est hors de la commune sélectionnée. Vérifiez la commune et le point public sur la carte.' : result.status === 'invalid_schedule'
          ? 'Ces horaires ne permettent pas d’ouvrir le comptage. Modifiez la date, l’heure de début ou la durée, puis vérifiez de nouveau.'
          : 'Vérifiez le nom, la ville, le périmètre et les horaires du comptage.';
      } else if (response.status === 503 && result.status === 'temporarily_unavailable') {
        message = isCity ? 'Le contour de la commune est momentanément indisponible. Réessayez ici : la même demande est conservée.' : 'Le service est momentanément indisponible. Réessayez ici : la même demande est conservée.';
      } else if (response.status === 429) {
        message = 'Trop de créations ont été demandées. Attendez avant de réessayer ; vérifiez aussi les rassemblements existants.';
      } else if (response.status === 409) {
        message = result.status === 'admission_required' ? 'La protection de la demande a expiré. Réessayez ici : la même demande est conservée.' : result.status === 'event_mode_changed'
          ? 'Le mode de collecte a changé depuis cette demande. Elle reste distincte des comptages actuels. Vérifiez le catalogue avant de recommencer.'
          : 'Cette demande correspond déjà à un autre comptage. Retrouvez-le dans la recherche avant de recommencer.';
      } else {
        message = 'La confirmation n’est pas arrivée. Réessayez ici : la même demande sera conservée pour éviter de créer un doublon.';
      }
    } catch (failure) {
      message = failure instanceof AdmissionClientError && failure.code === 'admission_timeout'
        ? 'Votre appareil est occupé. Réessayez pour terminer la vérification locale ; la même demande est conservée.'
        : 'La confirmation n’est pas arrivée. Réessayez ici : la même demande sera conservée pour éviter de créer un doublon.';
    } finally { clearTimeout(timeout); submitting = false; }
  }
</script>

<svelte:head><title>Créer un comptage — JeMeCompte</title><meta name="robots" content="noindex" /></svelte:head>

<section class="creation-page" aria-labelledby="creation-title">
  <a class="back-link" href="/#rassemblements">← Rechercher un rassemblement</a>
  <p class="eyebrow">OUVRIR UN COMPTAGE</p>
  <h1 id="creation-title">Une ville. Un lieu.<br />Un comptage collectif<span class="title-dot">.</span></h1>
  <p class="creation-lead">Choisissez toute une commune ou un lieu de rassemblement. Vérifiez les comptages existants avant d’en créer un autre. Créer une zone ne compte encore personne.</p>

  {#if !data.serviceAvailable}<p class="notice" role="status">Le service est momentanément indisponible. Revenez lorsque la connexion au service est rétablie.</p>{/if}
  {#if !online}<p class="notice" role="status">Vous êtes hors ligne. La carte et la création nécessitent une connexion.</p>{/if}
  <noscript><p class="notice">JavaScript est nécessaire pour choisir la zone sur la carte.</p></noscript>
  {#if draftNotice}<p class="notice" role="status">{draftNotice} <a href="/#rassemblements">Rechercher les rassemblements</a>.</p>{/if}
  {#if storageNotice}<p class="notice" role="status">{storageNotice}</p>{/if}

  <ol class="steps" aria-label="Étapes de création">
    <li aria-current={step === 1 ? 'step' : undefined}><span>01</span> Le périmètre</li>
    <li aria-current={step === 2 ? 'step' : undefined}><span>02</span> Le comptage</li>
    <li aria-current={step === 3 ? 'step' : undefined}><span>03</span> Vérifier</li>
  </ol>

  <div class="wizard">
    <div class="wizard-heading"><p class="eyebrow">ÉTAPE {step} SUR 3</p><h2 bind:this={heading} tabindex="-1">{recoveredRequest ? 'Reprendre la même demande' : step === 1 ? isCity ? 'Choisissez une ville' : 'Choisissez un lieu public' : step === 2 ? 'Délimitez le comptage' : 'Vérifiez avant de publier'}</h2></div>

    {#if step === 1}
      <fieldset class="scope-settings">
        <legend>Périmètre du comptage</legend>
        <div class="start-options">
          <label class="start-option" class:selected={isCity}><input type="radio" name="counting-scope" value="city" checked={isCity} disabled={!ready || Boolean(pendingBody)} onchange={() => chooseScope('city')} /><span>Commune entière</span></label>
          <label class="start-option" class:selected={!isCity}><input type="radio" name="counting-scope" value="gathering" checked={!isCity} disabled={!ready || Boolean(pendingBody)} onchange={() => chooseScope('gathering')} /><span>Rassemblement localisé</span></label>
        </div>
      </fieldset>
      <p class="guidance">{isCity ? 'Cherchez votre ville : son contour administratif sera chargé automatiquement, sans rayon à régler.' : 'Cherchez votre ville, puis touchez la place ou le lieu du rassemblement sur la carte.'} Votre GPS n’est pas utilisé pour créer cette zone.</p>
      <form class="city-search" onsubmit={searchCities}>
        <label for="city-search">{isCity ? 'Ville du comptage' : 'Ville du rassemblement'}</label>
        <div class="search-row"><input id="city-search" bind:value={cityQuery} minlength="2" maxlength="80" required autocomplete="off" placeholder="Ex. Paris, Lyon, Saint-Denis…" /><button class="secondary-button" disabled={!ready || !online || searching || Boolean(pendingBody)} type="submit">{searching ? 'Recherche…' : 'Chercher'}</button></div>
      </form>
      <p class="field-message" role="status">{placeMessage}</p>
      {#if places.length}<ul class="city-results" aria-label="Villes trouvées">{#each places as place (place.code)}<li><button type="button" onclick={() => chooseCity(place)}><strong>{place.name}</strong><small>Code commune {place.code}</small><span aria-hidden="true">↗</span></button></li>{/each}</ul>{/if}
    {:else if step === 2}
      <p class="guidance">{isCity ? `Le comptage couvrira toute la commune de ${city?.name}. Aucun rayon ni point sur la carte n’est nécessaire.` : 'Gardez une zone assez petite pour correspondre au rassemblement. Pour un cortège en mouvement, une zone fixe ne couvre pas tout le parcours.'}</p>
      <div class="field"><label for="event-name">{isCity ? 'Nom public du comptage' : 'Nom public du rassemblement'}</label><input id="event-name" bind:value={name} minlength="3" maxlength="120" required placeholder={isCity ? `Ex. Comptage de ville — ${city?.name}` : 'Ex. Rassemblement pour les services publics'} aria-describedby="name-help" /><small id="name-help">Un intitulé court, sans nom personnel ni coordonnées de contact.</small></div>
      <div class="settings-grid">
        {#if !isCity}
        <div class="field radius-field">
          <label for="zone-radius">Rayon autour du lieu</label>
          <div class="radius-input"><input id="zone-radius" type="number" inputmode="numeric" min={MIN_EVENT_RADIUS_METERS} max={MAX_EVENT_RADIUS_METERS} step="1" bind:value={radius} required aria-invalid={!validRadius} aria-describedby="radius-help radius-size" /><span aria-hidden="true">mètres</span></div>
          <small id="radius-help">De 100 m à 10 km. Saisissez la distance en mètres, par exemple 1500 pour 1,5 km.</small>
          <div class="radius-presets" role="group" aria-label="Rayons suggérés">{#each radiusPresets as meters (meters)}<button type="button" aria-pressed={radius === meters} onclick={() => { radius = meters; }}>{formatLength(meters)}</button>{/each}</div>
          <small id="radius-size" class:radius-error={!validRadius}>{validRadius ? `Un rayon de ${formatLength(previewRadius)} couvre ${formatLength(previewRadius * 2)} de large.` : 'Indiquez un rayon entier entre 100 et 10 000 mètres pour continuer.'}</small>
        </div>
        {/if}
        <div class="field"><label for="event-duration">Durée du comptage</label><select id="event-duration" bind:value={duration} aria-describedby="duration-help" aria-invalid={!validDuration}>{#each EVENT_DURATIONS as minutes (minutes)}<option value={minutes}>{minutes / 60} heure{minutes > 60 ? 's' : ''}</option>{/each}</select><small id="duration-help">Heures écoulées depuis le début choisi. Le comptage reste unique sur toute la durée de l’événement, même sur plusieurs jours.</small></div>
      </div>

      <fieldset class="start-settings" aria-describedby="schedule-timezone">
        <legend>Début du comptage</legend>
        <div class="start-options">
          <label class="start-option" class:selected={startMode === 'now'}><input type="radio" name="event-start-mode" value="now" checked={startMode === 'now'} onchange={() => chooseStartMode('now')} /><span>Maintenant</span></label>
          <label class="start-option" class:selected={startMode === 'custom'}><input type="radio" name="event-start-mode" value="custom" checked={startMode === 'custom'} onchange={() => chooseStartMode('custom')} /><span>Choisir la date et l’heure</span></label>
        </div>
        <p id="schedule-timezone" class="schedule-help">Heure de Paris (Europe/Paris), même si votre appareil utilise un autre fuseau.</p>
        {#if startMode === 'custom'}
          <div class="schedule-inputs">
            <div class="field"><label for="event-start-date">Date de début</label><input id="event-start-date" type="date" bind:value={startDate} required aria-invalid={!validSchedule} aria-describedby={scheduleError ? 'schedule-timezone schedule-error' : 'schedule-timezone'} /></div>
            <div class="field"><label for="event-start-time">Heure de début</label><input id="event-start-time" type="time" step="60" bind:value={startTime} required aria-invalid={!validSchedule} aria-describedby={scheduleError ? 'schedule-timezone schedule-error' : 'schedule-timezone'} /></div>
          </div>
          <p class="schedule-help">Un début passé est possible si l’heure de fin est encore à venir.</p>
        {/if}
      </fieldset>
    {:else}
      {#if pendingDraft}<p class="schedule-help">Demande de publication confirmée par vous le {formatEventDateTime(pendingDraft.savedAt)}, heure de Paris. La reprise conserve les informations publiques ci-dessous.</p>{/if}
      <dl class="review"><div><dt>{isCity ? 'Comptage' : 'Rassemblement'}</dt><dd>{name.trim()}</dd></div><div><dt>Ville déclarée</dt><dd>{city?.name}</dd></div><div><dt>Périmètre public</dt><dd>{isCity ? `Commune entière de ${city?.name} · contour administratif` : `Cercle de ${radius} mètres de rayon`}</dd></div><div><dt>Début</dt><dd>{startMode === 'now' && pendingBody ? 'En attente de confirmation' : startMode === 'now' ? `Maintenant — environ ${formatEventDateTime(now)}` : startInstant !== null ? formatEventDateTime(startInstant) : 'À préciser'}</dd></div><div><dt>Fin</dt><dd>{startMode === 'now' && pendingBody ? 'En attente de confirmation' : endInstant !== null ? `${startMode === 'now' ? 'Environ ' : ''}${formatEventDateTime(endInstant)}` : 'À préciser'}</dd></div><div><dt>Durée</dt><dd>{Number(duration) / 60} heure{Number(duration) > 60 ? 's' : ''} écoulée{Number(duration) > 60 ? 's' : ''}</dd></div></dl>
      <p class="schedule-help">Heure de Paris (Europe/Paris). {pendingBody ? 'La confirmation est en attente. Réessayez ici pour retrouver les horaires confirmés de la même demande.' : startMode === 'now' ? 'Les horaires affichés sont approximatifs ; le serveur fixera et confirmera le début et la fin exacts à la création.' : startsInFuture ? 'Le comptage sera visible dès sa création et ouvrira à la date choisie. Vous pourrez vous compter à partir de cet horaire.' : 'Le comptage sera déjà en cours à sa création et restera ouvert jusqu’à l’heure de fin indiquée.'}</p>
      <p class="guidance">Le nom, la zone et les horaires seront publics. Votre identité de participant n’est pas publiée. La zone reste fixe après création.</p>
    {/if}

    {#if step >= 2 && !pendingBody && scheduleError}<p id="schedule-error" class="schedule-error" role="status">{scheduleError}</p>{/if}

    {#if !isCity && step >= 2 && validRadius && previewRadius >= 2_000}
      <p class="large-zone-note">Cette zone couvre environ <strong>{numberFormat.format(Math.PI * (previewRadius / 1_000) ** 2)} km²</strong>. Elle peut inclure des personnes éloignées du rassemblement. Ajustez le rayon à l’espace réellement concerné.</p>
    {/if}

    {#if city}
      {#if isCity}
        <p class="zone-status" role="status">{boundaryLoading ? 'Chargement du contour de la commune…' : boundaryMessage}</p>
        {#if !boundaryLoading && !cityBoundary}<button type="button" class="text-button" disabled={!online} onclick={() => city && void loadBoundary(city)}>Réessayer le chargement du contour</button>{/if}
        {#if cityBoundary}<CreationMap {view} center={null} radius={previewRadius} boundary={cityBoundary} readonly onselect={selectPoint} />{/if}
        <p class="notice city-scope-notice">Ce comptage couvre toute la commune. Il ne confirme aucun lieu de manifestation et ne prouve pas une participation à une manifestation.</p>
      {:else}
        <CreationMap {view} center={point} radius={previewRadius} readonly={step === 3 || Boolean(pendingBody)} onselect={selectPoint} />
        <p class="zone-status" role="status">{point ? validRadius ? `Zone sélectionnée à ${city.name} · rayon de ${formatLength(previewRadius)}` : 'Précisez un rayon valide pour confirmer le périmètre.' : 'Aucune zone choisie. Touchez le lieu du rassemblement sur la carte.'}</p>
      {/if}
    {/if}

    {#if nearby.length}
      <aside class="nearby" aria-labelledby="nearby-title"><h3 id="nearby-title">{isCity ? 'Des comptages existent dans cette commune' : 'Des comptages existent à proximité'}</h3><p>Vérifiez leur nom et leurs horaires pour éviter de diviser le même comptage.</p>{#each nearby as event (event.id)}<a href={`/evenements/${event.slug}`}><strong>{event.name}</strong><span>{event.cityName} ↗</span></a>{/each}</aside>
    {/if}

    {#if step === 3}
      <label class="confirmation"><input type="checkbox" bind:checked={confirmed} disabled={Boolean(pendingBody)} /><span>{isCity ? `Je confirme un comptage dans toute la commune de ${city?.name} et j’accepte de publier ce périmètre et ces informations.` : 'Je confirme que cette zone correspond au rassemblement et j’accepte de publier ce lieu et ces informations.'}</span></label>
      <p class="publication-note">Ce comptage sera indiqué « Ouvert par un participant ». Un contrôle GPS effectué dans le navigateur ne certifie pas la présence humaine.</p>
    {/if}
    <p class="submission-message" role="status" aria-live="polite">{message}</p>
    {#if pendingDraft && !createdEvent}
      {#if confirmAbandon}
        <div class="notice abandon-confirmation">
          <p>Le serveur a peut-être déjà créé ce comptage. Abandonner retire seulement la reprise de cet onglet ; cela ne supprime aucun événement. Recherchez-le avant d’en créer un nouveau.</p>
          <div class="abandon-actions"><button type="button" class="secondary-button" onclick={() => { confirmAbandon = false; }}>Conserver ma demande</button><button type="button" class="text-button" disabled={submitting} onclick={abandonDraft}>Confirmer l’abandon</button></div>
        </div>
      {:else}<button type="button" class="text-button" disabled={submitting} onclick={() => { confirmAbandon = true; }}>Abandonner cette demande</button>{/if}
    {/if}
    <div class="wizard-actions">
      {#if step > 1}<button type="button" class="text-button" disabled={submitting || Boolean(pendingBody) || Boolean(createdEvent)} onclick={() => moveTo(step === 3 ? 2 : 1)}>← Modifier {step === 3 ? 'le comptage' : 'le lieu'}</button>{/if}
      {#if createdEvent}<a class="primary-action" href={`/evenements/${createdEvent.slug}`}>Ouvrir le comptage créé <span aria-hidden="true">↗</span></a>
      {:else if step === 1}<button type="button" class="primary-action" disabled={!validZone || !ready || !online || !data.serviceAvailable} onclick={() => moveTo(2)}>Continuer <span aria-hidden="true">→</span></button>
      {:else if step === 2}<button type="button" class="primary-action" disabled={!validDetails || !validZone} onclick={() => moveTo(3)}>Vérifier le comptage <span aria-hidden="true">→</span></button>
      {:else}<button type="button" class="primary-action" disabled={!canSubmit} onclick={() => void create()} aria-busy={submitting}>{submitting ? 'Création en cours…' : recoveredRequest ? 'Reprendre la même demande' : pendingBody ? 'Réessayer la création' : 'Créer le comptage'} <span aria-hidden="true">↗</span></button>{/if}
    </div>
    <p class="help-end"><a href="/confidentialite">Comment ces informations sont utilisées</a></p>
  </div>
</section>

<style>
  .creation-page { max-width: 860px; margin: auto; padding-bottom: 64px; }
  .creation-page > .back-link { margin-bottom: 28px; margin-top: 20px; }
  .creation-page > .eyebrow { color: var(--green); }
  h1 { font-size: clamp(38px, 5vw, 64px); line-height: 1.06; letter-spacing: -2.5px; margin-top: 16px; }
  .creation-lead { margin-top: 24px; max-width: 650px; font-size: 17px; color: var(--muted); }
  .steps { list-style: none; display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 32px 0; padding: 0; }
  .steps li { border-top: 2px solid var(--line); padding-top: 12px; color: var(--muted); font-size: 13px; }
  .steps li[aria-current] { border-color: var(--green); color: var(--ink); font-weight: 700; }
  .steps span { display: inline-block; margin-right: 10px; color: var(--green); font-variant-numeric: tabular-nums; }
  .wizard { padding: 30px; border: 1px solid var(--line); }
  .wizard-heading > p { color: var(--green); }
  h2 { font-size: 27px; line-height: 1.25; letter-spacing: -0.7px; margin-top: 8px; }
  h2:focus { outline: none; }
  .guidance { margin-top: 16px; font-size: 14px; color: var(--muted); }
  .city-search, .field { margin-top: 23px; }
  label, .field label { display: block; font-size: 13px; font-weight: 700; margin-bottom: 9px; }
  input:not([type=checkbox]):not([type=radio]), select { width: 100%; min-width: 0; min-height: 50px; border: 1px solid var(--line); background: var(--paper); color: var(--ink); padding: 12px; font: inherit; font-size: 16px; border-radius: 0; }
  .search-row { display: flex; gap: 10px; }
  .search-row input { flex: 1; }
  .field-message { font-size: 12px; color: var(--muted); margin-top: 10px; }
  .city-results { padding: 0; list-style: none; margin: 12px 0 0; }
  .city-results button { display: grid; grid-template-columns: 1fr auto; gap: 4px 16px; padding: 14px; min-height: 60px; width: 100%; text-align: left; background: transparent; color: var(--ink); border: 1px solid var(--line); border-bottom: 0; }
  .city-results li:last-child button { border-bottom: 1px solid var(--line); }
  .city-results button:hover { background: var(--soft-green); }
  .city-results small { grid-column: 1; font-size: 11px; color: var(--muted); }
  .city-results button > span { grid-column: 2; grid-row: 1 / 3; align-self: center; font-size: 24px; }
  .settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  .field > small { display: block; margin-top: 8px; font-size: 12px; color: var(--muted); line-height: 1.6; }
  .radius-input { position: relative; }
  .radius-input input { padding-right: 94px; }
  .radius-input > span { position: absolute; right: 30px; top: 15px; font-size: 13px; color: var(--muted); pointer-events: none; }
  .radius-presets { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 12px; }
  .radius-presets button { min-height: 44px; padding: 9px 12px; border: 1px solid var(--line); background: transparent; color: var(--ink); font-size: 12px; font-weight: 600; }
  .radius-presets button[aria-pressed=true] { border-color: var(--green); background: var(--soft-green); }
  .field > small.radius-error { color: var(--error); }
  .start-settings, .scope-settings { border: 0; min-width: 0; margin: 27px 0 0; padding: 0; }
  .start-settings legend, .scope-settings legend { padding: 0; font-size: 13px; font-weight: 700; }
  .start-options { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 12px; }
  .start-option { display: flex; align-items: center; gap: 10px; min-height: 52px; padding: 12px; margin: 0; border: 1px solid var(--line); cursor: pointer; line-height: 1.5; }
  .start-option.selected { border-color: var(--green); background: var(--soft-green); }
  .start-option input { width: 22px; height: 22px; margin: 0; flex: 0 0 auto; accent-color: var(--green); }
  .schedule-inputs { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 20px; }
  .schedule-help { margin-top: 12px; color: var(--muted); font-size: 12px; line-height: 1.7; }
  .schedule-error { margin-top: 15px; color: var(--error); font-size: 13px; line-height: 1.7; }
  .large-zone-note { margin-top: 20px; font-size: 13px; color: var(--muted); padding: 14px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
  .zone-status { margin-top: 12px; color: var(--green); font-size: 12px; }
  .nearby { border-left: 3px solid var(--green); background: var(--soft-green); padding: 18px; margin-top: 24px; }
  .nearby h3 { margin: 0; font-size: 15px; }
  .nearby > p { margin: 8px 0 12px; font-size: 12px; color: var(--muted); }
  .nearby a { display: block; border-top: 1px solid var(--line); padding: 12px 0; text-decoration: none; font-size: 13px; }
  .nearby a:hover strong { text-decoration: underline; }
  .nearby a > span { display: block; margin-top: 4px; font-size: 11px; color: var(--muted); }
  .review { margin: 20px 0 0; }
  .review > div { display: grid; grid-template-columns: 150px 1fr; border-bottom: 1px solid var(--line); padding: 13px 0; gap: 12px; font-size: 14px; }
  dt { color: var(--muted); } dd { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
  .confirmation { display: flex; align-items: flex-start; gap: 12px; line-height: 1.7; font-size: 13px; margin-top: 24px; }
  .confirmation input { flex: 0 0 auto; height: 24px; width: 24px; accent-color: var(--green); }
  .publication-note { margin-top: 10px; color: var(--muted); font-size: 12px; }
  .abandon-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 20px; margin-top: 12px; }
  .submission-message { margin-top: 20px; font-size: 14px; color: var(--green); }
  .submission-message:empty { display: none; }
  .wizard-actions { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin-top: 26px; }
  .primary-action { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin-left: auto; min-height: 58px; background: var(--green); border: 1px solid var(--green); padding: 16px 21px; font-size: 14px; font-weight: 700; color: var(--button-ink); }
  .primary-action:disabled { background: var(--soft-green); color: var(--muted); border-color: var(--line); }
  .help-end { font-size: 11px; color: var(--muted); margin-top: 20px; }
  @media(max-width: 700px) {
    .creation-page { padding-bottom: 40px; }
    h1 { letter-spacing: -1.8px; font-size: 39px; }
    h2 { font-size: 23px; }
    .creation-lead { font-size: 15px; }
    .wizard { padding: 18px 14px; }
    .steps { gap: 8px; }
    .steps li { font-size: 11px; }
    .steps span { margin-right: 4px; }
    .search-row { flex-wrap: wrap; }
    .search-row input { flex-basis: 100%; }
    .search-row button { width: 100%; }
    .settings-grid { grid-template-columns: 1fr; gap: 0; }
    .start-options, .schedule-inputs { grid-template-columns: 1fr; gap: 12px; }
    .wizard-actions { flex-direction: column; align-items: stretch; gap: 10px; }
    .primary-action { width: 100%; margin-left: 0; }
    .review > div { grid-template-columns: 1fr; gap: 5px; }
  }
</style>
