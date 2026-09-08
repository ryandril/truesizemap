import {
  geoMercator, geoEqualEarth, geoMercatorRaw, geoEqualEarthRaw, geoProjection, geoPath, geoGraticule10, zoom as d3zoom, zoomIdentity, select, interpolateZoom, easeCubicInOut,
  type GeoProjection, type ZoomTransform, type ZoomBehavior,
} from 'd3'
import { loadWorld, loadCity, loadWorldLite, searchPlaces, type Level, type Place, type World } from './data'
import { moveGeometry, contains, inBounds, fmtKm2, fmtRatio, type LonLat, type PolyFeature } from './geo'
import { Spring, rubberband, reducedMotion } from './spring'

type ProjName = 'mercator' | 'equalearth'

interface Ghost {
  key: number
  place: Place
  anchor: LonLat          // presentation value — what is on screen right now
  color: string
  feature: PolyFeature    // moved geometry
  sx: Spring; sy: Spring  // lon / lat springs (independent axes)
  px?: Spring; py?: Spring // screen-space springs used while travelling (see glideTo)
  glide?: LonLat           // destination of an in-flight travel, re-projected every frame
  lift: Spring            // 0 = flat on the map, 1 = lifted, >1 = held
  settled?: () => void
}

const COLORS = ['#E8A33D', '#2FA39A', '#E26D5A']
const MAX_GHOSTS = 3
const ZOOM_BANDS: { max: number; level: Level }[] = [{ max: 6, level: 'country' }, { max: Infinity, level: 'city' }] // Continent only via the tab
const CITY_NAMES_FROM = 2.2     // zoom from which city names appear
const CITY_BORDERS_FROM = 7     // zoom from which city boundaries are drawn (fetched lazily)
const CITY_TAP_PX = 18
const MAX_ZOOM = 500

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T
const app = $('#app')
const canvas = $<HTMLCanvasElement>('#map')
const ctx = canvas.getContext('2d')!
const labelsEl = $('#labels')
const hintEl = $('#hint')
const toastEl = $('#toast')
const stage = $('.stage')
const topEl = $('.top')
const controlsEl = $('.controls')
const compareEl = $('#compare')

// ------------------------------------------------------------------ state
let world: World
let projName: ProjName = 'mercator'
let projection: GeoProjection
let baseScale = 1
let baseTranslate: [number, number] = [0, 0]
let worldY: [number, number] = [0, 1] // top/bottom of the drawn world at k=1, in base px (north/south pan limits)
let transform: ZoomTransform = zoomIdentity
let levelOverride: Level | null = null
let overrideBand = -1
let ghosts: Ghost[] = []
let ghostSeq = 0
let selected: Ghost | null = null
let hoverPlace: Place | null = null
let pressPlace: Place | null = null
let width = 0, height = 0, dpr = 1, insetTop = 0, insetBottom = 0
let frame = 0
let zoomBehavior: ZoomBehavior<HTMLCanvasElement, unknown>
let suppressHash = false

const graticule = geoGraticule10()
const sphere = { type: 'Sphere' } as const

// map palette comes from the stylesheet so light/dark stay in one place
type Pal = Record<'ocean' | 'land' | 'grid' | 'border' | 'borderStrong' | 'borderFaint' | 'hover' | 'hoverLine' | 'outline' | 'accent' | 'label' | 'labelDim' | 'halo' | 'cityFill' | 'cityLine', string>
let pal: Pal
function readPalette() {
  const cs = getComputedStyle(document.documentElement)
  const v = (n: string) => cs.getPropertyValue(n).trim()
  pal = { ocean: v('--map-ocean'), land: v('--map-land'), grid: v('--map-grid'), border: v('--map-border'), borderStrong: v('--map-border-strong'),
    borderFaint: v('--map-border-faint'), hover: v('--map-hover'), hoverLine: v('--map-hover-line'), outline: v('--map-outline'), accent: v('--gold'),
    label: v('--map-label'), labelDim: v('--map-label-dim'), halo: v('--map-halo'), cityFill: v('--map-city-fill'), cityLine: v('--map-city-line') }
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', v('--bg'))
}
function isLight() { return getComputedStyle(document.documentElement).colorScheme.includes('light') }
function setTheme(t: 'light' | 'dark') {
  document.documentElement.dataset.theme = t
  document.documentElement.classList.remove('system-light')
  try { localStorage.setItem('theme', t) } catch { /* private mode */ }
  $('#theme').textContent = t === 'light' ? '☾' : '☀'
  readPalette(); requestDraw()
}
const maxLat = () => projName === 'mercator' ? 82 : 89

// ------------------------------------------------------------------ projection & sizing
function makeProjection(): GeoProjection {
  const p = projectionFor(projName)
  baseScale = p.scale()
  baseTranslate = p.translate() as [number, number]
  const lat = projName === 'mercator' ? 85 : 90
  worldY = [p([0, lat])![1], p([0, -lat])![1]]
  return p
}
/** A fitted projection for the current viewport (does not touch globals). */
function projectionFor(projName: ProjName): GeoProjection {
  const p = projName === 'mercator' ? geoMercator() : geoEqualEarth()
  const pad = 8
  const visH = height - insetTop - insetBottom
  p.fitExtent([[pad, insetTop + pad], [width - pad, height - insetBottom - pad]], sphere)
  if (projName === 'mercator') {
    if (width > visH) {
      // landscape: fill the width, let the poles run off (they are ice anyway); centre ~12°N in the visible band
      p.scale((width - 2 * pad) / (2 * Math.PI))
      p.translate([width / 2, 0])
      const y = p([0, 12])![1]
      p.translate([width / 2, insetTop + visH / 2 - y])
    } else {
      // portrait (phones): fill the height instead of leaving empty bands; centre on 10°E / 15°N so Greenland,
      // Europe, Africa and the Americas are all in the first view — the user pans for the rest
      p.scale((visH - 2 * pad) / (2 * Math.PI) * 1.15)
      p.translate([0, 0])
      const c = p([10, 15])!
      p.translate([width / 2 - c[0], insetTop + visH / 2 - c[1]])
    }
  }
  return p
}
function applyTransform() {
  projection.scale(baseScale * transform.k)
  projection.translate([baseTranslate[0] * transform.k + transform.x, baseTranslate[1] * transform.k + transform.y])
}
function measureChrome() {
  insetTop = topEl.offsetHeight
  insetBottom = controlsEl.offsetHeight
  app.style.setProperty('--top-h', insetTop + 'px')
  app.style.setProperty('--controls-h', insetBottom + 'px')
}
function resize() {
  measureChrome()
  const r = stage.getBoundingClientRect()
  width = Math.max(1, Math.round(r.width)); height = Math.max(1, Math.round(r.height))
  dpr = Math.min(window.devicePixelRatio || 1, width * height > 2.2e6 ? 1.25 : width * height > 1.4e6 ? 1.5 : 2)
  canvas.width = width * dpr; canvas.height = height * dpr
  canvas.style.width = width + 'px'; canvas.style.height = height + 'px'
  projection = makeProjection()
  applyTransform()
  requestDraw()
}

// ------------------------------------------------------------------ level
function bandFor(k: number) { return ZOOM_BANDS.findIndex(b => k < b.max) }
function currentLevel(): Level {
  return levelOverride ?? ZOOM_BANDS[bandFor(transform.k)].level
}
function setLevel(l: Level) { levelOverride = l; overrideBand = bandFor(transform.k); syncLevelUI(); deferFullBase(); requestDraw() }
/** Re-render the base cheaply now and at full detail once things settle — a full render costs ~400 ms. */
function deferFullBase() {
  if (!liteLand) return
  zooming = true
  clearTimeout(baseTimer)
  baseTimer = window.setTimeout(() => { baseTimer = 0; zooming = false; renderBase(); requestDraw() }, 160)
}
let hintLevel: Level | null = null
function syncLevelUI() {
  const l = currentLevel()
  if (world) renderPresets()
  if (world && !ghosts.length && l !== hintLevel && !hintEl.textContent.startsWith('Loading')) { hintLevel = l; hintEl.textContent = HINT[l]; hintEl.classList.remove('off') }
  document.querySelectorAll<HTMLButtonElement>('[data-level]').forEach(b => {
    const on = b.dataset.level === l
    b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on))
  })
}
function placesAt(level: Level): Place[] { return level === 'continent' ? world.continents : level === 'country' ? world.countries : world.cities.filter(c => !!c.feature) }

