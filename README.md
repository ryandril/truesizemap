# The True Size Map

**[truesizemap.ryandrilowell.com](https://truesizemap.ryandrilowell.com)**

On 4 September 2026 the UN General Assembly adopted the “Correct the Map” resolution, 164 votes to 1. It asks
schools, governments and technology companies to use the [Equal Earth](https://en.wikipedia.org/wiki/Equal_Earth_projection)
projection, where every country is drawn at its true relative area, rather than defaulting to Mercator, the 1569
navigation chart most of us grew up with.

Reading that Greenland is not the size of Africa is one thing. Feeling it is another. So: lift any country,
continent or city off the map, drag it anywhere, and watch it resize as it travels. Then flip the whole map to
Equal Earth and watch the distortion go.

## What it does

- **Drag anything.** 238 countries and territories, 7 continents, 504 major cities. Up to three shapes at once,
  each labelled with its ratio to whatever it is sitting on.
- **Tap a shape** for a card giving both areas and the ratio each way.
- **Flip projections.** Mercator and Equal Earth blend into one another, keeping your zoom and centre.
- **Cities appear as real boundaries** once you zoom in far enough, fetched only when needed.
- **Presets** follow the level you are on, from Greenland → Africa down to New York → Tokyo.
- **Copy link** encodes the shapes and projection, so a link opens on exactly what you were looking at.
- Phone first, installable to a home screen, light and dark. No framework: Vite, TypeScript and D3 on a `<canvas>`.

## Data

**Countries** come from [Natural Earth](https://www.naturalearthdata.com/) 1:50m admin-0 *map units* (public
domain), so Greenland, Hong Kong and Puerto Rico are separate shapes; Alaska is added from admin-1. Names and
borders are Natural Earth's own.

**Continents** are seven, merged from Natural Earth's continent tags, with Russia cut at the Urals and the Ural
river (`URAL_CUT` in `scripts/build-countries.mjs`) so each half counts toward the right continent. France's
overseas departments, Hawaii, the Canary Islands and the Dutch Caribbean are reassigned by location; every other
transcontinental country stays whole.

**Cities** are OpenStreetMap administrative boundaries (ODbL, © OpenStreetMap contributors), matched to Natural
Earth's populated places by Wikidata ID. Only major cities ship: population of a million or more, or a national
capital above three hundred thousand, with a boundary between 15 and 40,000 km². That threshold exists because
a lot of official boundaries describe something other than the city — Riyadh's is a whole province, Manila's is
just the old town — and a wrong number is worse than a missing one. `data/cities-pruned.md` lists what was cut.

**Areas** are computed from the drawn boundaries on a sphere (R = 6371.0088 km), so they differ slightly from
published figures but always agree with the picture on screen. City boundaries are clipped to the coastline
first, because many of them include open water: Tokyo's official boundary runs to some 42,000 km² of Pacific,
against about 2,274 km² of land. Labels say “land only” where clipping removed a meaningful share.

### Rebuilding the data

```bash
npm run data:countries   # → src/assets/world.json + world-lite.json (coarse copy used during animation)
npm run data:cities      # → public/cities/<Qid>.json + data/cities-index.json  (hours; resumable, cached)
npm run data:prune       # → src/assets/cities.json, the major-city subset the site ships
```

The city pipeline resolves each place to an OpenStreetMap relation via Wikidata's P402, then Overpass, then
Nominatim for the largest leftovers; geometry comes from polygons.openstreetmap.fr with the OSM API as a
fallback. Everything is cached under `data/cache/`, so a re-run is cheap and the full set of about 4,500 cities
stays reproducible. Raw inputs live in `data/raw/` — see the header of each script for what to download.

## Develop

```bash
npm install
npm run dev              # http://localhost:5177
npm run build            # type-checks, then builds to dist/
```

In development the app exposes a `window.__tsm` hook (projection, ghosts, springs, render entry points), which
is how the tests below inspect state that never reaches the DOM.

## Tests

Playwright drives a real headless Chromium, once as a touch phone and once as a desktop with a mouse.

```bash
npm run build
npx vite preview --port 4173 --strictPort &
node tests/e2e.mjs       # 13 scenarios × 2 devices → tests/report.md + tests/shots/
```

`tests/measure-anim.mjs` samples an animation frame by frame and reports the per-frame pixel step, so
“is it smooth?” is a measurement rather than an opinion. `tests/repro-drag.mjs` and
`tests/repro-archipelago.mjs` are pinned reproductions of two bugs worth not repeating: momentum carrying a
dropped shape most of a continent past where it was released, and dropping an archipelago lifting a second,
unwanted shape.

## Deploy

Pushing to `main` builds and publishes to GitHub Pages via `.github/workflows/deploy.yml`.

The custom domain does not use GitHub's own certificate — it never issued one for this host. Instead the domain
resolves to a small VPS running Caddy, which terminates TLS and reverse-proxies to GitHub Pages by `Host`
header. Deploys are unaffected; only the edge differs.

## Licence

Code is MIT. Natural Earth data is public domain. OpenStreetMap-derived data is ODbL,
© OpenStreetMap contributors.
