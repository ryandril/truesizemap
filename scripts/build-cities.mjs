// Builds the city layer:
//   public/cities/<Qid>.json   — one simplified boundary per city, fetched by the app on demand
//   src/assets/cities.json     — the search/label index (name, country, lon/lat, population, area, definition)
//   data/cities-report.md      — hit rate + misses
//
// Seed: Natural Earth 10m populated places (public domain), keyed by Wikidata ID.
// Boundary = the OpenStreetMap relation for that Wikidata item (ODbL, © OpenStreetMap contributors):
//   1. relation id  — Wikidata P402 (SPARQL, batched) → Overpass tags-only (batched, if it is up)
//                     → Nominatim by name for the biggest leftovers
//   2. tags         — OSM API /relation/<id>.json (definition: place / border_type / admin_level)
//   3. geometry     — polygons.openstreetmap.fr (pre-simplified), falling back to OSM API /full + osmtogeojson
// Everything is cached under data/cache/ so the run is resumable. Run: npm run data:cities
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import osmtogeojson from 'osmtogeojson'
import * as topoServer from 'topojson-server'
import * as topoSimplify from 'topojson-simplify'
import * as topoClient from 'topojson-client'
import { geoArea } from 'd3'
import intersect from '@turf/intersect'
import bboxClip from '@turf/bbox-clip'
import turfBbox from '@turf/bbox'
import { featureCollection } from '@turf/helpers'

const ROOT = new URL('../', import.meta.url)
const P = (rel) => new URL(rel, ROOT)
const UA = 'truesizemap-build/0.2 (https://github.com/ryandril/truesizemap; ryandril@gmail.com)'
const R = 6371.0088
const TARGET_POINTS = 700
const CONCURRENCY = 3
const NOMINATIM_MIN_POP = 300_000

for (const d of ['data/cache/', 'data/cache/rel/', 'public/cities/']) mkdirSync(P(d), { recursive: true })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const fold = (t) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
const readJSON = (u) => JSON.parse(readFileSync(u, 'utf8'))
const cached = (name, fn) => async (...a) => {
  const u = P(`data/cache/${name}`); if (existsSync(u)) return readJSON(u)
  const v = await fn(...a); if (v !== null) writeFileSync(u, JSON.stringify(v)); return v
}
async function get(url, opts = {}, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { ...opts, headers: { 'User-Agent': UA, ...(opts.headers ?? {}) }, signal: AbortSignal.timeout(opts.timeout ?? 60_000) })
      if (r.status === 429 || r.status >= 500) { await sleep(4000 * (i + 1)); continue }
      return r
    } catch { await sleep(3000 * (i + 1)) }
  }
  return null
}

// ---------- seed ----------
const SKIP = new Set(['Scientific station', 'Meteorological Station', 'Historic place'])
const raw = readJSON(P('data/raw/ne_10m_populated_places.geojson'))
const seed = new Map()
for (const f of raw.features) {
  const p = f.properties
  if (SKIP.has(p.FEATURECLA) || !p.WIKIDATAID) continue
  const prev = seed.get(p.WIKIDATAID)
  if (prev && prev.pop >= p.POP_MAX) continue
  seed.set(p.WIKIDATAID, {
    id: p.WIKIDATAID, n: p.NAME_EN || p.NAME, c: p.ADM0NAME, lon: +p.LONGITUDE.toFixed(3), lat: +p.LATITUDE.toFixed(3),
    pop: p.POP_MAX, cap: p.FEATURECLA.startsWith('Admin-0 capital'),
  })
}
const ids = [...seed.keys()]
console.log(`seed: ${ids.length} places with Wikidata IDs`)

