# The True Size Map

**https://truesizemap.ryandrilowell.com**

On 4 September 2026 the UN General Assembly adopted the “Correct the Map” resolution (164–1), encouraging the
[Equal Earth](https://en.wikipedia.org/wiki/Equal_Earth_projection) projection over Mercator wherever relative
size matters. This site lets you *feel* why: lift any country or continent off a Mercator map, drag it anywhere
and watch it re-size to its true relative area, then flip the whole map to Equal Earth.

- Up to three shapes at once, each labelled with its ratio to whatever it is sitting on.
- Tap a shape for a compare card (areas in km², ratio both ways).
- Presets: Greenland → Africa, Europe → Africa, Alaska → Mexico.
- “Copy link” encodes the current shapes and projection in the URL.
- Phone-first, no framework: Vite + TypeScript + D3, rendered on a `<canvas>`.

## Data

- **Countries** — [Natural Earth](https://www.naturalearthdata.com/) 1:50m admin-0 *countries* (public domain).
  Dependencies such as Greenland, Puerto Rico or Hong Kong are separate shapes; Alaska is added from admin-1.
  Names and borders are Natural Earth's own.
- **Continents** — seven, merged from Natural Earth's continent tags. Russia is cut at the Urals / Ural river
  (`scripts/build-countries.mjs`, `URAL_CUT`) so European and Asian Russia count toward the right continent.
  France's overseas departments, Hawaii, the Canary Islands and the Dutch Caribbean are re-assigned by location.
  All other transcontinental countries stay whole.
- **Areas** are computed from the drawn boundaries on a sphere (R = 6371.0088 km), so they differ slightly from
  official figures but always agree with the picture.
- **Cities** (OpenStreetMap administrative boundaries, ODbL) — coming next.

Rebuild the data (writes `src/assets/world.json`): `npm run data:countries` (expects the raw GeoJSON in `data/raw/`, see the script header).

## Develop

```bash
npm install
npm run dev
npm run build   # type-checks, then builds to dist/
```

Deploys to GitHub Pages from `main` via `.github/workflows/deploy.yml`.

## Licence

Code: MIT. Natural Earth data: public domain. OpenStreetMap-derived data (when added): ODbL, © OpenStreetMap contributors.

## Cities

`npm run data:cities` matches every Natural Earth populated place that carries a Wikidata ID (~7,100) to its
OpenStreetMap boundary relation: Wikidata's P402 (OSM relation ID) first, then Overpass for relations tagged with the
Wikidata ID, then Nominatim by name for the biggest leftovers. Geometry comes from polygons.openstreetmap.fr (falling
back to the OSM API), tags from the OSM API. Everything is cached in `data/cache/` so the run is resumable. Each boundary is simplified to ~700 points and written to `public/cities/<Qid>.json`, fetched by the
app only when that city is lifted; `src/assets/cities.json` is the search/label index. When a Wikidata ID maps to
several relations the pick is: administrative boundary → `place=city` → the most local `admin_level`. The
"definition" shown in labels comes from the relation's `place` / `border_type` / `admin_level` tags.
Many official boundaries include territorial water (Tokyo's runs to 42,000 km² of Pacific), so each polygon is
clipped to Natural Earth 10m land and the label says "land only" when that removed ≥5%. Coastline precision is
Natural Earth's, so small reclaimed-land cities (Singapore) read a little low. `data/cities-report.md` lists the misses.
