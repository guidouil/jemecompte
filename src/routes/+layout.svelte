<script lang="ts">
  import '../app.css';
  import type { Snippet } from 'svelte';

  let { children }: { children: Snippet } = $props();
</script>

<svelte:head>
  <meta name="theme-color" content="#f5f5ed" media="(prefers-color-scheme: light)" />
  <meta name="theme-color" content="#141c17" media="(prefers-color-scheme: dark)" />
  <meta name="description" content="Des comptages volontaires par rassemblement ou par commune, sans inscription. Découvrez JeMeCompte et les limites de son protocole." />
</svelte:head>

<a class="skip-link" href="#contenu">Aller au contenu</a>

<div class="site-shell">
  <header class="site-header">
    <a class="wordmark" href="/" aria-label="JeMeCompte, accueil">JeMeCompte<span class="brand-dot" aria-hidden="true"></span></a>
    <nav class="primary-nav" aria-label="Navigation principale">
      <a class="header-link" href="/#rassemblements">Comptages</a>
      <a class="header-link" href="/creer">Créer</a>
      <a class="header-link" href="/comment-ca-marche">La méthode <span aria-hidden="true">↗</span></a>
    </nav>
  </header>

  <main id="contenu" tabindex="-1">
    {@render children()}
  </main>

  <footer class="site-footer">
    <p>Un geste individuel.<br /><strong>Un chiffre collectif.</strong></p>
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
  .primary-nav { display: flex; align-items: center; gap: 26px; }
  .primary-nav a { display: inline-flex; align-items: center; min-height: 44px; white-space: nowrap; }
  @media (max-width: 700px) {
    .site-header { height: auto; min-height: 83px; flex-wrap: wrap; gap: 9px; padding-top: 20px; padding-bottom: 6px; }
    .primary-nav { width: 100%; justify-content: space-between; gap: 12px; }
    .primary-nav a { font-size: 12px; }
  }
</style>