// ---------- 1. relation ids ----------
const relOf = new Map() // qid → { rel, src }
const sparql = cached('p402.json', async () => {
  const out = {}
  for (let i = 0; i < ids.length; i += 400) {
    const batch = ids.slice(i, i + 400)
    const q = `SELECT ?item ?rel WHERE { VALUES ?item { ${batch.map(x => 'wd:' + x).join(' ')} } ?item wdt:P402 ?rel . }`
    const r = await get('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q), { headers: { Accept: 'application/sparql-results+json' } })
    if (!r?.ok) { console.log('  sparql failed for a batch', r?.status); continue }
    for (const b of (await r.json()).results.bindings) { const qq = b.item.value.split('/').pop(); if (!out[qq]) out[qq] = +b.rel.value }
    await sleep(500)
  }
  return out
})
const p402 = await sparql()
for (const [q, rel] of Object.entries(p402)) relOf.set(q, { rel, src: 'wikidata' })
console.log(`P402: ${relOf.size}`)

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter']
function pickRelation(rels) {
  const adm = rels.filter(r => r.tags.boundary === 'administrative'); const pool = adm.length ? adm : rels
  const city = pool.filter(r => r.tags.place === 'city' || r.tags.border_type === 'city'); const cand = city.length ? city : pool
  return cand.sort((a, b) => (+b.tags.admin_level || 0) - (+a.tags.admin_level || 0))[0]
}
const tagsOf = new Map() // rel → tags (from Overpass, saves an OSM API call)

// Discovery of the remaining ids runs CONCURRENTLY with geometry fetching: Overpass is slow/flaky today,
// so each successful batch just feeds the work queue as it lands. Best effort: one try per mirror, short timeout.
const queue = [] // qids ready for geometry
const enqueue = (q) => queue.push(q)
let discoveryDone = false
async function discover() {
  const missing = ids.filter(q => !relOf.has(q))
  let ep = 0, hits = 0, failed = 0
  for (let i = 0; i < missing.length; i += 150) {
    const batch = missing.slice(i, i + 150)
    const data = await cached(`overpass-tags-${String(i / 150).padStart(2, '0')}.json`, async () => {
      const q = `[out:json][timeout:45];relation["type"="boundary"]["wikidata"~"^(${batch.join('|')})$"];out tags;`
      for (let attempt = 0; attempt < ENDPOINTS.length; attempt++) {
        const r = await get(ENDPOINTS[ep++ % ENDPOINTS.length], { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q), timeout: 50_000 }, 1)
        if (r?.ok) { const j = await r.json().catch(() => null); if (j) return j.elements.map(e => ({ rel: e.id, tags: e.tags })) }
        await sleep(3000)
      }
      return null // not cached: null means "try again next run"
    })()
    if (data === null) { failed++; continue }
    const byWd = {}
    for (const e of data) for (const wd of (e.tags.wikidata || '').split(';').map(x => x.trim())) (byWd[wd] ??= []).push(e)
    for (const q of batch) if (byWd[q] && !relOf.has(q)) { const r = pickRelation(byWd[q]); relOf.set(q, { rel: r.rel, src: 'overpass' }); tagsOf.set(r.rel, r.tags); enqueue(q); hits++ }
    console.log(`  overpass ${Math.min(i + 150, missing.length)}/${missing.length}: +${hits} (${failed} batches unavailable)`)
    await sleep(1000)
  }
  // Nominatim for the biggest leftovers (1 req/s, cached individually)
  const big = ids.filter(q => !relOf.has(q) && seed.get(q).pop >= NOMINATIM_MIN_POP).sort((a, b) => seed.get(b).pop - seed.get(a).pop)
  console.log(`  nominatim fallback for ${big.length} places ≥ ${NOMINATIM_MIN_POP.toLocaleString()}`)
  let nh = 0
  for (const q of big) {
    const s = seed.get(q)
    const hit = await cached(`nominatim-${q}.json`, async () => {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(s.n + ', ' + s.c)}`
      const r = await get(url); await sleep(1100)
      if (!r?.ok) return { none: true }
      const rows = (await r.json()).filter(x => x.osm_type === 'relation' && (x.category === 'boundary' || x.category === 'place'))
      const near = rows.find(x => Math.abs(+x.lat - s.lat) < 1.5 && Math.abs(+x.lon - s.lon) < 1.5) // must sit near the seed point
      if (near) return { rel: near.osm_id }
      // Search often returns the place *node*; reverse-geocode the seed point at city→county zoom and accept the
      // enclosing boundary whose English name contains the city's name ("City of Cape Town", "Jeddah Governorate").
      const want = fold(s.n)
      for (const z of [10, 9, 8]) {
        const rr = await get(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&accept-language=en&zoom=${z}&lat=${s.lat}&lon=${s.lon}`); await sleep(1100)
        if (!rr?.ok) continue
        const x = await rr.json()
        if (x.osm_type === 'relation' && x.category === 'boundary' && fold((x.name || '') + ' ' + (x.display_name || '')).includes(want)) return { rel: x.osm_id }
      }
      return { none: true }
    })()
    if (!hit.none) { relOf.set(q, { rel: hit.rel, src: 'nominatim' }); enqueue(q); nh++ }
  }
  console.log(`  nominatim: +${nh}`)
  discoveryDone = true
}