// ------------------------------------------------------------------ hit testing
function placeAtPoint(p: LonLat, level: Level): Place | null {
  let best: Place | null = null // prefer the smaller place when overlapping (Alaska sits inside the USA)
  for (const pl of placesAt(level)) {
    if (!pl.feature || !inBounds(pl.bounds, p)) continue
    if (contains(pl.feature, p) && (!best || pl.areaKm2 < best.areaKm2)) best = pl
  }
  return best
}
function ghostAtPoint(p: LonLat): Ghost | null {
  for (let i = ghosts.length - 1; i >= 0; i--) if (contains(ghosts[i].feature, p)) return ghosts[i]
  return null
}
function invert(xy: [number, number]): LonLat | null {
  if (!projection || !world || morphing || !projection.invert) return null
  for (const dx of worldCopies()) {
    const q: [number, number] = [xy[0] - dx, xy[1]]
    const r = projection.invert(q)
    if (!r || !isFinite(r[0]) || !isFinite(r[1])) continue
    const back = projection([r[0], r[1]]) // reject points outside this copy's outline
    if (!back || Math.hypot(back[0] - q[0], back[1] - q[1]) > 1) continue
    return [((r[0] + 540) % 360) - 180, r[1]]
  }
  return null
}

/** city dots drawn in the last base render, in screen px */
let visibleCities: { c: Place; x: number; y: number }[] = []
function cityAtPixel(xy: [number, number], radius = CITY_TAP_PX): Place | null {
  let best: Place | null = null, bd = radius * radius
  for (const v of visibleCities) { // reproject: the base render may lag a zoom gesture by a frame or two
    const p = screenPos(v.c.label); if (!p) continue
    const d = (p[0] - xy[0]) ** 2 + (p[1] - xy[1]) ** 2; if (d < bd) { bd = d; best = v.c }
  }
  return best
}

// ------------------------------------------------------------------ ghosts
/** Lift a place; a city fetches its boundary first. */
let liftSeq = 0
async function liftPlace(place: Place, anchor?: LonLat, animateLift = true): Promise<Ghost | null> {
  const seq = ++liftSeq
  if (!place.feature) {
    hintEl.textContent = `Loading ${place.name}…`; hintEl.classList.remove('off')
    try { await loadCity(place) }
    catch { if (seq === liftSeq) { toast(`No boundary for ${place.name} yet`); hintEl.classList.add('off') } return null }
    if (seq !== liftSeq) return null // the user has moved on
  }
  hintEl.classList.add('off')
  const g = addGhost(place, anchor, animateLift)
  zoomToSee(g)
  return g
}

/** If a lifted shape is a speck at the current zoom (small cities at world view), zoom in on it. */
function zoomToSee(g: Ghost) {
  const size = bodySizePx(g.place) * transform.k
  if (size >= 28) { // big enough already; just make sure it is on screen
    if (!onScreenPt(screenPos(g.anchor), 10)) animateZoom(viewTransform(transform.k, g.anchor), 550)
    return
  }
  const visH = height - insetTop - insetBottom
  const want = Math.min(width, visH) * 0.22
  const k = Math.max(1, Math.min(MAX_ZOOM, transform.k * (want / Math.max(size, 1))))
  if (!isFinite(k)) return
  // centre the ghost's anchor in the visible band at the new scale. Screen = k·base + t, so t = centre − k·base
  const p = projection(g.anchor); if (!p) return
  const bx = (p[0] - transform.x) / transform.k, by = (p[1] - transform.y) / transform.k // anchor in base (k=1) coords
  const cx = width / 2, cy = insetTop + visH / 2
  const t = zoomIdentity.translate(cx - k * bx, cy - k * by).scale(k)
  lastZoom = { size, k, t: [t.k, t.x, t.y], p, from: [transform.k, transform.x, transform.y] }
  animateZoom(t)
}
let lastZoom: unknown = null

/** Animate the view to a transform along d3's zoom-out-then-in path. rAF-driven so it works without d3-transition. */
let zoomAnim = 0
let zoomDone: (() => void) | null = null
function animateZoom(target: ZoomTransform, ms = 650): Promise<void> {
  cancelAnimationFrame(zoomAnim); zoomDone?.(); zoomDone = null
  if (reducedMotion() || ms === 0) { select(canvas).call(zoomBehavior.transform, target); return Promise.resolve() }
  return new Promise<void>(resolve => {
  zoomDone = resolve
  const visH = height - insetTop - insetBottom
  const cx = width / 2, cy = insetTop + visH / 2
  const a = transform, b = target
  const view = (t: ZoomTransform): [number, number, number] => [(cx - t.x) / t.k, (cy - t.y) / t.k, Math.min(width, visH) / t.k]
  const i = interpolateZoom(view(a), view(b))
  const dur = Math.max(ms, Math.min(1400, i.duration))
  const t0 = performance.now()
  const step = (now: number) => {
    const u = easeCubicInOut(Math.min(1, (now - t0) / dur))
    const v = i(u); const k = Math.min(width, visH) / v[2]
    select(canvas).call(zoomBehavior.transform, zoomIdentity.translate(cx - v[0] * k, cy - v[1] * k).scale(k))
    if (u < 1) zoomAnim = requestAnimationFrame(step); else { select(canvas).call(zoomBehavior.transform, target); zoomDone = null; resolve() }
  }
  zoomAnim = requestAnimationFrame(step)
  })
}
/** Screen position of a point, using the copy of the world nearest the viewport (Mercator wraps). */
function screenPos(ll: LonLat): [number, number] | null {
  const p = projection(ll); if (!p) return null
  let x = p[0]; const w = worldWidth()
  if (projName === 'mercator') { while (x < 0 && x + w < width) x += w; while (x > width && x - w > 0) x -= w }
  return [x, p[1]]
}
const onScreenPt = (xy: [number, number] | null, m = 0) => !!xy && xy[0] > m && xy[0] < width - m && xy[1] > insetTop + m && xy[1] < height - insetBottom - m
/** A view that frames two places together (both fully in the visible band). */
function viewForPair(a: Place, b: Place): ZoomTransform {
  const visH = height - insetTop - insetBottom
  const s0 = projection.scale(), t0 = projection.translate()
  projection.scale(baseScale).translate(baseTranslate)
  const pts: [number, number][] = []
  for (const pl of [a, b]) {
    const bb = pl.bounds
    if (bb.wraps || bb.maxLon - bb.minLon > 200) { const c = projection(pl.label); if (c) pts.push(c) } // Russia/USA span the date line: use the centre
    else for (const q of [[bb.minLon, bb.minLat], [bb.maxLon, bb.maxLat], [bb.minLon, bb.maxLat], [bb.maxLon, bb.minLat]] as LonLat[]) { const c = projection(q); if (c) pts.push(c) }
  }
  projection.scale(s0).translate(t0)
  if (pts.length < 2) return zoomIdentity
  // bring x's onto the same copy of the world (nearest to the first point)
  const w = 2 * Math.PI * baseScale
  if (projName === 'mercator') for (const q of pts) { while (q[0] - pts[0][0] > w / 2) q[0] -= w; while (pts[0][0] - q[0] > w / 2) q[0] += w }
  const x0 = Math.min(...pts.map(q => q[0])), x1 = Math.max(...pts.map(q => q[0])), y0 = Math.min(...pts.map(q => q[1])), y1 = Math.max(...pts.map(q => q[1]))
  const k = Math.max(1, Math.min(MAX_ZOOM, 0.78 * Math.min(width / Math.max(x1 - x0, 1), visH / Math.max(y1 - y0, 1))))
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
  return zoomIdentity.translate(width / 2 - k * cx, insetTop + visH / 2 - k * cy).scale(k)
}
/** A view that frames `place` at about `frac` of the visible band. */
function viewFor(place: Place, frac = 0.3): ZoomTransform {
  const b = place.bounds
  const visH = height - insetTop - insetBottom
  const s0 = projection.scale(), t0 = projection.translate()
  projection.scale(baseScale).translate(baseTranslate)
  const a = projection([b.minLon, b.minLat]), c = projection([b.maxLon, b.maxLat])
  projection.scale(s0).translate(t0)
  if (!a || !c) return zoomIdentity
  const size = Math.min(b.wraps ? Infinity : Math.max(Math.abs(c[0] - a[0]), Math.abs(c[1] - a[1]), 1), bodySizePx(place))
  const k = Math.max(1, Math.min(MAX_ZOOM, (Math.min(width, visH) * frac) / size))
  return viewTransform(k, place.label)
}
/** Approximate on-screen size (base px, k = 1) of a place's main body, from its area rather than its bounding box. */
function bodySizePx(place: Place): number {
  const sideKm = Math.sqrt(place.areaKm2) * 1.6
  const lat = place.label[1] * Math.PI / 180
  const pxPerKm = (2 * Math.PI * baseScale) / (40075 * (projName === 'mercator' ? Math.cos(lat) : 1))
  return sideKm * pxPerKm
}
function addGhost(place: Place, anchor?: LonLat, animateLift = true): Ghost {
  const existing = ghosts.find(g => g.place.id === place.id)
  if (existing && !anchor) { selected = existing; showCompare(existing); requestDraw(); return existing }
  if (ghosts.length >= MAX_GHOSTS) { removeGhost(ghosts[0]); toast('Three at a time — oldest removed') }
  const used = new Set(ghosts.map(g => g.color))
  const color = COLORS.find(c => !used.has(c)) ?? COLORS[0]
  const a = anchor ?? place.label
  const g: Ghost = {
    key: ++ghostSeq, place, anchor: a, color, feature: place.feature!,
    sx: new Spring(a[0], 1, 0.4), sy: new Spring(a[1], 1, 0.4),
    lift: new Spring(animateLift && !reducedMotion() ? 0 : 1, 1, 0.4),
  }
  setAnchor(g, a)
  if (animateLift && !reducedMotion()) { g.lift.to(1); kick() }
  ghosts.push(g)
  hintEl.textContent = 'Drag it anywhere · tap to compare'
  $('#clear').hidden = false
  requestDraw(); pushHash()
  return g
}
function setAnchor(g: Ghost, a: LonLat) {
  const T0 = performance.now()
  const cap = maxLat() + 3 // rubber-band headroom
  g.anchor = [((a[0] + 540) % 360) - 180, Math.max(-cap, Math.min(cap, a[1]))]
  const same = Math.abs(g.anchor[0] - g.place.label[0]) < 1e-6 && Math.abs(g.anchor[1] - g.place.label[1]) < 1e-6
  g.feature = same ? g.place.feature! : { type: 'Feature', properties: {}, geometry: moveGeometry(g.place.feature!.geometry, g.place.label, g.anchor) }
  mark('move', T0)
}
const HINT: Record<Level, string> = { continent: 'Tap a continent, then drag it', country: 'Tap a country, then drag it', city: 'Tap a city name or search one' }
function resetHintIfEmpty() { if (!ghosts.length) { hintEl.textContent = HINT[currentLevel()]; hintEl.classList.remove('off') } }
function removeGhost(g: Ghost) {
  g.settled?.(); g.settled = undefined
  ghosts = ghosts.filter(x => x !== g)
  resetHintIfEmpty()
  if (selected === g) { selected = null; hideCompare() }
  $('#clear').hidden = ghosts.length === 0
  requestDraw(); pushHash()
}
function clearGhosts() { for (const g of ghosts) { g.settled?.(); g.settled = undefined } ghosts = []; selected = null; resetHintIfEmpty(); hideCompare(); $('#clear').hidden = true; requestDraw(); pushHash() }

