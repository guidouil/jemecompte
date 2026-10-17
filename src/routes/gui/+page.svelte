<script lang="ts">
  import { enhance, type SubmitFunction } from '$app/forms';
  import { onMount, untrack } from 'svelte';
  import type { PageData } from './$types';

  interface AdminFormData {
    message?: string;
    error?: string;
    deletedId?: string;
    failedEventId?: string;
    confirmation?: string;
  }

  let { data, form }: { data: PageData; form?: AdminFormData | null } = $props();
  let expandedId = $state<string | null>(untrack(() => form?.failedEventId ?? null));
  let submittedId = $state<string | null>(untrack(() => form?.failedEventId ?? null));
  let busy = $state<'login' | 'logout' | 'delete' | null>(null);
  let busyEventId = $state<string | null>(null);
  let localError = $state('');
  let enhanced = $state(false);
  onMount(() => { enhanced = true; });
  const errorMessage = $derived(localError || form?.error || '');
  const events = $derived(data.events ?? []);
  const dateFormat = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
  const numberFormat = new Intl.NumberFormat('fr-FR');
  const statuses: Record<string, string> = {
    draft: 'Brouillon', published: 'Publié', paused: 'En pause', closed: 'Clôturé', cancelled: 'Annulé'
  };

  function formatDate(value: string): string {
    const instant = Date.parse(value);
    return Number.isFinite(instant) ? dateFormat.format(new Date(instant)) : 'Horaire non précisé';
  }

  function formatCount(value: string): string {
    try { return numberFormat.format(BigInt(value)); } catch { return '—'; }
  }

  function listUrl(page: number): string {
    const params = new URLSearchParams({ page: String(page) });
    if (data.query) params.set('q', data.query);
    return `/gui?${params.toString()}`;
  }

  const deleteAction = $derived(`${listUrl(data.page)}&/delete`);

  function trackedForm(kind: 'login' | 'logout' | 'delete'): SubmitFunction {
    return ({ formData, formElement, cancel }) => {
      if (busy) { cancel(); return; }
      const eventId = formData.get('eventId');
      busy = kind;
      busyEventId = kind === 'delete' && typeof eventId === 'string' ? eventId : null;
      submittedId = busyEventId;
      localError = '';
      return async ({ result, update }) => {
        try {
          if (result.type === 'error') {
            const status = result.status ?? (result.error && typeof result.error === 'object' && 'status' in result.error
              ? result.error.status : undefined);
            localError = status === 403
              ? 'La requête a été refusée. Rechargez cette page avant de réessayer.'
              : status === 401
                ? 'Votre session a expiré. Rechargez cette page pour vous reconnecter.'
                : status === 429
                  ? 'Trop de demandes. Patientez avant de réessayer.'
                  : kind === 'delete'
                    ? 'La réponse de suppression n’est pas arrivée. Actualisez la liste pour vérifier le résultat avant de recommencer.'
                    : 'La réponse n’est pas arrivée. Vérifiez votre connexion puis réessayez.';
            return;
          }
          await update({ reset: result.type === 'success', navigate: false });
          if (result.type === 'success' || result.type === 'redirect') {
            expandedId = null;
            submittedId = null;
          }
        } finally {
          const password = formElement.querySelector<HTMLInputElement>('input[type="password"]');
          if (kind === 'delete' && password) password.value = '';
          busy = null;
          busyEventId = null;
        }
      };
    };
  }
</script>

<svelte:head>
  <title>Gestion privée des comptages — JeMeCompte</title>
  <meta name="robots" content="noindex,nofollow,noarchive" />
  <meta name="description" content="Espace privé de gestion des comptages JeMeCompte." />
</svelte:head>