// ---------- 2 + 3. tags and geometry per relation ----------
const LEVEL_WORD = { 2: 'country', 3: 'region', 4: 'province-level', 5: 'region', 6: 'county-level', 7: 'municipality', 8: 'municipality', 9: 'district', 10: 'district' }
function definition(t) {
  if (t.place && t.place !== 'yes') return t.place.replace(/_/g, ' ')
  if (t.border_type) return t.border_type.replace(/_/g, ' ')
  if (t.admin_level && LEVEL_WORD[t.admin_level]) return LEVEL_WORD[t.admin_level]
  return 'administrative area'
}
// Many OSM city relations include territorial waters (Tokyo's runs 42,000 km² of Pacific). Clip to land
// (Natural Earth 10m) so the area is land area. Skipped when the clip would remove >80% (data misalignment).
const landPolys = readJSON(P('data/raw/ne_10m_land.geojson')).features.flatMap(f => f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates).map(c => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: c }, bbox: turfBbox({ type: 'Polygon', coordinates: c }) }))
const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]
function clipToLand(feat) {
  const bb = turfBbox(feat); const pad = [bb[0] - 0.05, bb[1] - 0.05, bb[2] + 0.05, bb[3] + 0.05]
  const parts = []
  for (const lp of landPolys) if (overlaps(lp.bbox, pad)) { const c = bboxClip(lp, pad); if (c.geometry.coordinates.length) parts.push(c) }
  if (!parts.length) return { feat, water: 0 }
  const landHere = { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: parts.flatMap(p => p.geometry.type === 'Polygon' ? [p.geometry.coordinates] : p.geometry.coordinates) } }
  const cut = intersect(featureCollection([feat, landHere]))
  if (!cut) return { feat, water: 0 }
  const before = sphericalArea(feat), after = sphericalArea(cut)
  if (after < before * 0.02) return { feat, water: 0 } // essentially nothing left: the land dataset misses this place
  return { feat: cut, water: Math.round((1 - after / before) * 100) }
}
const sphericalArea = (f) => geoArea({ type: 'Feature', properties: {}, geometry: normalizeWinding(f.geometry) })
const rewind = (g) => ({ ...g, coordinates: g.type === 'Polygon' ? g.coordinates.map(r => [...r].reverse()) : g.coordinates.map(poly => poly.map(r => [...r].reverse())) })
/** d3 wants clockwise exteriors (spherical "inside" = the small side). Fix each polygon part on its own, since
 *  clipping libraries emit RFC 7946 winding (counter-clockwise) and mixed inputs otherwise cancel each other out. */