/** what the ghost is "over": the place under its anchor at the current level, excluding itself. */
function under(g: Ghost): Place | null {
  const cur = currentLevel()
  if (transform.k >= CITY_BORDERS_FROM && g.place.level !== 'continent') { // zoomed into city borders: compare with the city underneath
    const c = placeAtPoint(g.anchor, 'city')
    if (c && c.id !== g.place.id && c.name.toLowerCase() !== g.place.name.toLowerCase()) return c
  }
  const lvl: Level = g.place.level === 'continent' ? 'continent' : cur === 'continent' ? 'continent' : 'country'
  const p = placeAtPoint(g.anchor, lvl)
  if (!p || p.id === g.place.id || p.name.toLowerCase() === g.place.name.toLowerCase()) return null // Singapore-the-city on Singapore-the-country
  return p
}

/**
 * Travel a ghost to a destination. The springs run on SCREEN pixels, not longitude/latitude: on Mercator a
 * degree of latitude is worth wildly different pixel counts at 72°N and at 6°N, so a spring in degrees looks
 * like it rockets away and then crawls. Independent x and y springs, critically damped, and the target is
 * re-projected every frame so a camera move happening at the same time is absorbed without a seam.
 * Interruptible: grabbing the shape clears `glide` and the drag takes over from the live position.
 */
function glideTo(g: Ghost, to: LonLat): Promise<void> {
  if (reducedMotion()) { g.sx.jump(to[0]); g.sy.jump(to[1]); setAnchor(g, to); requestDraw(); pushHash(); return Promise.resolve() }
  const from = projection(g.anchor), dst = projection(to)
  if (from && dst) {
    g.px = new Spring(from[0], 1, 0.55); g.py = new Spring(from[1], 1, 0.55)
    g.px.to(dst[0]); g.py.to(dst[1]); g.glide = to
  } else { // destination is off the projected sphere: fall back to degrees
    g.sx.set(1, 0.7); g.sy.set(1, 0.7)
    let lon = to[0]; const cur = g.sx.x           // take the short way round
    while (lon - cur > 180) lon -= 360; while (lon - cur < -180) lon += 360
    g.sx.to(lon); g.sy.to(to[1])
  }
  kick()
  return new Promise(res => { g.settled = res })
}

// ------------------------------------------------------------------ animation loop (springs)
let animating = false, lastT = 0
function kick() { if (!animating) { animating = true; lastT = performance.now(); requestAnimationFrame(tick) } }
function tick(t: number) {
  const dt = Math.min(0.25, Math.max(0, (t - lastT) / 1000)); lastT = t
  const n = Math.max(1, Math.ceil(dt / (1 / 60))), h = dt / n // sub-step so a slow frame still advances real time
  let busy = false
  for (const g of ghosts) {
    for (let i = 0; i < n; i++) g.lift.step(h, 2e-3)
    if (g.glide && g.px && g.py) { // travelling: springs live in screen pixels
      const t = projection(g.glide)
      if (t && (Math.abs(t[0] - g.px.target) > 0.5 || Math.abs(t[1] - g.py.target) > 0.5)) { g.px.to(t[0]); g.py.to(t[1]) }
      for (let i = 0; i < n; i++) { g.px.step(h, 0.15); g.py.step(h, 0.15) }
      const ll = invert([g.px.x, g.py.x])
      if (ll) setAnchor(g, ll)
      if (g.px.done && g.py.done) {
        g.glide = undefined
        g.sx.jump(g.anchor[0]); g.sy.jump(g.anchor[1])
        pushHash(); g.settled?.(); g.settled = undefined
      } else busy = true
      continue
    }
    const moving = !g.sx.done || !g.sy.done
    for (let i = 0; i < n; i++) { g.sx.step(h, 5e-3); g.sy.step(h, 5e-3) }
    if (moving) {
      setAnchor(g, [g.sx.x, g.sy.x])
      if (g.sx.done && g.sy.done) { pushHash(); g.settled?.(); g.settled = undefined }
    }
    if (!g.sx.done || !g.sy.done || !g.lift.done) busy = true
  }
  requestDraw()
  if (busy) requestAnimationFrame(tick); else animating = false
}

// ------------------------------------------------------------------ drawing
function requestDraw() { if (!frame) frame = requestAnimationFrame(draw) }
const stats: Record<string, number> = {}
const mark = (k: string, t0: number) => { stats[k] = (stats[k] ?? 0) * 0.5 + (performance.now() - t0) * 0.5 }
/** Mercator wraps: the x-offsets (in px) of every copy of the world that touches the viewport. */
function worldWidth(): number { const a = projection([-180, 0]), b = projection([180, 0]); return a && b ? b[0] - a[0] : 2 * Math.PI * projection.scale() }
function worldCopies(): number[] {
  if (projName !== 'mercator') return [0] // Equal Earth is shown whole, no wrapping
  const w = worldWidth()
  const tx = projection.translate()[0]
  const out: number[] = []
  const n0 = Math.floor((0 - tx - w / 2) / w), n1 = Math.ceil((width - tx + w / 2) / w)
  for (let n = n0; n <= n1; n++) { const l = tx + n * w - w / 2, r = tx + n * w + w / 2; if (r > 0 && l < width) out.push(n * w) }
  return out.length ? out : [0]
}
/** Run `fn` once per visible copy of the world with the projection shifted to it. */
function eachCopy(fn: (dx: number) => void) {
  const [tx, ty] = projection.translate()
  for (const dx of worldCopies()) { projection.translate([tx + dx, ty]); fn(dx) }
  projection.translate([tx, ty])
}

