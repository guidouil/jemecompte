import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../static/theme-init.js', import.meta.url), 'utf8');

function themePage(stored: string | null = null, dark = false, unavailableStorage = false) {
  const documentListeners = new Map<string, (event: { detail?: string }) => void>();
  const windowListeners = new Map<string, (event: { key: string | null; newValue: string | null }) => void>();
  const elements = new Map<string, { attributes: Record<string, string>; setAttribute: (name: string, value: string) => void; remove: () => void }>();
  for (const id of ['jmc-favicon', 'jmc-favicon-png', 'jmc-favicon-ico', 'jmc-theme-color', 'jmc-theme-color-system-dark']) {
    const attributes: Record<string, string> = {};
    elements.set(id, { attributes, setAttribute: (name, value) => { attributes[name] = value; }, remove: () => { elements.delete(id); } });
  }
  const dataset: Record<string, string> = {};
  const memory = new Map(stored ? [['jemecompte-theme', stored]] : []);
  let systemChange = () => {};
  const system = { matches: dark, addEventListener: (_: string, fn: () => void) => { systemChange = fn; } };
  const document = {
    documentElement: { dataset },
    getElementById: (id: string) => elements.get(id),
    addEventListener: (name: string, fn: (event: { detail?: string }) => void) => documentListeners.set(name, fn),
    dispatchEvent: (event: { type: string; detail?: string }) => documentListeners.get(event.type)?.(event)
  };
  runInNewContext(source, {
    document,
    window: {
      matchMedia: () => system,
      localStorage: {
        getItem: (key: string) => { if (unavailableStorage) throw new Error('Storage unavailable'); return memory.get(key) ?? null; },
        setItem: (key: string, value: string) => { if (unavailableStorage) throw new Error('Storage unavailable'); memory.set(key, value); },
        removeItem: (key: string) => { if (unavailableStorage) throw new Error('Storage unavailable'); memory.delete(key); }
      },
      addEventListener: (name: string, fn: (event: { key: string | null; newValue: string | null }) => void) => windowListeners.set(name, fn)
    },
    CustomEvent: class { constructor(public type: string) {} }
  });
  return {
    dataset, memory,
    attribute: (id: string, name: string) => elements.get(id)?.attributes[name],
    choose: (preference: string) => document.dispatchEvent({ type: 'jemecompte:theme-change', detail: preference }),
    system: (matches: boolean) => { system.matches = matches; systemChange(); },
    storage: (value: string | null) => windowListeners.get('storage')?.({ key: 'jemecompte-theme', newValue: value })
  };
}

describe('theme initialization before hydration', () => {
  it('follows the system by default and reacts to its changes with the adaptive SVG', () => {
    const page = themePage(null, true);
    expect(page.dataset).toEqual({ theme: 'dark', themePreference: 'system' });
    expect(page.attribute('jmc-favicon', 'href')).toBe('/icons/favicon.svg');
    expect(page.attribute('jmc-theme-color', 'content')).toBe('#301D29');
    page.system(false);
    expect(page.dataset.theme).toBe('light');
    expect(page.attribute('jmc-favicon-png', 'href')).toBe('/icons/favicon-light-32.png');
    expect(page.attribute('jmc-theme-color', 'content')).toBe('#FFF1D6');
  });

  it('applies a saved choice immediately, keeps it above the system, and synchronizes fixed favicons', () => {
    const page = themePage('light', true);
    expect(page.dataset.theme).toBe('light');
    expect(page.attribute('jmc-favicon', 'href')).toBe('/icons/favicon-light.svg');
    page.system(false);
    page.system(true);
    expect(page.dataset.theme).toBe('light');
    page.choose('dark');
    expect(page.memory.get('jemecompte-theme')).toBe('dark');
    expect(page.attribute('jmc-favicon', 'href')).toBe('/icons/favicon-dark.svg');
    expect(page.attribute('jmc-favicon-ico', 'href')).toBe('/icons/favicon-dark.ico');
    page.choose('system');
    expect(page.memory.has('jemecompte-theme')).toBe(false);
    page.system(false);
    expect(page.dataset.theme).toBe('light');
  });

  it('synchronizes another tab and remains usable with unavailable or invalid storage', () => {
    const page = themePage('unsupported', false, true);
    expect(page.dataset.themePreference).toBe('system');
    page.choose('dark');
    expect(page.dataset.theme).toBe('dark');
    page.storage('light');
    expect(page.dataset.theme).toBe('light');
    page.storage(null);
    expect(page.dataset.themePreference).toBe('system');
  });
});