function normalizeWinding(g) {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates
  const fixed = polys.map(rings => geoArea({ type: 'Polygon', coordinates: [rings[0]] }) > 2 * Math.PI ? rings.map(r => [...r].reverse()) : rings)
  return g.type === 'Polygon' ? { type: 'Polygon', coordinates: fixed[0] } : { type: 'MultiPolygon', coordinates: fixed }
}
function finish(geom) {
  let feat = { type: 'Feature', properties: {}, geometry: normalizeWinding(geom) }
  const { feat: clipped, water } = clipToLand(feat)
  feat = { type: 'Feature', properties: {}, geometry: normalizeWinding(clipped.geometry) }
  let topo = topoServer.topology({ c: feat })
  const total = topo.arcs.reduce((n, a) => n + a.length, 0)
  if (total > TARGET_POINTS) {
    topo = topoSimplify.presimplify(topo, topoSimplify.sphericalTriangleArea)
    topo = topoSimplify.simplify(topo, topoSimplify.quantile(topo, 1 - TARGET_POINTS / total))
    topo = topoSimplify.filter(topo, topoSimplify.filterAttachedWeight(topo, 1e-11))
    for (const arc of topo.arcs) for (const pt of arc) pt.length = 2
  }
  const out = topoClient.feature(topo, topo.objects.c)
  if (!out.geometry) return null
  const round = (r) => r.map(([x, y]) => [+x.toFixed(4), +y.toFixed(4)])
  out.geometry.coordinates = out.geometry.type === 'Polygon' ? out.geometry.coordinates.map(round) : out.geometry.coordinates.map(p => p.map(round))
  out.geometry = normalizeWinding(out.geometry)
  out.water = water
  return out
}
async function relationTags(rel) {
  if (tagsOf.has(rel)) return tagsOf.get(rel)
  return cached(`rel/${rel}-tags.json`, async () => {
    const r = await get(`https://api.openstreetmap.org/api/0.6/relation/${rel}.json`)
    if (!r?.ok) return {}
    return (await r.json()).elements?.[0]?.tags ?? {}
  })()
}
async function relationGeometry(rel) {
  return cached(`rel/${rel}-geom.json`, async () => {
    let r = await get(`https://polygons.openstreetmap.fr/get_geojson.py?id=${rel}&params=0.002-0.0005-0.0005`, {}, 2)
    const txt = r?.ok ? await r.text() : ''
    if (txt.startsWith('{')) { try { const g = JSON.parse(txt); if (g.type === 'MultiPolygon' || g.type === 'Polygon') return g } catch { /* fall through */ } }
    r = await get(`https://api.openstreetmap.org/api/0.6/relation/${rel}/full.json`, { timeout: 120_000 }, 2)
    if (!r?.ok) return { error: 'no geometry available' }
    const fc = osmtogeojson(await r.json(), { flatProperties: true })
    const polys = fc.features.filter(f => f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'))
    if (!polys.length) return { error: 'relation has no closed polygon' }
    return polys.length === 1 ? polys[0].geometry : { type: 'MultiPolygon', coordinates: polys.flatMap(f => f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates) }
  })()
}

const index = [], misses = []
const writeIndex = (final = false) => writeFileSync(P(final ? 'src/assets/cities.json' : 'data/cities-index.json'), JSON.stringify(index.sort((a, b) => b.pop - a.pop).map(({ src, ...row }) => final ? row : { ...row, src })))

for (const q of ids.filter(q => relOf.has(q)).sort((a, b) => seed.get(b).pop - seed.get(a).pop)) enqueue(q) // biggest cities first
let done = 0; const t0 = Date.now()
async function worker() {
  while (queue.length || !discoveryDone) {
    if (!queue.length) { await sleep(2000); continue }
    const q = queue.shift(); const s = seed.get(q); const { rel, src } = relOf.get(q)
    try {
      const [tags, geom] = await Promise.all([relationTags(rel), relationGeometry(rel)])
      if (geom.error) { misses.push({ ...s, why: geom.error }); continue }
      const feat = finish(geom)
      if (!feat) { misses.push({ ...s, why: 'empty after simplification' }); continue }
      const a = Math.round(geoArea(feat) * R * R)
      if (a < 1 || a > 3.5e6) { misses.push({ ...s, why: `implausible area ${a.toLocaleString()} km²` }); continue }
      // a metropolis mapped to a 4 km² old-town municipality is the wrong relation (Damascus): better a miss than a lie
      if ((s.pop >= 500_000 && a < 15) || (s.pop >= 100_000 && a < 3)) { misses.push({ ...s, why: `boundary too small for its population (${a} km²)` }); continue }
      const name = tags['name:en'] || s.n
      const def = definition(tags)
      const water = feat.water; delete feat.water
      feat.id = q; feat.properties = { n: name, def, a, osm: rel, water }
      writeFileSync(P(`public/cities/${q}.json`), JSON.stringify(feat))
      index.push({ id: q, n: name, c: s.c, lon: s.lon, lat: s.lat, pop: s.pop, a, cap: s.cap ? 1 : 0, w: water, src }) // def lives in the boundary file
    } catch (e) { misses.push({ ...s, why: 'error: ' + e.message }) }
    finally {
      done++
      if (done % 50 === 0) { writeIndex(); console.log(`${done} fetched (${queue.length} queued)  ok ${index.length}  miss ${misses.length}  ${((Date.now() - t0) / 60000).toFixed(1)} min`) }
    }
  }
}
await Promise.all([discover(), ...Array.from({ length: CONCURRENCY }, worker)])
for (const q of ids) if (!relOf.has(q)) misses.push({ ...seed.get(q), why: 'no OpenStreetMap relation found for this Wikidata item' })
writeIndex(); writeIndex(true)

const lines = [
  `# Cities build report`, ``, `Seed: ${ids.length} Natural Earth places with Wikidata IDs.`,
  `Matched to an OpenStreetMap boundary: **${index.length}** (via Wikidata P402: ${index.filter(i => i.src === 'wikidata').length}, Overpass: ${index.filter(i => i.src === 'overpass').length}, Nominatim: ${index.filter(i => i.src === 'nominatim').length}). Missed: ${misses.length}.`, ``,
  `## Misses (population order)`, ``, `| Wikidata | Place | Country | Pop | Why |`, `|---|---|---|---|---|`,
  ...misses.sort((a, b) => b.pop - a.pop).map(m => `| ${m.id} | ${m.n} | ${m.c} | ${m.pop.toLocaleString()} | ${m.why} |`),
]
writeFileSync(P('data/cities-report.md'), lines.join('\n') + '\n')
console.log(`done: ${index.length} cities, ${misses.length} misses → data/cities-report.md`)
