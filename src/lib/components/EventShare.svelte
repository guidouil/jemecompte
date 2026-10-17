<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { PublicEvent } from '../shared/types';
  import { copyEventLink, nativeShareAvailable, shareEvent } from '../client/event-sharing';
  import type { EventQrCode } from '../client/event-qr';
  import { eventReportMailto } from '../client/event-report';

  let { event }: { event: PublicEvent } = $props();
  const isCity = $derived(event.countingScope === 'city');
  const id = $props.id();
  let ready = $state(false);
  let nativeAvailable = $state(false);
  let action = $state<'copy' | 'share' | null>(null);
  let feedback = $state<{ slug: string; message: string; manualUrl?: string } | null>(null);
  const currentFeedback = $derived(feedback?.slug === event.slug ? feedback : null);
  let qr = $state<{ slug: string; code?: EventQrCode; error?: string } | null>(null);
  let printing = $state(false);
  const currentQr = $derived(qr?.slug === event.slug ? qr : null);
  let browserOrigin = $state<string | null>(null);
  const reportHref = $derived.by(() => {
    if (!browserOrigin) return null;
    try { return eventReportMailto(event, browserOrigin); }
    catch { return null; }
  });

  onMount(() => { nativeAvailable = nativeShareAvailable(); browserOrigin = location.origin; ready = true; });

  function copy(): void {
    if (!ready || action) return;
    const target = { slug: event.slug };
    action = 'copy';
    feedback = { slug: target.slug, message: 'Copie du lien…' };
    // No await before the clipboard call: preserve the browser's user activation.
    void copyEventLink(target).then((result) => {
      feedback = {
        slug: target.slug,
        message: result.status === 'copied' ? 'Lien copié.' : result.url
          ? 'La copie automatique n’est pas disponible. Copiez le lien ci-dessous.'
          : 'Le lien n’est pas disponible. Réessayez.',
        manualUrl: result.status === 'manual' ? result.url : undefined
      };
    }).finally(() => { action = null; });
  }

  function share(): void {
    if (!ready || action) return;
    const target = { slug: event.slug, name: isCity ? `${event.name} — commune entière` : event.name };
    action = 'share';
    feedback = { slug: target.slug, message: 'Ouverture du partage…' };
    // shareEvent invokes navigator.share immediately in this same click handler.
    void shareEvent(target).then((result) => {
      const message = result.status === 'shared' ? 'Lien partagé.' :
        result.status === 'cancelled' ? 'Partage annulé.' : result.url
          ? 'Le partage n’a pas pu s’ouvrir. Vous pouvez copier le lien ci-dessous.'
          : 'Le lien n’est pas disponible. Réessayez.';
      feedback = {
        slug: target.slug, message,
        manualUrl: result.status === 'error' || result.status === 'unavailable' ? result.url : undefined
      };
    }).finally(() => { action = null; });
  }

  function toggleQr(): void {
    if (!ready) return;
    if (currentQr) { qr = null; return; }
    const target = { slug: event.slug };
    const request = { slug: target.slug };
    qr = request;
    void import('../client/event-qr').then(({ createEventQr }) => createEventQr(target)).then((code) => {
      if (qr?.slug === target.slug && !qr.code && !qr.error) qr = { slug: target.slug, code };
    }).catch(() => {
      if (qr?.slug === target.slug) qr = { slug: target.slug, error: 'Le QR code n’a pas pu être créé. Vous pouvez copier le lien.' };
    });
  }

  function printQr(clickEvent: MouseEvent): void {
    const code = currentQr?.code;
    if (!code || printing) return;
    // Capture before disabling the button or awaiting the lazy import, which can move browser focus.
    const trigger = clickEvent.currentTarget as HTMLButtonElement;
    const target = { slug: event.slug, name: event.name, countingScope: event.countingScope,
      startsAt: event.startsAt, endsAt: event.endsAt };
    let restored = false;
    const restoreFocus = async () => {
      if (restored) return;
      restored = true;
      printing = false;
      await tick();
      if (trigger.isConnected) trigger.focus();
    };
    printing = true;
    void import('../client/event-qr').then(({ printEventQr }) => printEventQr(target.name, code, () => { void restoreFocus(); }, target.countingScope, target)).catch(() => {
      feedback = { slug: target.slug, message: 'L’impression n’a pas pu s’ouvrir. Vous pouvez conserver le QR code affiché à l’écran.' };
      void restoreFocus();
    }).finally(() => { printing = false; });
  }
</script>

