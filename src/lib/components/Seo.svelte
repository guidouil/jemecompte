<script lang="ts">
  import { SHARE_IMAGE_ALT } from '#lib/shared/seo';

  let { origin, title, description, path }: { origin: string; title: string; description: string; path: string } = $props();
  const imagePath = '/og/jemecompte-og-light.jpg';
  let canonical = $derived(new URL(path, origin).href);
  let image = $derived(new URL(imagePath, origin).href);
</script>

<svelte:head>
  <meta name="description" content={description} />
  <link rel="canonical" href={canonical} />
  <meta property="og:title" content={title} />
  <meta property="og:description" content={description} />
  <meta property="og:type" content="website" />
  <meta property="og:url" content={canonical} />
  <meta property="og:site_name" content="JE ME COMPTE" />
  <meta property="og:locale" content="fr_FR" />
  <meta property="og:image" content={image} />
  <meta property="og:image:type" content="image/jpeg" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content={SHARE_IMAGE_ALT} />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content={title} />
  <meta name="twitter:description" content={description} />
  <meta name="twitter:image" content={image} />
  <meta name="twitter:image:alt" content={SHARE_IMAGE_ALT} />
</svelte:head>
