<script lang="ts">
  import '../app.css';
  import { page } from '$app/state';
  import BrandMark from '#lib/components/BrandMark.svelte';
  import ThemeControl from '#lib/components/ThemeControl.svelte';
  import Seo from '#lib/components/Seo.svelte';
  import { pageMetadata } from '#lib/shared/seo';
  import type { Snippet } from 'svelte';
  import type { LayoutData } from './$types';

  let { children, data }: { children: Snippet; data: LayoutData } = $props();
  let metadata = $derived(pageMetadata(page.url.pathname, page.data.selectedEvent));
</script>

<Seo origin={data.publicOrigin} {...metadata} />

<a class="skip-link" href="#contenu">Aller au contenu</a>

<div class="site-shell">
  <header class="site-header">
    <a class="wordmark" href="/" aria-label="JE ME COMPTE, accueil"><BrandMark /><span>JE ME COMPTE</span></a>
    <div class="header-actions">
      <nav class="primary-nav" aria-label="Navigation principale">
        <a class="header-link" href="/#rassemblements">Comptages</a>
        <a class="header-link" href="/creer">Créer</a>
        <a class="header-link" href="/comment-ca-marche">La méthode <span aria-hidden="true">↗</span></a>
      </nav>
      <ThemeControl />
    </div>
  </header>

  <main id="contenu" tabindex="-1">
    {@render children()}
  </main>

  <footer class="site-footer">
    <p>On est là,<br /><strong>on se compte.</strong></p>
    <nav aria-label="Informations">
      <a href="/comment-ca-marche">Méthode & limites</a>
      <a href="/confidentialite">Confidentialité</a>
      <a href="/transparence">Transparence du code</a>
      <a href="https://github.com/guidouil/jemecompte" target="_blank" rel="noopener noreferrer" aria-label="Code source sur GitHub (nouvel onglet)">Code source</a>
    </nav>
    <p class="footer-note">Protocole ouvert.<br /> Fait par <a href="https://x.com/guidouil" target="_blank" rel="noopener noreferrer" aria-label="Profil X de @guidouil (nouvel onglet)">@guidouil</a></p>
  </footer>
</div>

<style>
  .header-actions { display: flex; align-items: center; gap: 28px; }
  .primary-nav { display: flex; align-items: center; gap: 26px; }
  .primary-nav a { display: inline-flex; align-items: center; min-height: 44px; white-space: nowrap; }
  @media (max-width: 820px) {
    .site-header { height: auto; min-height: 83px; flex-wrap: wrap; gap: 9px; padding-top: 20px; padding-bottom: 6px; }
    .header-actions { width: 100%; justify-content: space-between; gap: 16px; }
    .primary-nav { gap: 16px; }
    .primary-nav a { font-size: 12px; }
  }
  @media (max-width: 390px) {
    .header-actions { gap: 9px; }
    .primary-nav { gap: 10px; }
    .primary-nav a { font-size: 11px; }
  }
</style>
