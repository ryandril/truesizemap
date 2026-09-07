import {
  geoMercator, geoEqualEarth, geoPath, geoGraticule10, zoom as d3zoom, zoomIdentity, select, pointer,
  type GeoProjection, type ZoomTransform, type ZoomBehavior,
} from 'd3'
import { loadWorld, searchPlaces, type Level, type Place, type World } from './data'
import { moveGeometry, contains, inBounds, fmtKm2, fmtRatio, type LonLat, type PolyFeature } from './geo'
import { Spring, project, rubberband, reducedMotion } from './spring'

type ProjName = 'mercator' | 'equalearth'

interface Ghost {
  key: number
  place: Place
  anchor: LonLat          // presentation value — what is on screen right now
  color: string
  feature: PolyFeature    // moved geometry
  sx: Spring; sy: Spring  // lon / lat springs (independent axes)
  lift: Spring            // 0 = flat on the map, 1 = lifted, >1 = held
  settled?: () => void
}

const COLORS = ['#E8A33D', '#2FA39A', '#E26D5A']
const MAX_GHOSTS = 3
const ZOOM_BANDS: { max: number; level: Level }[] = [{ max: 1.8, level: 'continent' }, { max: Infinity, level: 'country' }]
const FLICK_MIN = 12          // deg/s below which a release just settles
const DECEL = 0.995           // momentum projection rate (snappier than scroll's 0.998 — the map is small)

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
type Pal = Record<'ocean' | 'land' | 'grid' | 'border' | 'borderStrong' | 'borderFaint' | 'hover' | 'hoverLine' | 'outline' | 'accent', string>
let pal: Pal
function readPalette() {
  const cs = getComputedStyle(document.documentElement)
  const v = (n: string) => cs.getPropertyValue(n).trim()
  pal = { ocean: v('--map-ocean'), land: v('--map-land'), grid: v('--map-grid'), border: v('--map-border'), borderStrong: v('--map-border-strong'),
    borderFaint: v('--map-border-faint'), hover: v('--map-hover'), hoverLine: v('--map-hover-line'), outline: v('--map-outline'), accent: v('--gold') }
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
  const p = projName === 'mercator' ? geoMercator() : geoEqualEarth()
  const pad = 8
  const visH = height - insetTop - insetBottom
  p.fitExtent([[pad, insetTop + pad], [width - pad, height - insetBottom - pad]], sphere)
  if (projName === 'mercator' && width > visH) {
    // landscape: fill the width, let the poles run off (they are ice anyway); centre ~12°N in the visible band
    p.scale((width - 2 * pad) / (2 * Math.PI))
    p.translate([width / 2, 0])
    const y = p([0, 12])![1]
    p.translate([width / 2, insetTop + visH / 2 - y])
  }
  baseScale = p.scale()
  baseTranslate = p.translate() as [number, number]
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
  dpr = Math.min(2, window.devicePixelRatio || 1)
  canvas.width = width * dpr; canvas.height = height * dpr
  canvas.style.width = width + 'px'; canvas.style.height = height + 'px'
  projection = makeProjection()
  applyTransform()
  requestDraw()
}

// ------------------------------------------------------------------ level
function bandFor(k: number) { return ZOOM_BANDS.findIndex(b => k < b.max) }
function currentLevel(): Level {
  const band = bandFor(transform.k)
  if (levelOverride && band === overrideBand) return levelOverride
  levelOverride = null
  return ZOOM_BANDS[band].level
}
function setLevel(l: Level) { levelOverride = l; overrideBand = bandFor(transform.k); syncLevelUI(); requestDraw() }
function syncLevelUI() {
  const l = currentLevel()
  document.querySelectorAll<HTMLButtonElement>('[data-level]').forEach(b => {
    const on = b.dataset.level === l
    b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on))
  })
}
function placesAt(level: Level): Place[] { return level === 'continent' ? world.continents : world.countries }

// ------------------------------------------------------------------ hit testing
function placeAtPoint(p: LonLat, level: Level): Place | null {
  let best: Place | null = null // prefer the smaller place when overlapping (Alaska sits inside the USA)
  for (const pl of placesAt(level)) {
    if (!inBounds(pl.bounds, p)) continue
    if (contains(pl.feature, p) && (!best || pl.areaKm2 < best.areaKm2)) best = pl
  }
  return best
}
function ghostAtPoint(p: LonLat): Ghost | null {
  for (let i = ghosts.length - 1; i >= 0; i--) if (contains(ghosts[i].feature, p)) return ghosts[i]
  return null
}
function invert(xy: [number, number]): LonLat | null {
  if (!projection || !world) return null
  const r = projection.invert?.(xy)
  if (!r || !isFinite(r[0]) || !isFinite(r[1])) return null
  if (projName === 'equalearth') { // reject points outside the projected sphere
    const back = projection([r[0], r[1]])
    if (!back || Math.hypot(back[0] - xy[0], back[1] - xy[1]) > 1) return null
  }
  return [r[0], r[1]]
}

