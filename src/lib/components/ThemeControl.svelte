<script lang="ts">
  import { onMount } from 'svelte';

  let preference = $state('system');
  let ready = $state(false);

  onMount(() => {
    function synchronize() { preference = document.documentElement.dataset.themePreference ?? 'system'; }
    synchronize();
    ready = true;
    document.addEventListener('jemecompte:theme-applied', synchronize);
    return () => document.removeEventListener('jemecompte:theme-applied', synchronize);
  });

  function changeTheme(event: Event) {
    const value = (event.currentTarget as HTMLSelectElement).value;
    document.dispatchEvent(new CustomEvent('jemecompte:theme-change', { detail: value }));
  }
</script>

<label class="theme-control">
  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="8" /><path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" stroke="none" /></svg>
  <span class="sr-only">Apparence</span>
  <select aria-label="Apparence" value={preference} onchange={changeTheme} disabled={!ready}>
    <option value="system">Système</option>
    <option value="light">Clair</option>
    <option value="dark">Sombre</option>
  </select>
</label>

<style>
  .theme-control { display: inline-flex; align-items: center; gap: 6px; padding-left: 11px; border: 1px solid var(--line); border-radius: 999px; color: var(--ink); background: var(--surface); flex: none; }
  select { min-height: 40px; padding: 5px 25px 5px 0; border: 0; border-radius: 999px; background-color: transparent; color: inherit; font: inherit; font-size: 12px; font-weight: 650; width: auto; cursor: pointer; }
  select:disabled { cursor: default; }
  select:focus-visible { outline-offset: 3px; }
  svg { flex: none; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
</style>