// The base map (sphere, graticule, land, borders) costs ~130 ms to project at desktop size, so it is
// rendered once to an offscreen canvas and blitted; ghosts and highlights draw on top every frame.
// While zooming, the cached bitmap is shown re-scaled as a preview and re-rendered once the gesture pauses.
let base: HTMLCanvasElement | null = null, baseT: ZoomTransform | null = null, baseKey = '', baseTimer = 0
const baseKeyNow = () => [projName, currentLevel(), isLight() ? 'l' : 'd', width, height, dpr].join('|')
let citiesLoaded = 0 // bumps when a city boundary arrives, so the cached base re-renders
let morphing = false
let zooming = false // a pan/zoom gesture is in progress: cheap frames only
let liteLand: PolyFeature[] | null = null
function renderBase() {
  if (!base) base = document.createElement('canvas')
  // animation frames: coarse outlines at 1× pixel density; everything else full detail at device density
  const lite = (morphing || zooming) && !!liteLand
  const d = lite ? 1 : dpr
  if (base.width !== width * d || base.height !== height * d) { base.width = width * d; base.height = height * d }
  const bc = base.getContext('2d')!
  const path = geoPath(projection, bc)
  bc.setTransform(d, 0, 0, d, 0, 0)
  bc.clearRect(0, 0, width, height)
  const level = currentLevel()
  visibleCities = []
  eachCopy(() => {
    bc.beginPath(); path(sphere); bc.fillStyle = pal.ocean; bc.fill()
    if (!morphing) { bc.beginPath(); path(graticule); bc.strokeStyle = pal.grid; bc.lineWidth = 0.6; bc.stroke() }
    if (lite) { // one pass: coarse land fill + outline, nothing else
      bc.beginPath(); for (const f of liteLand!) path(f)
      bc.fillStyle = pal.land; bc.fill(); bc.strokeStyle = pal.border; bc.lineWidth = 0.7; bc.stroke()
      return
    }
    bc.beginPath(); for (const f of world.land) path(f)
    bc.fillStyle = pal.land; bc.fill()
    const borders = level === 'continent' ? world.continents : world.countries
    bc.beginPath(); for (const p of borders) if (p.id !== 'US-AK' && p.feature) path(p.feature)
    bc.strokeStyle = level === 'continent' ? pal.borderStrong : pal.border
    bc.lineWidth = level === 'continent' ? 0.9 : 0.6; bc.lineJoin = 'round'; bc.stroke()
    if (morphing) return // names, cities and fine lines wait for the final frame
    if (level === 'continent') {
      bc.beginPath(); for (const p of world.countries) if (p.id !== 'US-AK' && p.feature) path(p.feature)
      bc.strokeStyle = pal.borderFaint; bc.lineWidth = 0.5; bc.stroke()
    }
    drawNames(bc)
    if (projName === 'equalearth') { bc.beginPath(); path(sphere); bc.strokeStyle = pal.outline; bc.lineWidth = 1; bc.stroke() }
  })
  baseT = transform; baseKey = baseKeyNow() + '|' + citiesLoaded + (lite ? '|lite' : '')
}

// Place names, Google-Maps style: always on, sized by zoom, a country is named only once it is wide
// enough on screen to carry its own name, bigger places win collisions.
const UI_FONT = '-apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", Roboto, sans-serif'
let countriesByArea: Place[] = []
function drawNames(bc: CanvasRenderingContext2D) {
  const k = transform.k
  const path = geoPath(projection, bc)
  const placed: [number, number, number, number][] = []
  const fits = (r: [number, number, number, number]) => !placed.some(o => r[0] < o[2] && r[2] > o[0] && r[1] < o[3] && r[3] > o[1])
  const onScreen = (x: number, y: number) => x > 0 && x < width && y > insetTop && y < height - insetBottom
  bc.textAlign = 'center'; bc.textBaseline = 'middle'; bc.lineJoin = 'round'
  const halo = (t: string, x: number, y: number, w: number) => { bc.lineWidth = w; bc.strokeStyle = pal.halo; bc.strokeText(t, x, y) }
  const ls = bc as CanvasRenderingContext2D & { letterSpacing?: string }

  if (k < 3.2) { // continents: quiet uppercase, fading out as you zoom in
    const fs = Math.round(Math.min(18, 12 + 3 * Math.log2(Math.max(1, width / 600))))
    bc.font = `600 ${fs}px ${UI_FONT}`
    if ('letterSpacing' in ls) ls.letterSpacing = '0.14em'
    for (const c of world.continents) {
      const xy = projection(c.label); if (!xy || !onScreen(xy[0], xy[1])) continue
      const t = c.name.toUpperCase(); const tw = bc.measureText(t).width
      const r: [number, number, number, number] = [xy[0] - tw / 2 - 4, xy[1] - fs, xy[0] + tw / 2 + 4, xy[1] + fs]
      if (!fits(r)) continue
      bc.fillStyle = pal.labelDim; halo(t, xy[0], xy[1], 3); bc.fillText(t, xy[0], xy[1]); placed.push(r)
    }
    if ('letterSpacing' in ls) ls.letterSpacing = '0px'
  }

  const fs = Math.min(15, 10.5 + 1.6 * Math.log2(k))
  bc.font = `500 ${fs}px ${UI_FONT}`
  bc.fillStyle = pal.label
  for (const p of countriesByArea) {
    if (p.id === 'US-AK') continue
    if (p.areaKm2 * k * k < 12000) continue // scattered island groups have wide boxes but no room for a name
    const xy = projection(p.label); if (!xy || !onScreen(xy[0], xy[1])) continue
    // how much room does the country take on screen right now?
    let bw: number, bh: number
    if (p.bounds.wraps) { if (p.areaKm2 < 1e6) continue; bw = width; bh = height }
    else {
      const a = projection([p.bounds.minLon, p.bounds.minLat]), b = projection([p.bounds.maxLon, p.bounds.maxLat])
      if (!a || !b) continue
      bw = Math.abs(b[0] - a[0]); bh = Math.abs(b[1] - a[1])
    }
    const tw = bc.measureText(p.name).width
    if (bw < tw * 0.85 || bh < fs * 1.2) continue // not wide enough to carry its name yet
    const r: [number, number, number, number] = [xy[0] - tw / 2 - 3, xy[1] - fs * 0.7, xy[0] + tw / 2 + 3, xy[1] + fs * 0.7]
    if (!fits(r)) continue
    halo(p.name, xy[0], xy[1], 3); bc.fillText(p.name, xy[0], xy[1]); placed.push(r)
  }

  // cities: names from mid-zoom (population-gated), real boundaries once zoomed in far enough (fetched lazily)
  if (k >= CITY_NAMES_FROM && world.cities.length) {
    const level = currentLevel()
    const minPop = level === 'city' ? 2.5e6 / (k * k) : 6e6 / (k * k)
    const cfs = Math.min(13, 10 + 0.8 * Math.log2(k))
    const wantBorders = k >= CITY_BORDERS_FROM
    let loads = 0
    for (const c of world.cities) {
      if ((c.pop ?? 0) < minPop && !(c.capital && k >= 3)) continue
      const xy = projection(c.centroid); if (!xy || !onScreen(xy[0], xy[1])) continue
      const [x, y] = xy
      if (wantBorders) {
        if (c.feature) {
          bc.beginPath(); path(c.feature)
          bc.fillStyle = pal.cityFill; bc.fill()
          bc.strokeStyle = pal.cityLine; bc.lineWidth = level === 'city' ? 1.1 : 0.8; bc.stroke()
        } else if (loads < 12) { loads++; requestCity(c) }
      }
      bc.font = `${level === 'city' ? 600 : 400} ${cfs}px ${UI_FONT}`
      const tw = bc.measureText(c.name).width
      const r: [number, number, number, number] = [x - tw / 2 - 3, y - cfs * 0.7, x + tw / 2 + 3, y + cfs * 0.7]
      visibleCities.push({ c, x, y })
      if (!fits(r)) continue
      bc.fillStyle = level === 'city' ? pal.label : pal.labelDim
      halo(c.name, x, y, 3); bc.fillText(c.name, x, y); placed.push(r)
    }
  }
}

