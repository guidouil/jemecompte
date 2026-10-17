/* Runs before the page is painted. An external same-origin file keeps the CSP strict. */
(() => {
  const key = 'jemecompte-theme';
  const root = document.documentElement;
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const valid = (value) => value === 'light' || value === 'dark' ? value : 'system';
  let preference = 'system';
  try { preference = valid(window.localStorage.getItem(key)); } catch { /* Storage may be unavailable. */ }

  function apply() {
    const theme = preference === 'system' ? system.matches ? 'dark' : 'light' : preference;
    root.dataset.theme = theme;
    root.dataset.themePreference = preference;
    const icon = document.getElementById('jmc-favicon');
    if (icon) icon.setAttribute('href', preference === 'system' ? '/icons/favicon.svg' : `/icons/favicon-${theme}.svg`);
    const png = document.getElementById('jmc-favicon-png');
    if (png) png.setAttribute('href', `/icons/favicon-${theme}-32.png`);
    const ico = document.getElementById('jmc-favicon-ico');
    if (ico) ico.setAttribute('href', `/icons/favicon-${theme}.ico`);
    const chrome = document.getElementById('jmc-theme-color');
    if (chrome) chrome.setAttribute('content', theme === 'dark' ? '#301D29' : '#FFF1D6');
    document.getElementById('jmc-theme-color-system-dark')?.remove();
    document.dispatchEvent(new CustomEvent('jemecompte:theme-applied'));
  }

  document.addEventListener('jemecompte:theme-change', (event) => {
    preference = valid(event.detail);
    try {
      if (preference === 'system') window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, preference);
    } catch { /* The current page can still switch themes without storage. */ }
    apply();
  });
  system.addEventListener('change', () => { if (preference === 'system') apply(); });
  window.addEventListener('storage', (event) => {
    if (event.key === key || event.key === null) { preference = valid(event.newValue); apply(); }
  });
  apply();
})();
