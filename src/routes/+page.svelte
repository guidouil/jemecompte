<script lang="ts">
  import CountExperience from '#lib/components/CountExperience.svelte';
  import type { PageData } from './$types';
  let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>JeMeCompte — participations et soutiens</title></svelte:head>

<CountExperience events={data.events} selectedEvent={data.selectedEvent} snapshot={data.snapshot} nationalTotal={data.nationalTotal} nationalCityTotal={data.nationalCityTotal} nationalSupportTotal={data.nationalSupportTotal} nationalCitySupportTotal={data.nationalCitySupportTotal} nationalLoadedAt={data.nationalLoadedAt} serviceAvailable={data.serviceAvailable} />