<div class="event-share" role="group" aria-label={isCity ? 'Partager ce comptage de commune' : 'Partager ce rassemblement'}>
  <div class="share-actions">
    <button class="share-button" type="button" onclick={copy} disabled={!ready || action !== null}>Copier le lien</button>
    {#if nativeAvailable}
      <button class="share-button" type="button" onclick={share} disabled={!ready || action !== null}>Partager</button>
    {/if}
    <button class="share-button" type="button" onclick={toggleQr} disabled={!ready} aria-expanded={currentQr !== null} aria-controls={`${id}-qr`}>
      {currentQr ? 'Masquer le QR code' : 'Afficher le QR code'}
    </button>
  </div>
  {#if currentQr}
    <div class="qr-card" id={`${id}-qr`}>
      {#if currentQr.code}
        <p class="qr-heading">{isCity ? 'Comptage de commune entière' : 'À montrer sur place'}</p>
        <img class="qr-image" src={currentQr.code.imageUrl} alt={`QR code pour ouvrir ${event.name}`} width="240" height="240" />
        <p class="qr-description">{isCity ? 'Scannez pour ouvrir ce comptage dans toute la commune. Aucun lieu de manifestation n’est confirmé et le comptage ne prouve pas une participation à une manifestation.' : 'Scannez pour ouvrir ce rassemblement, puis vous compter sur place.'}</p>
        <a class="qr-link" href={currentQr.code.url}>{currentQr.code.url}</a>
        <button class="share-button print-button" type="button" onclick={printQr} disabled={printing}>
          {printing ? 'Préparation de l’impression…' : 'Imprimer l’affiche'}
        </button>
      {:else}
        <p role="status">{currentQr.error ?? 'Création du QR code…'}</p>
      {/if}
    </div>
  {/if}
  {#if currentFeedback?.message}
    <p class="share-status" id={`${id}-status`} role="status" aria-live="polite" aria-atomic="true">{currentFeedback.message}</p>
  {/if}
  {#if currentFeedback?.manualUrl}
    <div class="manual-link">
      <label for={`${id}-link`}>{isCity ? 'Lien du comptage de commune' : 'Lien du rassemblement'}</label>
      <input
        id={`${id}-link`}
        type="url"
        value={currentFeedback.manualUrl}
        readonly
        spellcheck="false"
        autocomplete="off"
        aria-describedby={`${id}-status`}
        onfocus={(inputEvent) => inputEvent.currentTarget.select()}
        onclick={(inputEvent) => inputEvent.currentTarget.select()}
      />
    </div>
  {/if}
  {#if reportHref}
    <div class="event-report">
      <a href={reportHref} aria-describedby={`${id}-report-help`}>Signaler une erreur</a>
      <p id={`${id}-report-help`}>Ouvre votre messagerie. Indiquez l’erreur sur le lieu ou les horaires ; n’envoyez pas de GPS ni de secret.</p>
    </div>
  {/if}
</div>

<style>
  .event-share { margin-top: 18px; }
  .share-actions { display: flex; flex-wrap: wrap; gap: 10px; }
  .share-button {
    min-height: 48px; padding: 12px 17px; border: 1px solid var(--line);
    background: var(--surface); color: var(--ink); border-radius: 12px; font-size: 13px; line-height: 1.5; font-weight: 600;
  }
  .share-button:not(:disabled):hover { background: var(--surface-soft); border-color: var(--ink); }
  .share-button:disabled { opacity: 0.65; }
  .share-button:focus-visible, .qr-link:focus-visible { outline: 3px solid var(--ink); outline-offset: 3px; }
  .share-status { min-height: 1.6em; margin-top: 12px; color: var(--ink); font-size: 13px; line-height: 1.6; }
  .manual-link { margin-top: 10px; }
  .manual-link label { display: block; margin-bottom: 7px; font-size: 12px; font-weight: 600; }
  .manual-link input {
    display: block; width: 100%; min-width: 0; min-height: 48px; padding: 12px;
    border: 1px solid var(--line-strong); background: var(--paper); color: var(--ink); border-radius: 12px; font-size: 14px;
  }
  .qr-card { margin-top: 16px; padding: 22px; border: 1px solid var(--line); border-radius: 18px; background: var(--surface-soft); text-align: center; }
  .qr-heading { margin: 0 0 8px; font-size: 14px; font-weight: 700; }
  .qr-image { display: block; width: 240px; max-width: 100%; height: auto; margin: 0 auto; background: var(--qr-paper); }
  .qr-description { margin: 10px 0; font-size: 13px; line-height: 1.6; }
  .qr-link { display: block; min-height: 44px; padding: 10px 0; overflow-wrap: anywhere; color: var(--ink); font-size: 12px; line-height: 1.6; }
  .print-button { margin-top: 14px; max-width: 100%; }
  .event-report { margin-top: 22px; padding-top: 12px; border-top: 1px solid var(--line); }
  .event-report a { display: inline-flex; align-items: center; min-height: 44px; color: var(--ink); font-size: 13px; }
  .event-report a:focus-visible { outline: 3px solid var(--ink); outline-offset: 3px; }
  .event-report p { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.6; }
  :global(.event-qr-print-frame) { position: fixed; width: 1px; height: 1px; left: -10000px; top: 0; border: 0; }
  @media (max-width: 480px) {
    .share-button { flex: 1 1 140px; }
  }
</style>
