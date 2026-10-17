import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  // Production uses scripts/build-release.mjs. The development identifier never
  // claims a Git or artifact verification, and no environment dump is exposed.
  define: {
    __JEMECOMPTE_BUILD_INFO__: process.env.JEMECOMPTE_BUILD_INFO || JSON.stringify({
      schemaVersion: 1, repository: 'https://github.com/guidouil/jemecompte', commit: null,
      workingTree: 'unavailable', sourceInventory: 'unavailable', sourceSha256: null,
      sourceFileCount: 0, lockSha256: null, node: null, npm: null, origin: null, admissionDifficulty: 18,
      builder: 'development', workflowRun: null, buildId: 'development'
    })
  },
  plugins: [
    sveltekit({
      adapter: adapter(),
      preprocess: vitePreprocess(),
      version: { name: process.env.JEMECOMPTE_BUILD_INFO ? JSON.parse(process.env.JEMECOMPTE_BUILD_INFO).buildId : 'development' },
      paths: { origin: process.env.ORIGIN || undefined },
      csp: {
        mode: 'auto',
        directives: {
          'default-src': ['self'],
          'script-src': ['self'],
          'style-src': ['self'],
          // Exact built-in SvelteKit route-announcer style; no blanket inline-style allowance.
          'style-src-attr': ['unsafe-hashes', 'sha256-S8qMpvofolR8Mpjy4kQvEm7m1q8clzU4dfDH0AmvZjo='],
          'img-src': ['self', 'data:'],
          'font-src': ['self'],
          'connect-src': command === 'serve' ? ['self', 'ws:'] : ['self'],
          'worker-src': ['self'],
          'object-src': ['none'],
          'base-uri': ['self'],
          'form-action': ['self'],
          'frame-ancestors': ['none']
        }
      }
    })
  ],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true }
}));
