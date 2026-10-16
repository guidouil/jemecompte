<script lang="ts">
  import { onMount } from 'svelte';
  import type { PublicEvent } from '../shared/types';
  import { copyEventLink, nativeShareAvailable, shareEvent } from '../client/event-sharing';

  let { event }: { event: PublicEvent } = $props();
  const id = $props.id();
  let nativeAvailable = $state(false);
  let action = $state<'copy' | 'share' | null>(null);
  let feedback = $state<{ slug: string; message: string; manualUrl?: string } | null>(null);
  const currentFeedback = $derived(feedback?.slug === event.slug ? feedback : null);

  onMount(() => { nativeAvailable = nativeShareAvailable(); });

  function copy(): void {
    if (action) return;
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
    if (action) return;
    const target = { slug: event.slug, name: event.name };
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
</script>

<div class="event-share" role="group" aria-label="Partager ce rassemblement">
  <div class="share-actions">
    <button class="share-button" type="button" onclick={copy} disabled={action !== null}>Copier le lien</button>
    {#if nativeAvailable}
      <button class="share-button" type="button" onclick={share} disabled={action !== null}>Partager</button>
    {/if}
  </div>
  {#if currentFeedback?.message}
    <p class="share-status" id={`${id}-status`} role="status" aria-live="polite" aria-atomic="true">{currentFeedback.message}</p>
  {/if}
  {#if currentFeedback?.manualUrl}
    <div class="manual-link">
      <label for={`${id}-link`}>Lien du rassemblement</label>
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
</div>

<style>
  .event-share { margin-top: 18px; }
  .share-actions { display: flex; flex-wrap: wrap; gap: 10px; }
  .share-button {
    min-height: 48px; padding: 12px 17px; border: 1px solid var(--line);
    background: transparent; color: var(--ink); font-size: 13px; line-height: 1.5; font-weight: 600;
  }
  .share-button:not(:disabled):hover { background: var(--soft-green); border-color: var(--green); }
  .share-button:disabled { opacity: 0.65; }
  .share-status { min-height: 1.6em; margin-top: 8px; color: var(--muted); font-size: 12px; line-height: 1.6; }
  .manual-link { margin-top: 10px; }
  .manual-link label { display: block; margin-bottom: 7px; font-size: 12px; font-weight: 600; }
  .manual-link input {
    display: block; width: 100%; min-width: 0; min-height: 48px; padding: 12px;
    border: 1px solid var(--line); background: var(--paper); color: var(--ink); font-size: 14px;
  }
  @media (max-width: 480px) {
    .share-button { flex: 1 1 140px; }
  }
</style>