// ------------------------------------------------------------------ ghosts
function addGhost(place: Place, anchor?: LonLat, animateLift = true): Ghost {
  const existing = ghosts.find(g => g.place.id === place.id)
  if (existing && !anchor) { selected = existing; showCompare(existing); requestDraw(); return existing }
  if (ghosts.length >= MAX_GHOSTS) { ghosts.shift(); toast('Three at a time — oldest removed') }
  const used = new Set(ghosts.map(g => g.color))
  const color = COLORS.find(c => !used.has(c)) ?? COLORS[0]
  const a = anchor ?? place.centroid
  const g: Ghost = {
    key: ++ghostSeq, place, anchor: a, color, feature: place.feature,
    sx: new Spring(a[0], 1, 0.4), sy: new Spring(a[1], 1, 0.4),
    lift: new Spring(animateLift && !reducedMotion() ? 0 : 1, 0.62, 0.42),
  }
  setAnchor(g, a)
  if (animateLift && !reducedMotion()) { g.lift.to(1); kick() }
  ghosts.push(g)
  hintEl.textContent = 'Drag it anywhere · flick it · tap it to compare'
  $('#clear').hidden = false
  requestDraw(); pushHash()
  return g
}
function setAnchor(g: Ghost, a: LonLat) {
  const cap = maxLat() + 3 // rubber-band headroom
  g.anchor = [((a[0] + 540) % 360) - 180, Math.max(-cap, Math.min(cap, a[1]))]
  const same = Math.abs(g.anchor[0] - g.place.centroid[0]) < 1e-6 && Math.abs(g.anchor[1] - g.place.centroid[1]) < 1e-6
  g.feature = same ? g.place.feature : { type: 'Feature', properties: {}, geometry: moveGeometry(g.place.feature.geometry, g.place.centroid, g.anchor) }
}
function removeGhost(g: Ghost) {
  ghosts = ghosts.filter(x => x !== g)
  if (selected === g) { selected = null; hideCompare() }
  $('#clear').hidden = ghosts.length === 0
  requestDraw(); pushHash()
}
function clearGhosts() { ghosts = []; selected = null; hideCompare(); $('#clear').hidden = true; requestDraw(); pushHash() }

/** what the ghost is "over": the place under its anchor at the current level, excluding itself. */
function under(g: Ghost): Place | null {
  const lvl = g.place.level === 'continent' ? 'continent' : currentLevel()
  const p = placeAtPoint(g.anchor, lvl)
  return p && p.id === g.place.id ? null : p
}

/** Glide a ghost to a target (presets). Critically damped, slow response; interruptible by grabbing it. */
function glideTo(g: Ghost, to: LonLat): Promise<void> {
  if (reducedMotion()) { g.sx.jump(to[0]); g.sy.jump(to[1]); setAnchor(g, to); requestDraw(); pushHash(); return Promise.resolve() }
  g.sx.set(1, 1.1); g.sy.set(1, 1.1)
  let lon = to[0]; const cur = g.sx.x           // take the short way round
  while (lon - cur > 180) lon -= 360; while (lon - cur < -180) lon += 360
  g.sx.to(lon); g.sy.to(to[1]); kick()
  return new Promise(res => { g.settled = res })
}

