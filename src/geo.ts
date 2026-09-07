import { geoRotation, geoArea, geoCentroid, geoBounds, geoContains } from 'd3'
import type { Feature, Polygon, MultiPolygon, Position } from 'geojson'

export type PolyGeom = Polygon | MultiPolygon
export type PolyFeature = Feature<PolyGeom>
export type LonLat = [number, number]

const EARTH_R_KM = 6371.0088

export function areaKm2(f: PolyFeature): number {
  return geoArea(f) * EARTH_R_KM * EARTH_R_KM
}

export function centroid(f: PolyFeature): LonLat {
  const c = geoCentroid(f)
  return [c[0], c[1]]
}

/**
 * Rigidly move a geometry on the sphere so that `from` lands on `to`, keeping
 * north pointing north at the shape's centre. Three rotations:
 *   spin `from` onto the prime meridian, slide it along that meridian to the target
 *   latitude, spin to the target longitude.  Shape and area are preserved exactly;
 *   only the projection will distort it.
 */
export function moveGeometry(g: PolyGeom, from: LonLat, to: LonLat): PolyGeom {
  const a = geoRotation([-from[0], 0])
  const b = geoRotation([0, to[1] - from[1]])
  const c = geoRotation([to[0], 0])
  const mv = (p: Position): Position => {
    const q = c(b(a([p[0], p[1]])))
    return [q[0], q[1]]
  }
  const ring = (r: Position[]) => r.map(mv)
  if (g.type === 'Polygon') return { type: 'Polygon', coordinates: g.coordinates.map(ring) }
  return { type: 'MultiPolygon', coordinates: g.coordinates.map(poly => poly.map(ring)) }
}

export interface Bounds { minLon: number; minLat: number; maxLon: number; maxLat: number; wraps: boolean }

export function bounds(f: PolyFeature): Bounds {
  const [[a, b], [c, d]] = geoBounds(f)
  return { minLon: a, minLat: b, maxLon: c, maxLat: d, wraps: a > c }
}

export function inBounds(bb: Bounds, [lon, lat]: LonLat): boolean {
  if (lat < bb.minLat || lat > bb.maxLat) return false
  return bb.wraps ? lon >= bb.minLon || lon <= bb.maxLon : lon >= bb.minLon && lon <= bb.maxLon
}

export function contains(f: PolyFeature, p: LonLat): boolean {
  return geoContains(f, p)
}

export function fmtKm2(v: number): string {
  if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 1 : 2) + 'M km²'
  if (v >= 1e4) return Math.round(v / 1e3).toLocaleString() + 'k km²'
  return Math.round(v).toLocaleString() + ' km²'
}

export function fmtRatio(a: number, b: number): { pct: string; times: string; short: string } {
  const r = a / b
  const pct = r < 0.0001 ? '<0.01%' : r < 0.01 ? (r * 100).toFixed(2) + '%' : r < 1 ? (r * 100).toFixed(r < 0.1 ? 1 : 0) + '%' : (r * 100).toFixed(0) + '%'
  const times = r >= 1 ? (r >= 10 ? r.toFixed(0) : r.toFixed(1)) + '×' : (1 / r >= 10 ? (1 / r).toFixed(0) : (1 / r).toFixed(1)) + '× smaller'
  const short = r >= 1 ? (r >= 10 ? r.toFixed(0) : r.toFixed(1)) + '×' : pct
  return { pct, times, short }
}
