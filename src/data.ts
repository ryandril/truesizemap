import { feature as topoFeature } from 'topojson-client'
import type { Topology, GeometryCollection } from 'topojson-specification'
import { areaKm2, centroid, bounds, type Bounds, type LonLat, type PolyFeature } from './geo'
import worldUrl from './assets/world.json?url' // hashed by Vite, so a rebuilt file is never served stale

export type Level = 'city' | 'country' | 'continent'

export interface Place {
  id: string
  name: string
  level: Level
  /** what the boundary means, shown in labels: "Sovereign country", "Dependency", "Continent"… */
  def: string
  feature: PolyFeature
  areaKm2: number
  centroid: LonLat
  bounds: Bounds
  /** where the name is drawn on the map (Natural Earth LABEL_X/Y, hand-set for continents) */
  label: LonLat
}

export interface World {
  countries: Place[]
  continents: Place[]
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
  const byId = new Map<string, Place>()
  for (const p of [...countries, ...continents]) byId.set(p.id, p)
  return { countries, continents, byId, land: countries.filter(c => c.id !== 'US-AK').map(c => c.feature) }
}

/** Light-weight search over names: prefix matches first, then substring. */
export function searchPlaces(world: World, q: string, limit = 8): Place[] {
  const s = q.trim().toLowerCase()
  if (!s) return []
  const all = [...world.continents, ...world.countries]
  const pre = all.filter(p => p.name.toLowerCase().startsWith(s))
  const sub = all.filter(p => !p.name.toLowerCase().startsWith(s) && p.name.toLowerCase().includes(s))
  return [...pre, ...sub].slice(0, limit)
}