// lazy boundary loading for cities that are on screen at border zoom; re-render the base once a batch lands
const cityRequested = new Set<string>()
let cityRedraw = 0
function requestCity(c: Place) {
  if (cityRequested.has(c.id)) return
  cityRequested.add(c.id)
  loadCity(c).then(() => {
    citiesLoaded++
    if (!cityRedraw) cityRedraw = window.setTimeout(() => { cityRedraw = 0; requestDraw() }, 120)
  }).catch(() => { /* no boundary: the name still shows */ })
}
function draw() {
  frame = 0
  if (!world) return
  const T0 = performance.now()
  applyTransform()
  const path = geoPath(projection, ctx)
  ctx.save(); ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, width, height)

  const sameT = !!baseT && baseT.k === transform.k && baseT.x === transform.x && baseT.y === transform.y
  const keyNow = baseKeyNow() + '|' + citiesLoaded
  if (!base || (sameT && baseKey !== keyNow && !zooming)) renderBase() // first paint, or theme/level flip: instant
  else if (!sameT || baseKey !== keyNow) {
    if (liteLand) { zooming = true; renderBase() } // cheap coarse frame that tracks the gesture exactly
    clearTimeout(baseTimer)
    baseTimer = window.setTimeout(() => { baseTimer = 0; zooming = false; renderBase(); requestDraw() }, 160) // full detail once the gesture pauses
  }
  if (baseT && !(baseT.k === transform.k && baseT.x === transform.x && baseT.y === transform.y)) {
    // preview: re-scale the cached bitmap into the new transform
    const s = transform.k / baseT.k
    ctx.save(); ctx.fillStyle = pal.ocean
    ctx.translate(transform.x - s * baseT.x, transform.y - s * baseT.y); ctx.scale(s, s)
    ctx.drawImage(base!, 0, 0, base!.width, base!.height, 0, 0, width, height); ctx.restore()
  } else ctx.drawImage(base!, 0, 0, base!.width, base!.height, 0, 0, width, height)
  mark('base', T0)
  const T1 = performance.now()
  eachCopy(() => {
  // press (instant, on pointer-down) and hover feedback
  const hl = pressPlace ?? hoverPlace
  if (hl) {
    ctx.beginPath(); path(hl.feature!)
    ctx.fillStyle = pressPlace ? 'rgba(232,163,61,0.28)' : pal.hover; ctx.fill()
    ctx.strokeStyle = pressPlace ? pal.accent : pal.hoverLine; ctx.lineWidth = 1; ctx.stroke()
  }
  // where each ghost came from
  for (const g of ghosts) { ctx.beginPath(); path(g.place.feature!); ctx.setLineDash([3, 3]); ctx.strokeStyle = g.color + '99'; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]) }
  // ghosts: lift → shadow + brightness, so a lifted shape reads as floating above the map
  for (const g of ghosts) {
    // lift → a cheap two-layer drop shadow (canvas shadowBlur on a continent-sized path costs ~500 ms/frame)
    const L = Math.max(0, g.lift.x)
    if (L > 0.02) {
      const sh = isLight() ? 0.22 : 0.45
      for (const [dy, a] of [[4 * L, sh * 0.6], [9 * L, sh * 0.35]] as [number, number][]) {
        ctx.save(); ctx.translate(0, dy)
        ctx.beginPath(); path(g.feature); ctx.fillStyle = `rgba(0,0,0,${a.toFixed(3)})`; ctx.fill()
        ctx.restore()
      }
    }
    ctx.beginPath(); path(g.feature)
    ctx.fillStyle = g.color + (g === selected ? 'B3' : '8C'); ctx.fill()
    ctx.beginPath(); path(g.feature)
    ctx.strokeStyle = g.color; ctx.lineWidth = g === selected ? 2 : 1.4; ctx.stroke()
  }
  })
  ctx.restore()
  mark('ghosts', T1)
  const T2 = performance.now()
  drawLabels()
  mark('labels', T2)
  mark('total', T0)
  syncLevelUI()
  $('#reset').hidden = Math.abs(transform.k - 1) < 1e-6 && Math.abs(transform.x) < 0.5 && Math.abs(transform.y) < 0.5 && ghosts.length === 0
}

// Labels are built from Natural Earth names (static, shipped with the site) and always pass through esc().
// Nodes are reused and moved with a compositor-friendly transform; their width is measured only when the text
// changes, so a travelling shape costs no layout per frame.
const labelNodes = new Map<number, { el: HTMLElement; html: string; w: number }>()
function drawLabels() {
  const live = new Set<number>()
  for (const g of ghosts) {
    const xy = projection(g.anchor)
    if (!xy) continue
    let [x, y] = xy
    { // pick the copy of the world that is on screen
      const w = worldWidth()
      while (x < 0 && x + w < width + 40) x += w
      while (x > width && x - w > -40) x -= w
    }
    if (x < -40 || x > width + 40 || y < insetTop + 30 || y > height - insetBottom) continue
    const u = under(g)
    const ratio = u ? fmtRatio(g.place.areaKm2, u.areaKm2) : null
    const over = u ? `<span class="r"><strong>${ratio!.short}</strong> ${ratio!.short.endsWith('%') ? 'of' : 'the size of'} ${esc(u.name)}</span>` : `<span class="r">${fmtKm2(g.place.areaKm2)}</span>`
    const def = g.place.level === 'city' ? ` <span class="r">· ${esc(g.place.def)}</span>` : ''
    const html = `<b>${esc(g.place.name)}</b>${def} · ${over}`
    let node = labelNodes.get(g.key)
    if (!node) {
      const el = document.createElement('div')
      el.className = 'label'; el.dataset.key = String(g.key)
      labelsEl.appendChild(el)
      node = { el, html: '', w: 0 }
      labelNodes.set(g.key, node)
    }
    if (node.html !== html) { // the only branch that touches the DOM or forces layout
      node.el.innerHTML = html
      node.html = html
      node.w = node.el.offsetWidth
    }
    node.el.style.setProperty('--c', g.color)
    node.el.style.zIndex = String(ghosts.indexOf(g) + 1) // overlapping pills stack in the same order as their shapes
    const min = node.w / 2 + 6, max = width - node.w / 2 - 6 // keep the pill on screen
    const cx = Math.max(min, Math.min(max, x))
    node.el.style.transform = `translate3d(${cx.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`
    live.add(g.key)
  }
  for (const [key, node] of labelNodes) if (!live.has(key)) { node.el.remove(); labelNodes.delete(key) }
  if (selected) { const before = lastCompareKey; fillCompare(selected); if (lastCompareKey !== before) syncSheetHeight() }
}
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