// ------------------------------------------------------------------ animation loop (springs)
let animating = false, lastT = 0
function kick() { if (!animating) { animating = true; lastT = performance.now(); requestAnimationFrame(tick) } }
function tick(t: number) {
  const dt = Math.max(0, (t - lastT) / 1000); lastT = t
  let busy = false
  for (const g of ghosts) {
    const moving = !g.sx.done || !g.sy.done
    g.sx.step(dt, 5e-3); g.sy.step(dt, 5e-3); g.lift.step(dt, 2e-3)
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
function draw() {
  frame = 0
  if (!world) return
  applyTransform()
  const path = geoPath(projection, ctx)
  ctx.save(); ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, width, height)

  ctx.beginPath(); path(sphere); ctx.fillStyle = pal.ocean; ctx.fill()
  ctx.beginPath(); path(graticule); ctx.strokeStyle = pal.grid; ctx.lineWidth = 0.6; ctx.stroke()

  const level = currentLevel()
  ctx.beginPath(); for (const f of world.land) path(f)
  ctx.fillStyle = pal.land; ctx.fill()
  ctx.beginPath(); for (const p of placesAt(level)) if (p.id !== 'US-AK') path(p.feature)
  ctx.strokeStyle = level === 'continent' ? pal.borderStrong : pal.border
  ctx.lineWidth = level === 'continent' ? 0.9 : 0.6; ctx.lineJoin = 'round'; ctx.stroke()
  if (level === 'continent') {
    ctx.beginPath(); for (const p of world.countries) if (p.id !== 'US-AK') path(p.feature)
    ctx.strokeStyle = pal.borderFaint; ctx.lineWidth = 0.5; ctx.stroke()
  }
  // press (instant, on pointer-down) and hover feedback
  const hl = pressPlace ?? hoverPlace
  if (hl) {
    ctx.beginPath(); path(hl.feature)
    ctx.fillStyle = pressPlace ? 'rgba(232,163,61,0.28)' : pal.hover; ctx.fill()
    ctx.strokeStyle = pressPlace ? pal.accent : pal.hoverLine; ctx.lineWidth = 1; ctx.stroke()
  }
  // where each ghost came from
  for (const g of ghosts) { ctx.beginPath(); path(g.place.feature); ctx.setLineDash([3, 3]); ctx.strokeStyle = g.color + '99'; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]) }
  // ghosts: lift → shadow + brightness, so a lifted shape reads as floating above the map
  for (const g of ghosts) {
    const L = Math.max(0, g.lift.x)
    ctx.save()
    ctx.shadowColor = 'rgba(0,0,0,' + ((isLight() ? 0.28 : 0.55) * Math.min(1, L)).toFixed(3) + ')'
    ctx.shadowBlur = 18 * L; ctx.shadowOffsetY = 6 * L
    ctx.beginPath(); path(g.feature)
    ctx.fillStyle = g.color + (g === selected ? 'B3' : '8C'); ctx.fill()
    ctx.restore()
    ctx.beginPath(); path(g.feature)
    ctx.strokeStyle = g.color; ctx.lineWidth = g === selected ? 2 : 1.4; ctx.stroke()
  }
  if (projName === 'equalearth') { ctx.beginPath(); path(sphere); ctx.strokeStyle = pal.outline; ctx.lineWidth = 1; ctx.stroke() }
  ctx.restore()

  drawLabels()
  syncLevelUI()
  $('#reset').hidden = transform.k === 1 && transform.x === 0 && transform.y === 0
}

// Labels are built from Natural Earth names (static, shipped with the site) and always pass through esc().
function drawLabels() {
  const items: string[] = []
  for (const g of ghosts) {
    const xy = projection(g.anchor)
    if (!xy) continue
    const [x, y] = xy
    if (x < -40 || x > width + 40 || y < insetTop + 30 || y > height - insetBottom) continue
    const u = under(g)
    const ratio = u ? fmtRatio(g.place.areaKm2, u.areaKm2) : null
    const over = u ? `<span class="r"><strong>${ratio!.short}</strong> ${ratio!.short.endsWith('%') ? 'of' : 'the size of'} ${esc(u.name)}</span>` : `<span class="r">${fmtKm2(g.place.areaKm2)}</span>`
    items.push(`<div class="label" style="left:${x}px;top:${y}px;--c:${g.color}" data-key="${g.key}"><b>${esc(g.place.name)}</b> · ${over}</div>`)
  }
  labelsEl.innerHTML = items.join('')
  if (selected) fillCompare(selected)
}
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

// ------------------------------------------------------------------ compare sheet
function showCompare(g: Ghost) { selected = g; compareEl.hidden = false; fillCompare(g) }
function hideCompare() { compareEl.hidden = true; selected = null }
function fillCompare(g: Ghost) {
  const u = under(g)
  $('#cmp-a-name').textContent = g.place.name
  $('#cmp-a-def').textContent = g.place.def
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
    $('#cmp-b-name').textContent = 'Open water'; $('#cmp-b-def').textContent = 'drag over a place to compare'; $('#cmp-b-area').textContent = ''
    $('#cmp-ratio').textContent = '·'
    $('#cmp-sentence').innerHTML = `<strong>${esc(g.place.name)}</strong> keeps its true area wherever you put it. On Mercator it only <em>looks</em> different.`
  }
}
$('#compare-close').addEventListener('click', hideCompare)
$('#cmp-remove').addEventListener('click', () => { if (selected) removeGhost(selected) })

// ------------------------------------------------------------------ interactions
interface Drag { g: Ghost; startGeo: LonLat; startAnchor: LonLat; raw: LonLat; moved: boolean; hist: { t: number; lon: number; lat: number }[] }
let drag: Drag | null = null
let pressXY: [number, number] | null = null

