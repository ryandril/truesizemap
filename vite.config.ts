import { defineConfig } from 'vite'
export default defineConfig({
  base: '/',
  build: { target: 'es2022' },
  // cache-buster for the per-city boundary files in public/cities (they are not hashed by Vite)
  define: { __CITY_V__: JSON.stringify(Date.now().toString(36)) },
  // the cities pipeline writes thousands of files here while running; don't reload the dev page for them
  server: { watch: { ignored: ['**/public/cities/**', '**/data/**'] } },
})