// ------------------------------------------------------------------ compare sheet
function showCompare(g: Ghost) { selected = g; compareEl.hidden = false; lastCompareKey = ''; fillCompare(g); syncSheetHeight() }
function hideCompare() { compareEl.hidden = true; selected = null; syncSheetHeight() }
function syncSheetHeight() { app.style.setProperty('--sheet-h', compareEl.hidden ? '0px' : compareEl.offsetHeight + 10 + 'px') }
let lastCompareKey = ''
function fillCompare(g: Ghost) {
  const u = under(g)
  const key = g.key + '|' + (u?.id ?? (transform.k >= CITY_BORDERS_FROM ? 'c' : '') + (placeAtPoint(g.anchor, g.place.level === 'continent' ? 'continent' : 'country')?.id ?? '-'))
  if (key === lastCompareKey) return
  lastCompareKey = key
  $('#cmp-a-name').textContent = g.place.name
  $('#cmp-a-def').textContent = g.place.def + ((g.place.water ?? 0) >= 5 ? ' · land only' : '')
  $('#cmp-a-area').textContent = fmtKm2(g.place.areaKm2)
  if (u) {
    const r = fmtRatio(g.place.areaKm2, u.areaKm2)
    $('#cmp-b-name').textContent = u.name; $('#cmp-b-def').textContent = u.def; $('#cmp-b-area').textContent = fmtKm2(u.areaKm2)
    $('#cmp-ratio').textContent = r.short
    const inv = fmtRatio(u.areaKm2, g.place.areaKm2)
    $('#cmp-sentence').innerHTML = g.place.areaKm2 < u.areaKm2
      ? `<strong>${esc(g.place.name)}</strong> would cover <strong>${r.pct}</strong> of ${esc(u.name)}. ${esc(u.name)} is <strong>${inv.times}</strong> bigger.`
      : `<strong>${esc(g.place.name)}</strong> is <strong>${r.times}</strong> the size of ${esc(u.name)}. ${esc(u.name)} would cover <strong>${inv.pct}</strong> of it.`
  } else {
    const lvl: Level = g.place.level === 'continent' ? 'continent' : currentLevel() === 'continent' ? 'continent' : 'country'
    const home = placeAtPoint(g.anchor, lvl) ?? (transform.k >= CITY_BORDERS_FROM ? placeAtPoint(g.anchor, 'city') : null)
    if (home) { // sitting on itself (or its namesake, e.g. Singapore the city on Singapore the country)
      $('#cmp-b-name').textContent = 'Home'; $('#cmp-b-def').textContent = 'its own footprint'; $('#cmp-b-area').textContent = ''
      $('#cmp-ratio').textContent = '1×'
      $('#cmp-sentence').innerHTML = `<strong>${esc(g.place.name)}</strong> is where it belongs. Drag it onto another place to compare.`
    } else {
      $('#cmp-b-name').textContent = 'Open water'; $('#cmp-b-def').textContent = 'drag over a place to compare'; $('#cmp-b-area').textContent = ''
      $('#cmp-ratio').textContent = '·'
      $('#cmp-sentence').innerHTML = `<strong>${esc(g.place.name)}</strong> keeps its true area wherever you put it. On Mercator it only <em>looks</em> different.`
    }
  }
}
$('#compare-close').addEventListener('click', hideCompare)
$('#cmp-remove').addEventListener('click', () => { if (selected) removeGhost(selected) })

// ------------------------------------------------------------------ interactions
interface Drag { g: Ghost; startGeo: LonLat; startAnchor: LonLat; raw: LonLat; moved: boolean }
let drag: Drag | null = null
let pressXY: [number, number] | null = null

function setupZoom() {
  zoomBehavior = d3zoom<HTMLCanvasElement, unknown>()
    .scaleExtent([1, MAX_ZOOM])
    // north/south: never pan past the map's top or bottom edge; east/west stays endless (the world wraps)
    .constrain((t) => {
      const visTop = insetTop, visBot = height - insetBottom
      const top = t.k * worldY[0] + t.y, bot = t.k * worldY[1] + t.y
      let y = t.y
      if (bot - top <= visBot - visTop) y = (visTop + visBot) / 2 - t.k * (worldY[0] + worldY[1]) / 2 // world shorter than the view: centre it
      else if (top > visTop) y = visTop - t.k * worldY[0]
      else if (bot < visBot) y = visBot - t.k * worldY[1]
      return y === t.y ? t : zoomIdentity.translate(t.x, y).scale(t.k)
    })
    .filter((ev: Event) => {
      const e = ev as PointerEvent | WheelEvent | TouchEvent
      if ('touches' in e && e.touches.length > 1) return true // pinch always zooms
      if (e.type === 'wheel') return true
      if ((e as MouseEvent).button && (e as MouseEvent).button !== 0) return false
      // d3-zoom sees raw touch events on phones: read the finger's position from touches[0], not clientX
      const src = ('touches' in e && e.touches.length ? e.touches[0] : e) as { clientX: number; clientY: number }
      const r = canvas.getBoundingClientRect()
      const geo = invert([src.clientX - r.left, src.clientY - r.top])
      return !(geo && ghostAtPoint(geo)) // a press that starts on a ghost is a drag, not a pan
    })
    .on('start', (ev) => { if (ev.sourceEvent) { cancelAnimationFrame(zoomAnim); zoomDone?.(); zoomDone = null } })
    .on('zoom', (ev) => {
      transform = ev.transform
      const band = bandFor(transform.k)
      if (ev.sourceEvent) { if (levelOverride && band !== overrideBand) levelOverride = null } // the user zoomed into another band: follow the zoom
      else overrideBand = band // programmatic camera moves keep the chosen level
      requestDraw()
    })
  select(canvas).call(zoomBehavior).on('dblclick.zoom', null)
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !e.isPrimary) return
  const xy: [number, number] = [e.offsetX, e.offsetY]
  const geo = invert(xy); if (!geo) return
  const g = ghostAtPoint(geo)
  if (!g) {
    // instant press feedback on the place under the finger; a pan will cancel it
    pressPlace = placeAtPoint(geo, currentLevel()); pressXY = xy
    if (pressPlace) requestDraw()
    return
  }
  // grab: start from the live value, cancel any motion in flight
  g.glide = undefined // interrupt any travel and continue from where it is right now
  g.sx.jump(g.anchor[0]); g.sy.jump(g.anchor[1]); g.settled?.(); g.settled = undefined
  drag = { g, startGeo: geo, startAnchor: g.anchor.slice() as LonLat, raw: g.anchor.slice() as LonLat, moved: false }
  if (!reducedMotion()) { g.lift.set(1, 0.3); g.lift.to(1.35); kick() }
  canvas.setPointerCapture(e.pointerId); canvas.classList.add('dragging')
  ghosts = [...ghosts.filter(x => x !== g), g] // bring to front
  e.stopPropagation()
})
canvas.addEventListener('pointermove', (e) => {
  const xy: [number, number] = [e.offsetX, e.offsetY]
  if (drag) {
    const geo = invert(xy); if (!geo) return
    let dLon = geo[0] - drag.startGeo[0]
    if (dLon > 180) dLon -= 360; if (dLon < -180) dLon += 360
    const dLat = geo[1] - drag.startGeo[1]
    if (Math.abs(dLon) + Math.abs(dLat) > 0.05) drag.moved = true
    const raw: LonLat = [drag.startAnchor[0] + dLon, drag.startAnchor[1] + dLat]
    drag.raw = raw
    // rubber-band at the polar edge instead of a hard stop
    const cap = maxLat()
    const lat = raw[1] > cap ? cap + rubberband(raw[1] - cap, 6) : raw[1] < -cap ? -cap + rubberband(raw[1] + cap, 6) : raw[1]
    drag.g.sx.jump(raw[0]); drag.g.sy.jump(lat)
    setAnchor(drag.g, [raw[0], lat])
    requestDraw(); return
  }
  if (pressPlace && pressXY && Math.hypot(xy[0] - pressXY[0], xy[1] - pressXY[1]) > 6) { pressPlace = null; requestDraw() } // it's a pan
  if (e.pointerType === 'mouse') {
    if (frame) return // a draw is already queued this frame; the next move will re-test
    const geo = invert(xy)
    const overDot = !!cityAtPixel(xy)
    const p = geo && !ghostAtPoint(geo) && !overDot ? placeAtPoint(geo, currentLevel()) : null
    if (p !== hoverPlace) { hoverPlace = p; requestDraw() }
    canvas.style.cursor = p || overDot ? 'pointer' : 'grab'
  }
})
function endDrag(e: PointerEvent) {
  pressPlace = null; pressXY = null
  if (!drag) return
  const d = drag; drag = null
  canvas.classList.remove('dragging')
  try { canvas.releasePointerCapture(e.pointerId) } catch { /* noop */ }
  const g = d.g
  if (!reducedMotion()) { g.lift.set(1, 0.35); g.lift.to(1); kick() }
  if (!d.moved) { if (selected === g && !compareEl.hidden) hideCompare(); else showCompare(g); requestDraw(); return }

  // No momentum: this is a measuring tool, so a shape lands exactly where it was released. The only motion
  // left is settling back inside the poles after a rubber-band stretch.
  const cap = maxLat()
  const targetLat = Math.max(-cap, Math.min(cap, d.raw[1]))
  if (Math.abs(targetLat - g.anchor[1]) > 1e-6 || Math.abs(d.raw[0] - g.anchor[0]) > 1e-6) {
    g.sx.set(1, 0.3); g.sy.set(1, 0.3)
    g.sx.jump(g.anchor[0]); g.sy.jump(g.anchor[1])
    g.sx.to(d.raw[0]); g.sy.to(targetLat); kick()
  } else pushHash()
  if (selected === g) fillCompare(g)
  requestDraw()
}
canvas.addEventListener('pointerup', endDrag)
canvas.addEventListener('pointercancel', endDrag)
canvas.addEventListener('pointerleave', () => { if (hoverPlace) { hoverPlace = null; requestDraw() } })