<section class="admin-page" aria-labelledby="admin-title" data-enhanced={enhanced}>
  <div class="admin-heading">
    <div><p class="eyebrow">ESPACE PRIVÉ</p><h1 id="admin-title">Gérer les comptages<span class="title-dot">.</span></h1></div>
    {#if data.authenticated}
      <form method="POST" action="/gui?/logout" use:enhance={trackedForm('logout')}>
        <button type="submit" class="secondary-button" disabled={Boolean(busy)} aria-busy={busy === 'logout'}>{busy === 'logout' ? 'Déconnexion…' : 'Se déconnecter'}</button>
      </form>
    {/if}
  </div>

  <p class="admin-intro">Consultez les comptages et leurs totaux. Les identifiants individuels des participants ne sont pas affichés.</p>
  <p id="admin-action-error" class="admin-error notice" role="alert" hidden={!errorMessage}>{errorMessage}</p>
  <p class="admin-success notice" role="status" aria-live="polite" aria-atomic="true" hidden={!form?.message}>{form?.message ?? ''}</p>

  {#if !data.configured}
    <div class="notice" role="status"><p>L’accès privé n’est pas encore configuré sur ce serveur. Configurez le mot de passe et la session d’administration côté serveur pour ouvrir cet espace.</p></div>
  {:else if !data.authenticated}
    <form class="login-form" method="POST" action="/gui?/login" use:enhance={trackedForm('login')} aria-labelledby="login-title">
      <h2 id="login-title">Connexion</h2>
      <label for="admin-password">Mot de passe d’administration</label>
      <input id="admin-password" name="adminPassword" type="password" autocomplete="current-password" required maxlength="256" disabled={Boolean(busy)} aria-describedby="login-help" aria-invalid={Boolean(errorMessage)} />
      <p id="login-help" class="field-help">Utilisez le mot de passe privé du service.</p>
      <button type="submit" class="primary-button" disabled={Boolean(busy)} aria-busy={busy === 'login'}>{busy === 'login' ? 'Connexion…' : 'Se connecter'}</button>
    </form>
  {:else}
    <form class="admin-search" method="GET" action="/gui" role="search" aria-label="Rechercher un comptage à gérer">
      <div class="search-field"><label for="admin-query">Rechercher par nom, ville ou lien public</label><input id="admin-query" name="q" type="search" value={data.query} maxlength="160" disabled={Boolean(busy)} /></div>
      <input type="hidden" name="page" value="1" />
      <button type="submit" class="secondary-button" disabled={Boolean(busy)}>Rechercher</button>
      {#if data.query}<a href="/gui" class="text-button" aria-disabled={Boolean(busy)} onclick={(event) => { if (busy) event.preventDefault(); }}>Effacer la recherche</a>{/if}
    </form>

    {#if data.loadError}
      <div class="notice" role="alert"><p>{data.loadError}</p><a class="text-button" href={listUrl(data.page)} data-sveltekit-reload>Actualiser la liste</a></div>
    {:else}
      <div class="list-heading"><h2>Comptages</h2><p>Page {data.page} · {events.length} comptage{events.length > 1 ? 's' : ''} affiché{events.length > 1 ? 's' : ''}</p></div>
      {#if !events.length}
        <div class="empty-state"><h3>Aucun comptage à afficher.</h3><p>{data.query ? 'Essayez un autre nom, une autre ville ou le lien public du comptage.' : 'Les comptages créés apparaîtront ici.'}</p></div>
      {:else}
        <ul class="admin-events">
          {#each events as event (event.id)}
            <li>
              <article class="admin-event" aria-labelledby={`${event.id}-name`}>
                <div class="event-heading"><div><p class="event-city">{event.cityName}</p><h3 id={`${event.id}-name`}>{event.name}</h3></div><div class="admin-badges"><span>{event.isTest ? 'Test' : 'Réel'}</span><span>{event.countingScope === 'city' ? 'Commune entière' : 'Rassemblement localisé'}</span><span>{statuses[event.status] ?? event.status}</span></div></div>
                <p class="event-schedule">Du {formatDate(event.startsAt)}<br />au {formatDate(event.endsAt)} <span class="muted">(heure de Paris)</span></p>
                <p class="event-slug"><span>Lien public</span><code>{event.slug}</code></p>
                <dl class="admin-counts">
                  <div><dt>Total du comptage</dt><dd>{formatCount(event.totalCount)}</dd></div>
                  <div><dt>Présences</dt><dd>{formatCount(event.presenceCount)}</dd></div>
                  <div><dt>Soutiens à distance</dt><dd>{formatCount(event.supportCount)}</dd></div>
                  <div><dt>Présences encore conservées</dt><dd>{formatCount(event.retainedPresences)}</dd></div>
                  <div><dt>Soutiens encore conservés</dt><dd>{formatCount(event.retainedSupports)}</dd></div>
                </dl>

                <details class="delete-panel" open={expandedId === event.id} ontoggle={(toggle) => {
                  if (toggle.currentTarget.open) expandedId = event.id;
                  else if (expandedId === event.id) expandedId = null;
                }}>
                  <summary aria-disabled={Boolean(busy)} onclick={(click) => { if (busy) click.preventDefault(); }}>Supprimer…</summary>
                  <form method="POST" action={deleteAction} use:enhance={trackedForm('delete')} aria-labelledby={`${event.id}-delete-title`}>
                    <h4 id={`${event.id}-delete-title`}>Supprimer définitivement ce comptage</h4>
                    <p id={`${event.id}-delete-warning`} class="delete-warning">Cette action est définitive. Elle supprime le comptage « {event.name} », toutes ses participations et ses compteurs. Son lien public ne sera plus disponible.</p>
                    <input type="hidden" name="eventId" value={event.id} />
                    <label for={`${event.id}-confirmation`}>Recopiez exactement le lien public pour confirmer</label>
                    <p id={`${event.id}-confirmation-help`} class="confirmation-value"><code>{event.slug}</code></p>
                    <input id={`${event.id}-confirmation`} name="confirmation" type="text" value={form?.failedEventId === event.id ? form.confirmation ?? '' : ''} autocomplete="off" spellcheck="false" autocapitalize="off" required maxlength="100" disabled={Boolean(busy)} aria-invalid={Boolean(errorMessage && submittedId === event.id)} aria-describedby={`${event.id}-delete-warning ${event.id}-confirmation-help${errorMessage && submittedId === event.id ? ' admin-action-error' : ''}`} />
                    <label for={`${event.id}-password`}>Mot de passe pour confirmer la suppression</label>
                    <input id={`${event.id}-password`} name="adminPassword" type="password" autocomplete="current-password" required maxlength="256" disabled={Boolean(busy)} />
                    <div class="delete-actions"><button type="submit" class="delete-button" disabled={Boolean(busy)} aria-busy={busy === 'delete' && busyEventId === event.id}>{busy === 'delete' && busyEventId === event.id ? 'Suppression…' : 'Supprimer définitivement'}</button><a href={listUrl(data.page)} class="text-button" aria-disabled={Boolean(busy)} onclick={(click) => { if (busy) click.preventDefault(); else expandedId = null; }}>Annuler</a></div>
                  </form>
                </details>
              </article>
            </li>
          {/each}
        </ul>
      {/if}

      {#if data.page > 1 || data.hasNext}
        <nav class="admin-pagination" aria-label="Pages des comptages">
          {#if data.page > 1}<a href={listUrl(data.page - 1)} class="secondary-button" aria-disabled={Boolean(busy)} onclick={(click) => { if (busy) click.preventDefault(); }}>← Page précédente</a>{/if}
          <span>Page {data.page}</span>
          {#if data.hasNext}<a href={listUrl(data.page + 1)} class="secondary-button" aria-disabled={Boolean(busy)} onclick={(click) => { if (busy) click.preventDefault(); }}>Page suivante →</a>{/if}
        </nav>
      {/if}
    {/if}
  {/if}
</section>

<style>
  .admin-page { max-width: 1020px; margin: 0 auto; padding: 38px 0 70px; }
  .admin-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; }
  .admin-heading .eyebrow { color: var(--green); }
  h1 { font-size: clamp(36px, 4.8vw, 60px); line-height: 1.08; letter-spacing: -2.6px; margin-top: 12px; }
  .admin-heading form { flex-shrink: 0; }
  .admin-intro { max-width: 690px; margin-top: 22px; color: var(--muted); font-size: 15px; }
  .admin-error { color: var(--error); }
  .admin-success { border-left: 3px solid var(--green); }
  .login-form { max-width: 440px; margin-top: 34px; padding: 26px; border: 1px solid var(--line); }
  h2 { font-size: 23px; line-height: 1.3; letter-spacing: -0.5px; }
  label { display: block; margin: 19px 0 8px; font-size: 13px; font-weight: 700; line-height: 1.6; }
  input:not([type=hidden]) { display: block; min-height: 50px; width: 100%; min-width: 0; padding: 12px; border: 1px solid var(--line); border-radius: 0; background: var(--paper); color: var(--ink); font-size: 16px; }
  input[aria-invalid=true] { border-color: var(--error); }
  .field-help { margin-top: 9px; color: var(--muted); font-size: 12px; }
  .primary-button { display: inline-flex; justify-content: center; align-items: center; min-height: 50px; margin-top: 23px; padding: 13px 20px; background: var(--green); color: var(--button-ink); border: 1px solid var(--green); font-weight: 700; font-size: 14px; }
  .primary-button:disabled, .delete-button:disabled { opacity: 0.6; }
  .admin-search { display: flex; align-items: flex-end; flex-wrap: wrap; gap: 12px 18px; margin-top: 35px; padding: 22px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
  .search-field { flex: 1 1 320px; }
  .search-field label { margin-top: 0; }
  .admin-search > .secondary-button { min-height: 50px; }
  .list-heading { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin: 30px 0 17px; }
  .list-heading p { color: var(--muted); font-size: 12px; }
  .admin-events { padding: 0; margin: 0; list-style: none; display: grid; gap: 17px; }
  .admin-event { padding: 25px; border: 1px solid var(--line); min-width: 0; }
  .event-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; }
  .event-heading > div { min-width: 0; }
  .event-city { color: var(--green); font-size: 12px; font-weight: 700; }
  h3 { font-size: 20px; line-height: 1.4; letter-spacing: -0.4px; margin: 7px 0 0; overflow-wrap: anywhere; }
  .admin-badges { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
  .admin-badges span { padding: 5px 8px; background: var(--soft-green); color: var(--ink); font-size: 11px; line-height: 1.4; }
  .event-schedule { margin-top: 14px; font-size: 12px; }
  .event-slug { margin-top: 14px; font-size: 12px; }
  .event-slug > span { color: var(--muted); margin-right: 12px; }
  code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap: anywhere; }
  .admin-counts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin: 21px 0; }
  .admin-counts dt { color: var(--muted); font-size: 12px; line-height: 1.6; }
  .admin-counts dd { margin: 5px 0 0; font-size: 27px; line-height: 1.2; font-weight: 700; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .delete-panel { border-top: 1px solid var(--line); padding-top: 6px; }
  summary { width: fit-content; min-height: 44px; padding: 12px 0; color: var(--error); font-size: 13px; font-weight: 700; }
  summary[aria-disabled=true] { opacity: 0.6; cursor: not-allowed; }
  .delete-panel form { margin-top: 8px; padding: 20px; background: var(--notice); }
  h4 { font-size: 16px; line-height: 1.5; margin: 0; }
  .delete-warning { margin-top: 10px; font-size: 13px; line-height: 1.8; }
  .confirmation-value { margin: 0 0 9px; font-size: 12px; line-height: 1.7; }
  .delete-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 22px; margin-top: 20px; }
  .delete-button { min-height: 50px; padding: 13px 18px; border: 1px solid var(--error); background: var(--error); color: var(--paper); font-size: 13px; font-weight: 700; line-height: 1.5; }
  .empty-state { border: 1px solid var(--line); padding: 25px; }
  .empty-state h3 { margin: 0; }
  .empty-state p { margin-top: 10px; color: var(--muted); font-size: 14px; }
  .admin-pagination { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 15px; margin-top: 28px; }
  .admin-pagination > span { font-size: 12px; color: var(--muted); }
  @media (max-width: 700px) {
    .admin-page { padding-top: 25px; padding-bottom: 48px; }
    .admin-heading, .event-heading { flex-direction: column; gap: 16px; }
    h1 { letter-spacing: -1.8px; }
    .admin-intro { font-size: 14px; }
    .login-form, .admin-event { padding: 18px; }
    .admin-search { gap: 12px; margin-top: 26px; }
    .search-field { flex-basis: 100%; }
    .admin-search > .secondary-button { flex: 1; }
    .admin-badges { justify-content: flex-start; }
    .admin-counts { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 13px; }
    .admin-counts dd { font-size: 24px; }
    .delete-panel form { padding: 14px; }
    .delete-button { width: 100%; }
  }
</style>
