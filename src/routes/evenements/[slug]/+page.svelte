<script lang="ts">
  import CountExperience from '#lib/components/CountExperience.svelte';
  import type { PageData } from './$types';
  let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>{data.selectedEvent?.name ?? 'Rassemblement'} — JeMeCompte</title></svelte:head>

{#key data.selectedEvent?.id}
  <CountExperience events={data.events} selectedEvent={data.selectedEvent} snapshot={data.snapshot} nationalTotal={data.nationalTotal} nationalSupportTotal={data.nationalSupportTotal} serviceAvailable={data.serviceAvailable} />
{/key}