// tap on the base map (d3-zoom swallows clicks that panned)
canvas.addEventListener('click', (e) => {
  if (drag) return
  const geo = invert([e.offsetX, e.offsetY]); if (!geo) return
  if (ghostAtPoint(geo)) return // handled by pointerup
  if (currentLevel() === 'city') {
    const inside = placeAtPoint(geo, 'city') ?? cityAtPixel([e.offsetX, e.offsetY])
    if (inside) { void liftPlace(inside); return }
    const country = placeAtPoint(geo, 'country') // no city here: fall back to the country under the finger
    if (country) { addGhost(country); hintEl.classList.add('off') } else hideCompare()
    return
  }
  const city = cityAtPixel([e.offsetX, e.offsetY], 10)
  if (city) { void liftPlace(city); return }
  const p = placeAtPoint(geo, currentLevel())
  if (p) { addGhost(p); hintEl.classList.add('off') } else hideCompare()
})
labelsEl.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('.label'); if (!el) return
  const g = ghosts.find(x => x.key === Number(el.dataset.key)); if (g) showCompare(g)
})

// ------------------------------------------------------------------ UI: projection, level, presets, search, share
document.querySelectorAll<HTMLButtonElement>('[data-proj]').forEach(b => b.addEventListener('click', () => setProjection(b.dataset.proj as ProjName)))
function setProjection(p: ProjName, animate = true) {
  if (p === projName || morphing) return
  const from = projName
  projName = p
  document.querySelectorAll<HTMLButtonElement>('[data-proj]').forEach(x => { const on = x.dataset.proj === p; x.classList.toggle('on', on); x.setAttribute('aria-checked', String(on)) })
  if (!animate || reducedMotion() || !world) {
    transform = zoomIdentity; select(canvas).call(zoomBehavior.transform, zoomIdentity)
    projection = makeProjection()
    for (const g of ghosts) setAnchor(g, g.anchor)
    requestDraw(); pushHash(); return
  }
  morphProjection(from, p)
  pushHash()
}

/** The transform that puts `center` in the middle of the visible band at zoom k, for the current base projection. */
function viewTransform(k: number, center: LonLat): ZoomTransform {
  const visH = height - insetTop - insetBottom
  const savedT = projection.translate(), savedS = projection.scale()
  projection.scale(baseScale).translate(baseTranslate) // base coords (k = 1)
  const b = projection(center) ?? [baseTranslate[0], baseTranslate[1]]
  projection.scale(savedS).translate(savedT)
  return zoomIdentity.translate(width / 2 - k * b[0], insetTop + visH / 2 - k * b[1]).scale(k)
}

/** Blend the two projections' raw formulas over ~1s so the map visibly stretches/relaxes into the new shape. */
function morphProjection(from: ProjName, to: ProjName) {
  const A = projectionFor(from), B = projectionFor(to)
  const s0 = A.scale(), s1 = B.scale(), t0 = A.translate(), t1 = B.translate()
  const rawOf = (n: ProjName) => n === 'mercator'
    ? (λ: number, φ: number) => geoMercatorRaw(λ, Math.max(-1.4835, Math.min(1.4835, φ))) // clamp at ±85° like the clipped square
    : (λ: number, φ: number) => geoEqualEarthRaw(λ, φ)
  const ra = rawOf(from), rb = rawOf(to)
  const T0 = performance.now(), ms = 1100
  const maxLatEnd = to === 'mercator' ? 82 : 89
  // keep what the user is looking at: same zoom, same centre, through the whole blend
  const k = transform.k
  const visH = height - insetTop - insetBottom
  const center: LonLat = invert([width / 2, insetTop + visH / 2]) ?? [10, 12]
  morphing = true
  const frame = (u: number) => {
    const raw = (λ: number, φ: number) => { const a = ra(λ, φ), b = rb(λ, φ); return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u] as [number, number] }
    const pr = geoProjection(raw).scale(s0 + (s1 - s0) * u).translate([t0[0] + (t1[0] - t0[0]) * u, t0[1] + (t1[1] - t0[1]) * u]).precision(1)
    projection = pr
    baseScale = pr.scale(); baseTranslate = pr.translate() as [number, number]
    transform = viewTransform(k, center)
    for (const g of ghosts) { g.anchor[1] = Math.max(-maxLatEnd, Math.min(maxLatEnd, g.anchor[1])); setAnchor(g, g.anchor) }
    baseKey = '' // force a (lite) base render this frame
    draw()
  }
  const finish = () => {
    morphing = false; projection = makeProjection(); baseKey = ''
    select(canvas).call(zoomBehavior.transform, viewTransform(k, center)) // hand the final view back to d3-zoom
    requestDraw()
  }
  morphDebug = { frame, finish }
  const step = (now: number) => {
    const u = easeCubicInOut(Math.min(1, (now - T0) / ms))
    frame(u)
    if (u < 1) requestAnimationFrame(step); else finish()
  }
  requestAnimationFrame(step)
}
let morphDebug: { frame: (u: number) => void; finish: () => void } | null = null
document.querySelectorAll<HTMLButtonElement>('[data-level]').forEach(b => b.addEventListener('click', () => { if (!b.disabled) setLevel(b.dataset.level as Level) }))
$('#reset').addEventListener('click', () => { clearGhosts(); animateZoom(zoomIdentity, 500) })
$('#clear').addEventListener('click', clearGhosts)

// presets per level; each one moves the camera first, then lifts and glides
interface Preset { src: string; dst: string; label: string }
const PRESETS: Record<Level, Preset[]> = {
  continent: [
    { src: 'GRL', dst: 'AF', label: 'Greenland → Africa' },
    { src: 'EU', dst: 'AF', label: 'Europe → Africa' },
    { src: 'AN', dst: 'AF', label: 'Antarctica → Africa' },
    { src: 'OC', dst: 'EU', label: 'Oceania → Europe' },
  ],
  country: [
    { src: 'US-AK', dst: 'MEX', label: 'Alaska → Mexico' },
    { src: 'GRL', dst: 'COD', label: 'Greenland → DR Congo' },
    { src: 'AUS', dst: 'USA', label: 'Australia → USA' },
    { src: 'IND', dst: 'ARG', label: 'India → Argentina' },
    { src: 'JPN', dst: 'MDG', label: 'Japan → Madagascar' },
  ],
  city: [
    { src: 'Q60', dst: 'Q1490', label: 'New York → Tokyo' },
    { src: 'Q84', dst: 'Q3630', label: 'London → Jakarta' },
    { src: 'Q8686', dst: 'Q334', label: 'Shanghai → Singapore' },
    { src: 'Q1489', dst: 'Q1156', label: 'Mexico City → Mumbai' },
  ],
}
const presetsEl = $('#presets')
let presetsLevel: Level | null = null
function renderPresets() {
  const level = currentLevel()
  if (level === presetsLevel) return
  presetsLevel = level
  presetsEl.innerHTML = PRESETS[level]
    .filter(p => world.byId.has(p.src) && world.byId.has(p.dst))
    .map((p, i) => `<button class="chip" data-preset="${i}">${esc(p.label)}</button>`).join('')
}
let presetSeq = 0
const withTimeout = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<void>(r => setTimeout(r, ms))])
presetsEl.addEventListener('click', async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-preset]'); if (!b) return
  const p = PRESETS[presetsLevel ?? currentLevel()][Number(b.dataset.preset)]; if (!p) return
  const src = world.byId.get(p.src)!, dst = world.byId.get(p.dst)!
  const seq = ++presetSeq // a newer click cancels this run at the next step
  const live = () => seq === presetSeq
  presetsEl.querySelectorAll('.busy').forEach(x => x.classList.remove('busy')); b.classList.add('busy')
  try {
    clearGhosts(); hideCompare(); hintEl.classList.add('off')
    const level = presetsLevel ?? currentLevel()
    if (level === 'city') await withTimeout(Promise.all([loadCity(src), loadCity(dst)]), 6000)
    if (!live()) return
    setLevel(level)
    // One story every time: frame both places, lift the shape where it lives, then fly it to the destination.
    // (Greenland's label point sits under the header at the default view, so "is the source on screen?" is
    // decided after the camera has framed the pair — never by skipping the flight.)
    const camera = level === 'city' ? viewFor(dst, 0.3) : viewForPair(src, dst)
    const framed = onScreenPt(screenPos(src.label), 24) && onScreenPt(screenPos(dst.label), 24)
    const needMove = !framed || (level === 'city' && transform.k < CITY_BORDERS_FROM)
    if (needMove) { await withTimeout(animateZoom(camera, 700), 2000); if (!live()) return }
    const g = addGhost(src, src.label)
    await new Promise(r => setTimeout(r, reducedMotion() ? 0 : 200)) // a beat, so the origin registers
    if (!live()) return
    await withTimeout(glideTo(g, dst.label), 4000)
    if (live() && ghosts.includes(g)) showCompare(g)
  } catch { toast('Could not load that comparison') }
  finally { if (live()) b.classList.remove('busy') }
})

