// Builds src/assets/world.json (TopoJSON) from Natural Earth 50m admin-0 countries.
// Objects:
//   countries  — every NE "country" (Greenland, Taiwan, Hong Kong… separate) + Alaska (US-AK)
//   continents — 7 merged continents; Russia is cut at the Urals into Europe/Asia parts
// Source data is public domain (Natural Earth). Run: npm run data:countries
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import * as topoServer from 'topojson-server'
import * as topoSimplify from 'topojson-simplify'
import * as topoClient from 'topojson-client'
import intersect from '@turf/intersect'
import difference from '@turf/difference'
import { featureCollection, polygon as turfPolygon } from '@turf/helpers'
import { geoCentroid } from 'd3'

const RAW = new URL('../data/raw/', import.meta.url)
const countriesRaw = JSON.parse(readFileSync(new URL('ne_50m_admin_0_countries.geojson', RAW), 'utf8'))
const alaska = JSON.parse(readFileSync(new URL('alaska.geojson', RAW), 'utf8'))

const CONTINENT_IDS = {
  Africa: 'AF', Asia: 'AS', Europe: 'EU', 'North America': 'NA',
  'South America': 'SA', Oceania: 'OC', Antarctica: 'AN',
}

// ---------- Ural cut line (north → south), then Ural river to the Caspian ----------
const URAL_CUT = [
  [66.0, 80.0], [66.5, 68.6], [64.5, 66.5], [61.5, 63.5], [59.8, 60.5], [58.8, 58.0],
  [58.2, 55.5], [58.6, 53.5], [58.5, 51.2], // Orsk
  [57.0, 51.0], [55.6, 50.9], [52.5, 51.3], [51.6, 49.9], [51.9, 47.1], [51.0, 45.0], // Ural river → Caspian
]
const europeBox = turfPolygon([[[-30, 85], [66.0, 85], ...URAL_CUT, [51.0, 35], [-30, 35], [-30, 85]]])

function splitRussia(russia) {
  const eu = intersect(featureCollection([russia, europeBox]))
  const as = difference(featureCollection([russia, europeBox]))
  if (!eu || !as) throw new Error('Russia split failed')
  // turf emits RFC 7946 winding (CCW exteriors); Natural Earth / d3 use CW exteriors. Rewind.
  const rewind = g => ({ ...g, coordinates: g.type === 'Polygon' ? g.coordinates.map(r => [...r].reverse()) : g.coordinates.map(poly => poly.map(r => [...r].reverse())) })
  return { eu: rewind(eu.geometry), as: rewind(as.geometry) }
}

// ---------- overrides for country *parts* that sit on another continent ----------
// France's overseas departments are baked into the France polygon in NE "countries".
function partContinent(countryName, defaultContinent, ring) {
  const [lon, lat] = geoCentroid({ type: 'Polygon', coordinates: ring })
  if (countryName === 'France') {
    if (lon > -60 && lon < -50 && lat > 1 && lat < 7) return 'South America' // French Guiana
    if (lon > 40 && lon < 60 && lat > -25 && lat < -10) return 'Africa' // Réunion, Mayotte
    if (lon > -65 && lon < -59 && lat > 12 && lat < 19) return 'North America' // Antilles
    if (lon > -150 && lon < -130 && lat > -30 && lat < -5) return 'Oceania' // Fr. Polynesia bits
  }
  if (countryName === 'United States of America' && lon < -150 && lat < 30) return 'Oceania' // Hawaii
  if (countryName === 'Netherlands' && lon < -60) return 'North America' // Caribbean municipalities
  if (countryName === 'Spain' && lon < -10 && lat < 30) return 'Africa' // Canary Islands
  if (countryName === 'Portugal' && lon < -20) return 'Europe' // Azores/Madeira stay Europe
  if (countryName === 'Norway' && lat < -50) return 'Antarctica' // Bouvet
  return defaultContinent
}

function polygonsOf(geometry) {
  return geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates
}

