<script lang="ts">
  import { version } from '$app/env';
  import type { PageData } from './$types';
  let { data }: { data: PageData } = $props();
  const repository = 'https://github.com/guidouil/jemecompte';
</script>

<svelte:head><title>Transparence du code — JeMeCompte</title></svelte:head>

<article class="information-page">
  <a class="back-link" href="/">← Accueil</a>
  <p class="eyebrow">Code ouvert</p>
  <h1>Vérifier ce qui est publié</h1>
  <p class="information-lead">Le code est public. Cette page indique la version annoncée par le serveur et explique comment contrôler les fichiers publiés depuis un outil indépendant.</p>

  <section class="prose-section">
    <h2>La version annoncée</h2>
    <dl>
      <dt>Commit GitHub</dt><dd>{#if data.provenance.build.commit}<a href={`${repository}/commit/${data.provenance.build.commit}`}><code>{data.provenance.build.commit}</code></a>{:else}Indisponible{/if}</dd>
      <dt>État des sources au build</dt><dd>{data.provenance.build.workingTree === 'clean' ? 'Copie Git sans modification locale' : data.provenance.build.workingTree === 'modified' ? 'Modifications locales : ce build ne correspond pas exactement au commit' : 'Correspondance avec une copie Git non vérifiée'}</dd>
      <dt>Version du serveur</dt><dd><code>{data.provenance.build.buildId}</code></dd>
      <dt>Version de cette page</dt><dd><code>{version}</code></dd>
      <dt>Empreinte des sources publiques</dt><dd><code>{data.provenance.build.sourceSha256 || 'Indisponible'}</code></dd>
      <dt>Empreinte du manifeste de fichiers</dt><dd><code>{data.provenance.manifest?.sha256 || 'Indisponible'}</code></dd>
      <dt>Fabrication</dt><dd>{#if data.provenance.build.workflowRun}<a href={data.provenance.build.workflowRun}>Consulter l’exécution GitHub Actions</a>{:else}{data.provenance.build.builder === 'clever-cloud' ? 'Reconstruction chez Clever Cloud' : 'Build local ou de développement'}{/if}</dd>
    </dl>
    <p><a href="/api/version" data-sveltekit-reload>Télécharger les métadonnées publiques en JSON</a>. Cette page et cette réponse sont exclues du cache hors ligne. Une PWA déjà ouverte peut conserver un ancien client jusqu’à sa prochaine ouverture.</p>
  </section>

  <section class="prose-section">
    <h2>Une vérification indépendante</h2>
    <p>Le workflow de publication prépare une archive complète du serveur, du client et des dépendances nécessaires au démarrage. Son attestation GitHub relie son empreinte au dépôt, au commit et au workflow de fabrication. L’archive contient un manifeste SHA-256 pour contrôler chaque fichier.</p>
    <p>Depuis une copie du dépôt de confiance, vous pouvez vérifier cette attestation, contrôler l’archive puis comparer les ressources publiques du site. Le script utilise une connexion directe et contourne les caches du navigateur.</p>
    <p><a href={`${repository}/blob/main/docs/code-provenance.md`}>Lire la procédure et les commandes de vérification</a> · <a href={`${repository}/actions/workflows/release.yml`}>Voir les publications d’artefacts</a></p>
  </section>

  <section class="prose-section">
    <h2>Ce que cette preuve couvre</h2>
    <p>Une attestation vérifiée prouve l’origine d’une archive et de ses fichiers. La comparaison publique contrôle les fichiers reçus par la personne qui la réalise. Un identifiant affiché par le site reste une déclaration du serveur.</p>
    <p>Une simple page web ne permet pas d’inspecter le programme réellement exécuté chez l’hébergeur. Un opérateur disposant des accès à l’hébergement peut changer le serveur ou présenter des réponses différentes. Vérifier les fichiers installés et les journaux de déploiement nécessite un contrôle distinct chez l’hébergeur.</p>
    <p>Cette preuve ne certifie pas la base de données, la configuration, les chiffres ni l’unicité humaine des déclarations. Les limites du comptage et les corrections connues doivent être examinées séparément. Aucun secret, identifiant de participant ou ligne individuelle de participation n’est publié ici.</p>
    <p><a href="/comment-ca-marche">Comprendre les limites du comptage</a> · <a href="/confidentialite">Confidentialité</a></p>
  </section>
</article>

<style>
  dl { display: grid; grid-template-columns: minmax(8rem, 1fr) minmax(0, 2fr); gap: 0.8rem 1.5rem; }
  dt { font-weight: 600; }
  dd { margin: 0; overflow-wrap: anywhere; }
  code { font-size: 0.85em; }
  @media (max-width: 600px) { dl { grid-template-columns: 1fr; gap: 0.35rem; } dd { margin-bottom: 0.9rem; } }
</style>