function setupZoom() {
  zoomBehavior = d3zoom<HTMLCanvasElement, unknown>()
    .scaleExtent([1, 60])
    .filter((ev: Event) => {
      const e = ev as PointerEvent | WheelEvent | TouchEvent
      if ('touches' in e && e.touches.length > 1) return true // pinch always zooms
      if (e.type === 'wheel') return true
      if ((e as MouseEvent).button && (e as MouseEvent).button !== 0) return false
      const geo = invert(pointer(e, canvas) as [number, number])
      return !(geo && ghostAtPoint(geo)) // a press that starts on a ghost is a drag, not a pan
    })
    .on('zoom', (ev) => { transform = ev.transform; requestDraw() })
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
  g.sx.jump(g.anchor[0]); g.sy.jump(g.anchor[1]); g.settled?.(); g.settled = undefined
  drag = { g, startGeo: geo, startAnchor: g.anchor.slice() as LonLat, raw: g.anchor.slice() as LonLat, moved: false, hist: [{ t: e.timeStamp, lon: g.anchor[0], lat: g.anchor[1] }] }
  if (!reducedMotion()) { g.lift.set(0.8, 0.3); g.lift.to(1.35); kick() }
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
    drag.hist.push({ t: e.timeStamp, lon: raw[0], lat: raw[1] })
    if (drag.hist.length > 8) drag.hist.shift()
    // rubber-band at the polar edge instead of a hard stop
    const cap = maxLat()
    const lat = raw[1] > cap ? cap + rubberband(raw[1] - cap, 6) : raw[1] < -cap ? -cap + rubberband(raw[1] + cap, 6) : raw[1]
    drag.g.sx.jump(raw[0]); drag.g.sy.jump(lat)
    setAnchor(drag.g, [raw[0], lat])
    requestDraw(); return
  }
  if (pressPlace && pressXY && Math.hypot(xy[0] - pressXY[0], xy[1] - pressXY[1]) > 6) { pressPlace = null; requestDraw() } // it's a pan
  if (e.pointerType === 'mouse') {
    const geo = invert(xy)
    const p = geo && !ghostAtPoint(geo) ? placeAtPoint(geo, currentLevel()) : null
    if (p !== hoverPlace) { hoverPlace = p; canvas.style.cursor = p ? 'pointer' : 'grab'; requestDraw() }
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

  // release velocity from the last ~100 ms of movement
  const now = e.timeStamp
  const recent = d.hist.filter(h => now - h.t <= 110)
  const a = recent[0] ?? d.hist[d.hist.length - 1], b = d.hist[d.hist.length - 1]
  const dt = (b.t - a.t) / 1000
  let vLon = 0, vLat = 0
  if (dt > 0.008 && !reducedMotion()) { vLon = (b.lon - a.lon) / dt; vLat = (b.lat - a.lat) / dt }
  const speed = Math.hypot(vLon, vLat)
  const cap = maxLat()
  let targetLon = d.raw[0], targetLat = d.raw[1]
  if (speed > FLICK_MIN) { // momentum: animate to where the flick is going, at the finger's velocity
    targetLon += project(vLon, DECEL); targetLat += project(vLat, DECEL)
    g.sx.set(0.85, 0.5); g.sy.set(0.85, 0.5)
  } else { g.sx.set(1, 0.35); g.sy.set(1, 0.35); vLon = 0; vLat = 0 }
  targetLat = Math.max(-cap, Math.min(cap, targetLat))
  if (Math.abs(targetLon - g.anchor[0]) > 1e-6 || Math.abs(targetLat - g.anchor[1]) > 1e-6 || speed > FLICK_MIN) {
    g.sx.jump(g.anchor[0]); g.sy.jump(g.anchor[1])
    g.sx.to(targetLon, vLon); g.sy.to(targetLat, vLat); kick()
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
  const p = placeAtPoint(geo, currentLevel())
  if (p) { addGhost(p); hintEl.classList.add('off') } else hideCompare()
})
labelsEl.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('.label'); if (!el) return
  const g = ghosts.find(x => x.key === Number(el.dataset.key)); if (g) showCompare(g)
})