// search
const searchEl = $<HTMLInputElement>('#search'), resultsEl = $<HTMLUListElement>('#results')
let results: Place[] = [], selIdx = -1
searchEl.addEventListener('input', () => {
  results = searchPlaces(world, searchEl.value); selIdx = -1
  if (!searchEl.value.trim()) { resultsEl.hidden = true; return }
  resultsEl.innerHTML = results.length
    ? results.map((p, i) => `<li data-i="${i}"><span>${esc(p.name)}</span><span class="tag">${p.level === 'city' ? 'city · ' + esc(p.country ?? '') : p.level}</span></li>`).join('')
    : `<li class="none">No match</li>`
  resultsEl.hidden = false
})
searchEl.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { selIdx = Math.min(results.length - 1, selIdx + 1); e.preventDefault() }
  else if (e.key === 'ArrowUp') { selIdx = Math.max(0, selIdx - 1); e.preventDefault() }
  else if (e.key === 'Enter') { pickResult(selIdx >= 0 ? selIdx : 0); return }
  else if (e.key === 'Escape') { resultsEl.hidden = true; searchEl.blur(); return }
  resultsEl.querySelectorAll('li').forEach((li, i) => li.classList.toggle('sel', i === selIdx))
})
resultsEl.addEventListener('pointerdown', (e) => { const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-i]'); if (li) { e.preventDefault(); pickResult(Number(li.dataset.i)) } })
document.addEventListener('pointerdown', (e) => { if (!(e.target as HTMLElement).closest('.search')) resultsEl.hidden = true })
function pickResult(i: number) {
  const p = results[i]; if (!p) return
  resultsEl.hidden = true; searchEl.value = ''; searchEl.blur()
  setLevel(p.level)
  void liftPlace(p).then(g => { if (g) showCompare(g) })
}

// share
$('#share').addEventListener('click', async () => {
  pushHash()
  const url = location.href
  try { await navigator.clipboard.writeText(url); toast('Link copied — it opens on this exact view') }
  catch { prompt('Copy this link', url) }
})

// theme
$('#theme').addEventListener('click', () => setTheme(isLight() ? 'dark' : 'light'))
matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) => {
  if (document.documentElement.dataset.theme) return // explicit choice wins
  document.documentElement.classList.toggle('system-light', e.matches); readPalette(); requestDraw()
})

// why: a modal, shown on the first visit and on demand
const whyEl = $('#why')
function openWhy() { whyEl.hidden = false; $('#why-btn').setAttribute('aria-expanded', 'true'); $('#why-close').focus() }
function closeWhy() { whyEl.hidden = true; $('#why-btn').setAttribute('aria-expanded', 'false'); try { localStorage.setItem('seenWhy', '1') } catch { /* private mode */ } }
$('#why-btn').addEventListener('click', openWhy)
$('#why-close').addEventListener('click', closeWhy)
$('#why-skip').addEventListener('click', closeWhy)
$('#why-try').addEventListener('click', () => { closeWhy(); setLevel('continent'); renderPresets(); presetsEl.querySelector<HTMLButtonElement>('[data-preset="0"]')?.click() })
whyEl.addEventListener('click', (e) => { if (e.target === whyEl) closeWhy() })
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !whyEl.hidden) closeWhy() })
function maybeShowWhy() {
  let seen = false
  try { seen = localStorage.getItem('seenWhy') === '1' } catch { /* noop */ }
  if (!seen && !ghosts.length) setTimeout(openWhy, 500) // a shared link opens on its comparison, not the explainer
}

let toastTimer = 0
function toast(msg: string) {
  toastEl.textContent = msg; toastEl.hidden = false
  clearTimeout(toastTimer); toastTimer = window.setTimeout(() => { toastEl.hidden = true }, 2200)
}

// ------------------------------------------------------------------ URL state
// #m=e|w  (projection)  g=ID@lon,lat;ID@lon,lat  l=country|continent
function pushHash() {
  if (suppressHash) return
  const parts = [`m=${projName === 'mercator' ? 'w' : 'e'}`]
  if (ghosts.length) parts.push('g=' + ghosts.map(g => `${g.place.id}@${g.anchor[0].toFixed(2)},${g.anchor[1].toFixed(2)}`).join(';'))
  if (levelOverride) parts.push(`l=${levelOverride}`)
  history.replaceState(null, '', '#' + parts.join('&'))
}
function readHash() {
  const h = new URLSearchParams(location.hash.slice(1))
  suppressHash = true
  if (h.get('m') === 'e') setProjection('equalearth', false)
  const l = h.get('l'); if (l === 'country' || l === 'continent' || l === 'city') setLevel(l)
  const g = h.get('g')
  const pending: Promise<unknown>[] = []
  if (g) for (const tok of g.split(';')) {
    const m = tok.match(/^([^@]+)@(-?[\d.]+),(-?[\d.]+)$/); if (!m) continue
    const place = world.byId.get(m[1]); if (!place) continue
    const anchor: LonLat = [Number(m[2]), Number(m[3])]
    if (place.feature) addGhost(place, anchor, false)
    else pending.push(liftPlace(place, anchor, false))
  }
  suppressHash = false
  void Promise.all(pending).then(() => { if (ghosts.length) { hintEl.classList.add('off'); showCompare(ghosts[ghosts.length - 1]) } })
}

// ------------------------------------------------------------------ boot
async function boot() {
  hintEl.textContent = 'Loading the world…'
  readPalette(); $('#theme').textContent = isLight() ? '☾' : '☀'
  measureChrome()
  world = await loadWorld()
  countriesByArea = [...world.countries].sort((a, b) => b.areaKm2 - a.areaKm2)
  if (world.cities.length) { const b = $<HTMLButtonElement>('[data-level="city"]'); b.disabled = false; b.title = `${world.cities.length.toLocaleString()} cities`; b.querySelector('small')?.remove() }
  setupZoom()
  resize()
  readHash()
  hintEl.textContent = ghosts.length ? 'Drag it anywhere · tap to compare' : HINT[currentLevel()]
  maybeShowWhy()
  setTimeout(() => { void loadWorldLite().then(f => { liteLand = f }) }, 1500)
  new ResizeObserver(() => resize()).observe(stage)
  new ResizeObserver(() => resize()).observe(topEl)
  new ResizeObserver(() => resize()).observe(controlsEl)
  requestDraw()
}
// debug hook, dev only
if (import.meta.env.DEV) (window as unknown as { __tsm: unknown }).__tsm = { project: (ll: LonLat) => projection(ll), get pal() { return pal }, get ghosts() { return ghosts }, stats, get transform() { return transform }, get baseT() { return baseT }, get baseKey() { return baseKey }, baseKeyNow, get baseTimer() { return baseTimer }, renderBase, draw, get base() { return base }, get visibleCities() { return visibleCities.map(v => ({ n: v.c.name, loaded: !!v.c.feature })) }, get citiesLoaded() { return citiesLoaded }, setProjection, get morph() { return morphDebug }, viewForPair: (a: string, b: string) => { const t = viewForPair(world.byId.get(a)!, world.byId.get(b)!); select(canvas).call(zoomBehavior.transform, t); return [t.k, t.x, t.y] }, screenPos, get world() { return world }, get morphing() { return morphing }, get lastZoom() { return lastZoom }, setView: (k: number, lon: number, lat: number) => { const b = projection; applyTransform(); const base = (() => { const t = transform; const p = b([lon, lat])!; return [(p[0] - t.x) / t.k, (p[1] - t.y) / t.k] })(); const visH = height - insetTop - insetBottom; select(canvas).call(zoomBehavior.transform, zoomIdentity.translate(width / 2 - k * base[0], insetTop + visH / 2 - k * base[1]).scale(k)) } }
boot().catch(err => { hintEl.textContent = 'Could not load map data'; console.error(err) })
