import { feature as topoFeature } from 'topojson-client'
import type { Topology, GeometryCollection } from 'topojson-specification'
import { areaKm2, centroid, bounds, type Bounds, type LonLat, type PolyFeature } from './geo'
import worldUrl from './assets/world.json?url' // hashed by Vite, so a rebuilt file is never served stale
import citiesUrl from './assets/cities.json?url'
import worldLiteUrl from './assets/world-lite.json?url'

export type Level = 'city' | 'country' | 'continent'

export interface Place {
  id: string
  name: string
  level: Level
  /** what the boundary means, shown in labels: "Sovereign country", "Dependency", "Continent"… */
  def: string
  /** null for a city whose boundary has not been fetched yet */
  feature: PolyFeature | null
  areaKm2: number
  centroid: LonLat
  bounds: Bounds
  /** where the name is drawn on the map (Natural Earth LABEL_X/Y, hand-set for continents) */
  label: LonLat
  /** cities only */
  country?: string
  pop?: number
  capital?: boolean
  /** % of the official boundary that was water and got clipped away (cities) */
  water?: number
}

interface CityRow { id: string; n: string; c: string; lon: number; lat: number; pop: number; a: number; def?: string; cap: number; w?: number }

export interface World {
  countries: Place[]
  continents: Place[]
  /** population-descending; boundaries load lazily via loadCity() */
  cities: Place[]
  byId: Map<string, Place>
  land: PolyFeature[] // what to draw as land = countries
}

interface Props { n: string; c: string | null; t: string; lx: number; ly: number }

const DEF: Record<string, string> = {
  'Sovereign country': 'sovereign state',
  Sovereignty: 'sovereign state',
  Country: 'country',
  Dependency: 'dependency',
  Disputed: 'disputed territory',
  Indeterminate: 'territory',
  Lease: 'leased territory',
  'US state': 'US state',
  Continent: 'continent',
}

export async function loadWorld(url = worldUrl): Promise<World> {
  const topo = (await (await fetch(url)).json()) as Topology<{ countries: GeometryCollection<Props>; continents: GeometryCollection<Props> }>
  const toPlaces = (key: 'countries' | 'continents', level: Level): Place[] => {
    const fc = topoFeature(topo, topo.objects[key])
    const feats = (fc.type === 'FeatureCollection' ? fc.features : [fc]) as PolyFeature[]
    return feats
      .filter(f => f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'))
      .map(f => {
        const p = f.properties as unknown as Props
        return {
          id: String(f.id),
          name: p.n,
          level,
          def: DEF[p.t] ?? p.t.toLowerCase(),
          feature: f,
          areaKm2: areaKm2(f),
          centroid: centroid(f),
          bounds: bounds(f),
          label: [p.lx, p.ly],
        }
      })
  }
  const countries = toPlaces('countries', 'country')
  const continents = toPlaces('continents', 'continent')
  let cities: Place[] = []
  try {
    const rows = (await (await fetch(citiesUrl)).json()) as CityRow[]
    cities = rows.map(r => ({
      id: r.id, name: r.n, level: 'city' as Level, def: r.def ?? 'administrative area', feature: null, areaKm2: r.a,
      centroid: [r.lon, r.lat] as LonLat, bounds: { minLon: r.lon, minLat: r.lat, maxLon: r.lon, maxLat: r.lat, wraps: false },
      label: [r.lon, r.lat] as LonLat, country: r.c, pop: r.pop, capital: !!r.cap, water: r.w ?? 0,
    }))
  } catch { /* no cities yet */ }
  const byId = new Map<string, Place>()
  for (const p of [...countries, ...continents, ...cities]) byId.set(p.id, p)
  return { countries, continents, cities, byId, land: countries.filter(c => c.id !== 'US-AK').map(c => c.feature!) }
}

/** Coarse country outlines for animation frames (projection morph). Loaded after start. */
let liteJob: Promise<PolyFeature[]> | null = null
export function loadWorldLite(): Promise<PolyFeature[]> {
  if (!liteJob) liteJob = (async () => {
    const topo = (await (await fetch(worldLiteUrl)).json()) as Topology<{ countries: GeometryCollection<Props> }>
    const fc = topoFeature(topo, topo.objects.countries)
    const feats = (fc.type === 'FeatureCollection' ? fc.features : [fc]) as PolyFeature[]
    return feats.filter(f => f.geometry && String(f.id) !== 'US-AK')
  })()
  return liteJob
}

const cityLoads = new Map<string, Promise<Place>>()
/** Fetch a city's boundary (once) and fill in its geometry, true centroid and bounds. */
export function loadCity(p: Place): Promise<Place> {
  if (p.feature) return Promise.resolve(p)
  let job = cityLoads.get(p.id)
  if (!job) {
    job = fetch(`/cities/${p.id}.json?v=${__CITY_V__}`).then(async r => {
      if (!r.ok) throw new Error(`no boundary for ${p.name}`)
      const f = (await r.json()) as PolyFeature
      const props = f.properties as { def?: string; n?: string; water?: number } | null
      if (props?.def) p.def = props.def
      if (props?.water !== undefined) p.water = props.water
      p.feature = f
      p.areaKm2 = areaKm2(f)
      p.centroid = centroid(f)
      p.bounds = bounds(f)
      return p
    })
    cityLoads.set(p.id, job)
  }
  return job
}

const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
/** Search over names: prefix matches first (continents, countries, then cities by population), then substring. */
export function searchPlaces(world: World, q: string, limit = 8): Place[] {
  const s = fold(q.trim())
  if (!s) return []
  const all = [...world.continents, ...world.countries, ...world.cities]
  const pre = all.filter(p => fold(p.name).startsWith(s))
  const sub = all.filter(p => !fold(p.name).startsWith(s) && fold(p.name).includes(s))
  return [...pre, ...sub].slice(0, limit)
}
