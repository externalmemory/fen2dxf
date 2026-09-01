import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // Relative so the build works unchanged from a subdirectory, e.g. GitHub Pages.
  base: './',
  build: { target: 'es2022', outDir: 'dist' },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      // No `includeAssets`: those files live in public/, so Vite copies them to the output
      // and the workbox glob below already precaches them. (The icons and the manifest still
      // appear twice in the precache list, because the plugin adds the manifest's own icons
      // as well. That is harmless -- both paths hash the same bytes, so the revisions always
      // agree and Workbox drops the duplicate rather than raising a conflict.)
      manifest: {
        name: 'fen2dxf - chess position to vinyl cutter',
        short_name: 'fen2dxf',
        description: 'Turn a chess position into a DXF cutting file for a vinyl cutter.',
        theme_color: '#16181d',
        background_color: '#16181d',
        display: 'standalone',
        orientation: 'any',
        start_url: './',
        scope: './',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The whole app is a few hundred kB and has no network dependencies, so precache
        // everything: it must work with no connection at all, next to the cutter.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
      },
    }),
  ],
});