// ---------- countries object ----------
const countries = []
const parts = [] // { continent, coordinates(ring set) }
for (const f of countriesRaw.features) {
  const p = f.properties
  countries.push({
    type: 'Feature', id: p.ADM0_A3,
    properties: { n: p.NAME, c: CONTINENT_IDS[p.CONTINENT] ?? null, t: p.TYPE },
    geometry: f.geometry,
  })
  if (p.CONTINENT === 'Seven seas (open ocean)') continue
  if (p.NAME === 'Russia') {
    const { eu, as } = splitRussia(f)
    for (const ring of polygonsOf(eu)) parts.push({ continent: 'Europe', ring })
    for (const ring of polygonsOf(as)) parts.push({ continent: 'Asia', ring })
    continue
  }
  for (const ring of polygonsOf(f.geometry)) {
    parts.push({ continent: partContinent(p.NAME, p.CONTINENT, ring), ring })
  }
}
countries.push({
  type: 'Feature', id: 'US-AK',
  properties: { n: 'Alaska', c: 'NA', t: 'US state' },
  geometry: alaska.geometry,
})

// ---------- merge parts into continents ----------
const partsTopo = topoServer.topology({
  parts: {
    type: 'FeatureCollection',
    features: parts.map((p, i) => ({ type: 'Feature', id: i, properties: { c: p.continent }, geometry: { type: 'Polygon', coordinates: p.ring } })),
  },
}, 1e6)
const continents = []
for (const [name, id] of Object.entries(CONTINENT_IDS)) {
  const geoms = partsTopo.objects.parts.geometries.filter(g => g.properties.c === name)
  const merged = topoClient.merge(partsTopo, geoms)
  continents.push({ type: 'Feature', id, properties: { n: name, c: id, t: 'Continent' }, geometry: merged })
}

// ---------- final topology, simplified + quantized ----------
let topo = topoServer.topology({
  countries: { type: 'FeatureCollection', features: countries },
  continents: { type: 'FeatureCollection', features: continents },
})
topo = topoSimplify.presimplify(topo, topoSimplify.sphericalTriangleArea)
// Pin Antarctica's polar edge: the run of vertices along lat −90 is collinear, so the simplifier
// would collapse it to a single 360° segment — which d3 reads as the polygon turned inside-out.
for (const arc of topo.arcs) for (const pt of arc) if (pt[1] < -89.9) pt[2] = Infinity // (topology is unquantized here)
topo = topoSimplify.simplify(topo, topoSimplify.quantile(topo, 0.55))
topo = topoSimplify.filter(topo, topoSimplify.filterAttachedWeight(topo, 2e-9))
// strip simplification weights (z coordinates), then quantize + delta-encode for size
for (const arc of topo.arcs) for (const pt of arc) pt.length = 2
topo = topoClient.quantize(topo, 1e5)

mkdirSync(new URL('../src/assets/', import.meta.url), { recursive: true })
const out = JSON.stringify(topo)
writeFileSync(new URL('../src/assets/world.json', import.meta.url), out)

// report
const R = 6371.0088
const km2 = g => Math.round(topoClient.feature(topo, g).geometry ? geoAreaKm2(topoClient.feature(topo, g)) : 0)
function geoAreaKm2(f) { return d3GeoArea(f) * R * R }
import { geoArea as d3GeoArea } from 'd3'
console.log(`world.json ${(out.length / 1024).toFixed(0)} KB, ${topo.arcs.length} arcs, ${countries.length} countries`)
for (const g of topo.objects.continents.geometries) console.log(`  ${g.properties.n.padEnd(14)} ${km2(g).toLocaleString()} km²`)
for (const n of ['Greenland', 'Russia', 'Alaska', 'Mexico', 'Dem. Rep. Congo', 'Egypt', 'France']) {
  const g = topo.objects.countries.geometries.find(g => g.properties.n === n)
  console.log(`  ${n.padEnd(14)} ${km2(g).toLocaleString()} km²`)
}