// ------------------------------------------------------------------ UI: projection, level, presets, search, share
document.querySelectorAll<HTMLButtonElement>('[data-proj]').forEach(b => b.addEventListener('click', () => setProjection(b.dataset.proj as ProjName)))
function setProjection(p: ProjName) {
  if (p === projName) return
  projName = p
  document.querySelectorAll<HTMLButtonElement>('[data-proj]').forEach(x => { const on = x.dataset.proj === p; x.classList.toggle('on', on); x.setAttribute('aria-checked', String(on)) })
  transform = zoomIdentity; select(canvas).call(zoomBehavior.transform, zoomIdentity)
  projection = makeProjection()
  for (const g of ghosts) setAnchor(g, g.anchor)
  requestDraw(); pushHash()
}
document.querySelectorAll<HTMLButtonElement>('[data-level]').forEach(b => b.addEventListener('click', () => { if (!b.disabled) setLevel(b.dataset.level as Level) }))
$('#reset').addEventListener('click', () => select(canvas).transition().duration(reducedMotion() ? 0 : 450).call(zoomBehavior.transform, zoomIdentity))
$('#clear').addEventListener('click', clearGhosts)

const PRESETS: Record<string, { src: string; dst: string; level: Level }> = {
  'grl-af': { src: 'GRL', dst: 'AF', level: 'continent' },
  'eu-af': { src: 'EU', dst: 'AF', level: 'continent' },
  'ak-mx': { src: 'US-AK', dst: 'MEX', level: 'country' },
}
document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach(b => b.addEventListener('click', async () => {
  const p = PRESETS[b.dataset.preset!]; const src = world.byId.get(p.src)!; const dst = world.byId.get(p.dst)!
  clearGhosts(); hintEl.classList.add('off')
  if (transform.k !== 1) { transform = zoomIdentity; select(canvas).call(zoomBehavior.transform, zoomIdentity) }
  setLevel(p.level)
  const g = addGhost(src, src.centroid)
  await new Promise(r => setTimeout(r, reducedMotion() ? 0 : 250)) // let the lift read before the glide
  await glideTo(g, dst.centroid)
  if (ghosts.includes(g)) showCompare(g)
}))

// search
const searchEl = $<HTMLInputElement>('#search'), resultsEl = $<HTMLUListElement>('#results')
let results: Place[] = [], selIdx = -1
searchEl.addEventListener('input', () => {
  results = searchPlaces(world, searchEl.value); selIdx = -1
  if (!searchEl.value.trim()) { resultsEl.hidden = true; return }
  resultsEl.innerHTML = results.length
    ? results.map((p, i) => `<li data-i="${i}"><span>${esc(p.name)}</span><span class="tag">${p.level}</span></li>`).join('')
    : `<li class="none">No match — cities are coming soon</li>`
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
  const g = addGhost(p)
  hintEl.classList.add('off')
  const xy = projection(g.anchor)
  if (!xy || xy[0] < 0 || xy[0] > width || xy[1] < insetTop || xy[1] > height - insetBottom) select(canvas).transition().duration(reducedMotion() ? 0 : 400).call(zoomBehavior.transform, zoomIdentity)
  showCompare(g)
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

// why
$('#why-btn').addEventListener('click', () => {
  const w = $('#why'); w.hidden = !w.hidden
  $('#why-btn').setAttribute('aria-expanded', String(!w.hidden))
  requestAnimationFrame(resize)
})

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
  if (h.get('m') === 'e') setProjection('equalearth')
  const l = h.get('l'); if (l === 'country' || l === 'continent') setLevel(l)
  const g = h.get('g')
  if (g) for (const tok of g.split(';')) {
    const m = tok.match(/^([^@]+)@(-?[\d.]+),(-?[\d.]+)$/); if (!m) continue
    const place = world.byId.get(m[1]); if (!place) continue
    addGhost(place, [Number(m[2]), Number(m[3])], false)
  }
  suppressHash = false
  if (ghosts.length) { hintEl.classList.add('off'); showCompare(ghosts[ghosts.length - 1]) }
}

// ------------------------------------------------------------------ boot
async function boot() {
  hintEl.textContent = 'Loading the world…'
  readPalette(); $('#theme').textContent = isLight() ? '☾' : '☀'
  measureChrome()
  world = await loadWorld()
  setupZoom()
  resize()
  readHash()
  hintEl.textContent = ghosts.length ? 'Drag it anywhere · flick it · tap it to compare' : 'Tap a country to lift a copy · drag it anywhere'
  new ResizeObserver(() => resize()).observe(stage)
  new ResizeObserver(() => resize()).observe(topEl)
  new ResizeObserver(() => resize()).observe(controlsEl)
  requestDraw()
}
// debug hook, dev only
if (import.meta.env.DEV) (window as unknown as { __tsm: unknown }).__tsm = { project: (ll: LonLat) => projection(ll), get pal() { return pal }, get ghosts() { return ghosts } }
boot().catch(err => { hintEl.textContent = 'Could not load map data'; console.error(err) })
