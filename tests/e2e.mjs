// End-to-end QA for truesizemap. Plain Node ESM, no runner.
//   node tests/e2e.mjs            (expects `vite preview --port 4173` to be running)
// Drives the real production build through the UI only (no dev hook), in two contexts:
// an iPhone-14-like touch device and a 1280x800 mouse desktop. Writes screenshots to tests/shots/
// and a markdown report to tests/report.md.
import { chromium } from 'playwright'
import * as d3 from 'd3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const URL = process.env.TSM_URL ?? 'http://localhost:4173/'
const here = path.dirname(fileURLToPath(import.meta.url))
const SHOTS = path.join(here, 'shots')
fs.mkdirSync(SHOTS, { recursive: true })

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const results = [] // { scenario, ctx, pass, evidence: string[], errors: string[] }

// ------------------------------------------------------------------ helpers
async function shot(page, ctxName, name, opts = {}) {
  const file = path.join(SHOTS, `${ctxName}-${name}.png`)
  await page.screenshot({ path: file, ...opts })
  return path.relative(process.cwd(), file)
}
function attachErrorCapture(page, sink) {
  page.on('console', m => { if (m.type() === 'error') sink.push(`console.error: ${m.text()}`) })
  page.on('pageerror', e => sink.push(`pageerror: ${e.message}`))
}
async function gotoApp(page, hash = '') {
  await page.goto(URL + hash, { waitUntil: 'load' })
  await waitForWorld(page)
}
async function waitForWorld(page) {
  await page.waitForFunction(() => {
    const h = document.querySelector('#hint'), c = document.querySelector('[data-level="city"]')
    return h && !h.textContent.startsWith('Loading') && h.textContent !== 'Could not load map data' && c && !c.disabled && document.querySelectorAll('#presets .chip').length > 0
  }, null, { timeout: 30000 })
  await sleep(300)
}
// DOM read helpers (thin wrappers over Playwright's page.evaluate)
const q1 = (page, sel, fn) => page.$eval(sel, fn)
const qa = (page, sel, fn) => page.$$eval(sel, fn)
const run = (page, fn, arg) => page.evaluate(fn, arg)

async function dismissWhy(page) {
  const vis = await q1(page, '#why', el => !el.hidden).catch(() => false)
  if (vis) { await page.click('#why-skip'); await sleep(200) }
}
async function markSeen(page) { await run(page, () => { try { localStorage.setItem('seenWhy', '1') } catch {} }) }

/** Mirror of the app's projectionFor(): screen position (page px) of lon/lat at zoom k=1. */
async function projector(page, projName = 'mercator') {
  const m = await run(page, () => {
    const r = document.querySelector('#map').getBoundingClientRect()
    return { x: r.left, y: r.top, width: Math.round(r.width), height: Math.round(r.height), insetTop: document.querySelector('.top').offsetHeight, insetBottom: document.querySelector('.controls').offsetHeight }
  })
  const { width, height, insetTop, insetBottom } = m
  const p = projName === 'mercator' ? d3.geoMercator() : d3.geoEqualEarth()
  const pad = 8, visH = height - insetTop - insetBottom
  p.fitExtent([[pad, insetTop + pad], [width - pad, height - insetBottom - pad]], { type: 'Sphere' })
  if (projName === 'mercator') {
    if (width > visH) { p.scale((width - 2 * pad) / (2 * Math.PI)); p.translate([width / 2, 0]); const y = p([0, 12])[1]; p.translate([width / 2, insetTop + visH / 2 - y]) }
    else { p.scale((visH - 2 * pad) / (2 * Math.PI) * 1.15); p.translate([0, 0]); const c = p([10, 15]); p.translate([width / 2 - c[0], insetTop + visH / 2 - c[1]]) }
  }
  return { ...m, visH, toScreen: (lon, lat) => { const q = p([lon, lat]); return [q[0] + m.x, q[1] + m.y] } }
}

async function tap(page, mobile, x, y) { if (mobile) await page.touchscreen.tap(x, y); else await page.mouse.click(x, y) }
async function touchDrag(page, from, to, steps = 24, stepDelay = 40, hold = 3) {
  const cdp = await page.context().newCDPSession(page)
  const pt = (x, y) => ({ x, y, radiusX: 4, radiusY: 4, force: 1 })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt(from[0], from[1])] })
  await sleep(60)
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [pt(from[0] + (to[0] - from[0]) * i / steps, from[1] + (to[1] - from[1]) * i / steps)] })
    await sleep(stepDelay)
  }
  for (let i = 0; i < hold; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [pt(to[0], to[1])] }); await sleep(60) }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}
async function mouseDrag(page, from, to, steps = 24, stepDelay = 40, hold = 3) {
  await page.mouse.move(from[0], from[1]); await page.mouse.down(); await sleep(60)
  for (let i = 1; i <= steps; i++) { await page.mouse.move(from[0] + (to[0] - from[0]) * i / steps, from[1] + (to[1] - from[1]) * i / steps); await sleep(stepDelay) }
  for (let i = 0; i < hold; i++) { await page.mouse.move(to[0], to[1]); await sleep(60) }
  await page.mouse.up()
}
const drag = (page, mobile, from, to, steps, delay, hold) => mobile ? touchDrag(page, from, to, steps, delay, hold) : mouseDrag(page, from, to, steps, delay, hold)
/** Two-finger pinch around (cx,cy): finger distance d0 -> d1. */
async function pinch(page, cx, cy, d0, d1, steps = 20) {
  const cdp = await page.context().newCDPSession(page)
  const pts = (d) => [{ x: cx - d / 2, y: cy, radiusX: 4, radiusY: 4, force: 1 }, { x: cx + d / 2, y: cy, radiusX: 4, radiusY: 4, force: 1 }]
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(d0) })
  await sleep(50)
  for (let i = 1; i <= steps; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(d0 + (d1 - d0) * i / steps) }); await sleep(30) }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}
async function wheelZoom(page, x, y, ticks, deltaY = -100) {
  await page.mouse.move(x, y)
  for (let i = 0; i < ticks; i++) { await page.mouse.wheel(0, deltaY); await sleep(40) }
}
/** Zoom in by roughly `factor` using the platform gesture. */
async function zoomIn(page, mobile, cx, cy, factor) {
  if (mobile) await pinch(page, cx, cy, 40, 40 * factor)
  else await wheelZoom(page, cx, cy, Math.ceil(Math.log2(factor) / 0.2))
}
// positions come from the rendered box, so the harness does not care whether the app positions with
// left/top or a transform
const labels = (page) => qa(page, '#labels .label', els => els.map(e => { const r = e.getBoundingClientRect(); return { text: e.textContent.replace(/\s+/g, ' ').trim(), left: Math.round(r.left + r.width / 2), top: Math.round(r.bottom) } }))
async function waitForLabel(page, needle, timeout = 4000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const ls = await labels(page)
    const hit = ls.find(l => l.text.includes(needle))
    if (hit) return hit
    await sleep(100)
  }
  return null
}
const levelChecked = (page) => qa(page, '[data-level]', bs => bs.find(b => b.getAttribute('aria-checked') === 'true')?.dataset.level ?? null)
const hintState = (page) => q1(page, '#hint', h => ({ text: h.textContent, off: h.classList.contains('off') }))
const hashOf = (page) => run(page, () => location.hash)
/** Canvas pixel sample of a rectangle (canvas-relative CSS px). */
const samplePixels = (page, x, y, w, h) => run(page, ([x, y, w, h]) => {
  const c = document.querySelector('#map'), ctx = c.getContext('2d')
  const dpr = c.width / c.getBoundingClientRect().width
  const d = ctx.getImageData(Math.round(x * dpr), Math.round(y * dpr), Math.round(w * dpr), Math.round(h * dpr)).data
  let opaque = 0; const counts = new Map()
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] > 200) { opaque++; const k = (d[i] >> 3) + ',' + (d[i + 1] >> 3) + ',' + (d[i + 2] >> 3); counts.set(k, (counts.get(k) ?? 0) + 1) }
  }
  const top = [...counts.values()].sort((a, b) => b - a)[0] ?? 0
  return { opaque, total: d.length / 4, distinct: counts.size, landFrac: opaque ? 1 - top / opaque : 0 }
}, [x, y, w, h])
const rawPixels = (page, x, y, w, h) => run(page, ([x, y, w, h]) => {
  const c = document.querySelector('#map'), ctx = c.getContext('2d')
  const dpr = c.width / c.getBoundingClientRect().width
  return Array.from(ctx.getImageData(Math.round(x * dpr), Math.round(y * dpr), Math.round(w * dpr), Math.round(h * dpr)).data)
}, [x, y, w, h])
const pixelDiff = (page, x, y, w, h, before) => run(page, ([x, y, w, h, before]) => {
  const c = document.querySelector('#map'), ctx = c.getContext('2d')
  const dpr = c.width / c.getBoundingClientRect().width
  const d = ctx.getImageData(Math.round(x * dpr), Math.round(y * dpr), Math.round(w * dpr), Math.round(h * dpr)).data
  let diff = 0
  for (let i = 0; i < d.length; i += 4) { if (Math.abs(d[i] - before[i]) + Math.abs(d[i + 1] - before[i + 1]) + Math.abs(d[i + 2] - before[i + 2]) > 30) diff++ }
  return { diff, total: d.length / 4 }
}, [x, y, w, h, before])
async function pickSearch(page, text) { await page.fill('#search', text); await sleep(250); await page.click('#results li[data-i="0"]') }

async function record(name, ctxName, fn) {
  const r = { scenario: name, ctx: ctxName, pass: false, evidence: [], errors: [] }
  results.push(r)
  const t0 = Date.now()
  try { const ok = await fn(r); r.pass = ok !== false }
  catch (e) { r.pass = false; r.evidence.push(`EXCEPTION: ${e.message.split('\n')[0]}`) }
  console.log(`[${ctxName}] ${r.pass ? 'PASS' : 'FAIL'} ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
  for (const e of r.evidence) console.log('    - ' + e)
  if (r.errors.length) console.log('    ! ' + r.errors.length + ' console/page errors: ' + [...new Set(r.errors)].slice(0, 3).join(' | '))
  return r
}

// ------------------------------------------------------------------ scenarios
async function runContext(browser, ctxName, ctxOpts, mobile) {
  const context = await browser.newContext(ctxOpts)
  // keep analytics out of the console error stream (third-party scripts, not the app)
  await context.route(/gc\.zgo\.at|googletagmanager\.com|google-analytics\.com/, r => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }))
  try { await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: URL }) } catch {}
  const newPage = async (sink, hash = '') => {
    const page = await context.newPage()
    attachErrorCapture(page, sink)
    page.on('dialog', d => { sink.push(`dialog(${d.type()}): ${d.message()} :: ${d.defaultValue()}`.slice(0, 200)); d.dismiss().catch(() => {}) })
    await gotoApp(page, hash)
    return page
  }
  const only = process.env.TSM_ONLY ? process.env.TSM_ONLY.split(',') : null
  const rec = (name, fn) => (!only || only.includes(name.split(' ')[0])) ? record(name, ctxName, fn) : Promise.resolve()

  // 1. first visit
  await rec('1 First visit / Why modal / demo', async (r) => {
    let ok = true
    const page = await context.newPage(); attachErrorCapture(page, r.errors)
    await page.goto(URL)
    const appeared = await page.waitForFunction(() => !document.querySelector('#why').hidden, null, { timeout: 1500 }).then(() => true).catch(() => false)
    r.evidence.push(`modal appeared within 1.5s: ${appeared}`); if (!appeared) ok = false
    await waitForWorld(page)
    r.evidence.push(await shot(page, ctxName, '01-why-modal'))
    await page.click('#why-skip'); await sleep(200)
    const hiddenAfterSkip = await q1(page, '#why', e => e.hidden)
    r.evidence.push(`hidden after 'Just explore': ${hiddenAfterSkip}`); if (!hiddenAfterSkip) ok = false
    await page.reload(); await waitForWorld(page); await sleep(1200)
    const reappeared = await q1(page, '#why', e => !e.hidden)
    r.evidence.push(`reappeared after reload: ${reappeared} (localStorage seenWhy=${await run(page, () => localStorage.getItem('seenWhy'))})`); if (reappeared) ok = false
    await page.click('#why-btn'); await sleep(200)
    const reopened = await q1(page, '#why', e => !e.hidden)
    r.evidence.push(`'Why?' reopens: ${reopened}`); if (!reopened) ok = false
    await page.click('#why-try')
    const first = await waitForLabel(page, 'Greenland', 4000)
    const lbl = await waitForLabel(page, 'of Africa', 4000)
    const tC = Date.now()
    const cmpVisible = await page.waitForFunction(() => !document.querySelector('#compare').hidden, null, { timeout: 6000 }).then(() => true).catch(() => false)
    r.evidence.push(`first label seen: ${first ? JSON.stringify(first.text) : 'NONE'}; compare card appeared ${cmpVisible ? (Date.now() - tC) + 'ms after the label read "of Africa"' : 'NEVER (6s)'}`)
    await sleep(300)
    const cmpB = await q1(page, '#cmp-b-name', e => e.textContent)
    r.evidence.push(`demo label: ${lbl ? JSON.stringify(lbl.text) : 'NONE'}; compare visible: ${cmpVisible}; cmp-b: ${JSON.stringify(cmpB)}`)
    if (!lbl || !lbl.text.includes('of Africa') || !cmpVisible || cmpB !== 'Africa') ok = false
    r.evidence.push(await shot(page, ctxName, '01-demo-greenland-africa'))
    await page.close()
    return ok
  })

  // 2. tap to lift
  await rec('2 Tap to lift (Country tab)', async (r) => {
    const page = await newPage(r.errors); await dismissWhy(page); await markSeen(page)
    const pr = await projector(page)
    const cands = [['Brazil', -49.56, -12.1], ['USA', -97.48, 39.54], ['Australia', 134.05, -24.13], ['Russia', 60, 60], ['China', 106.34, 32.5]]
    let got = null
    for (const [n, lon, lat] of cands) {
      const [x, y] = pr.toScreen(lon, lat)
      if (x < pr.x || x > pr.x + pr.width || y < pr.y + pr.insetTop || y > pr.y + pr.height - pr.insetBottom) { r.evidence.push(`${n} off-screen at (${x | 0},${y | 0}), skipped`); continue }
      await tap(page, mobile, x, y); await sleep(700)
      const ls = await labels(page)
      r.evidence.push(`tap ${n} @(${x | 0},${y | 0}) -> labels: ${JSON.stringify(ls.map(l => l.text))}`)
      if (ls.length) { got = { n, x, y }; break }
    }
    const hint = await hintState(page)
    r.evidence.push(`hint: ${JSON.stringify(hint)}`)
    r.evidence.push(await shot(page, ctxName, '02-tap-lift'))
    await page.close()
    return !!got && hint.text.startsWith('Drag it')
  })

  // 3. drag a shape, map must not pan
  await rec('3 Drag shape; base map stays put', async (r) => {
    const page = await newPage(r.errors); await dismissWhy(page); await markSeen(page)
    const pr = await projector(page)
    const [bx, by] = pr.toScreen(-49.56, -12.1)
    await tap(page, mobile, bx, by); await sleep(900)
    const before = await labels(page)
    if (!before.length) { r.evidence.push('could not lift Brazil'); await page.close(); return false }
    // a probe region far from the drag path: around India / the Arabian Sea
    const [ix, iy] = pr.toScreen(70, 15)
    const probe = [ix - pr.x - 40, iy - pr.y - 40, 80, 80]
    const px0 = await rawPixels(page, ...probe)
    const [ax, ay] = pr.toScreen(17, 6) // central Africa
    await drag(page, mobile, [bx, by], [ax, ay])
    await sleep(1500)
    const after = await labels(page)
    const diff = await pixelDiff(page, ...probe, px0)
    r.evidence.push(`label before: ${JSON.stringify(before[0].text)} @(${before[0].left | 0},${before[0].top | 0})`)
    r.evidence.push(`label after:  ${after[0] ? JSON.stringify(after[0].text) + ` @(${after[0].left | 0},${after[0].top | 0})` : 'NONE'}`)
    r.evidence.push(`base-map probe (80x80 px around India) changed pixels: ${diff.diff}/${diff.total}`)
    r.evidence.push(await shot(page, ctxName, '03-after-drag'))
    const moved = after[0] && Math.hypot(after[0].left - before[0].left, after[0].top - before[0].top) > 40
    const textChanged = after[0] && after[0].text !== before[0].text
    r.evidence.push(`label moved: ${!!moved}; ratio text changed: ${!!textChanged}; hash: ${await hashOf(page)}`)
    await page.close()
    return !!moved && !!textChanged && diff.diff < diff.total * 0.02
  })

  // 4. pan & zoom the base map
  await rec('4 Pan / pinch-zoom / pole limits / endless E-W', async (r) => {
    let ok = true
    const page = await newPage(r.errors); await dismissWhy(page); await markSeen(page)
    const pr = await projector(page)
    const cx = pr.x + pr.width / 2, cy = pr.y + pr.insetTop + pr.visH / 2
    const before = await samplePixels(page, 0, pr.insetTop, pr.width, pr.visH)
    // zoom far in (>= 6x flips to City)
    await zoomIn(page, mobile, cx, cy, 8); await sleep(600)
    if (mobile) { await zoomIn(page, mobile, cx, cy, 2); await sleep(600) }
    const lvl = await levelChecked(page)
    const after = await samplePixels(page, 0, pr.insetTop, pr.width, pr.visH)
    r.evidence.push(`level after deep zoom: ${lvl}; distinct colours in band ${before.distinct} -> ${after.distinct}`); if (lvl !== 'city') ok = false
    r.evidence.push(await shot(page, ctxName, '04-zoomed-in'))
    // zoom back out
    if (mobile) { await pinch(page, cx, cy, 300, 30); await sleep(400); await pinch(page, cx, cy, 300, 30); await sleep(400) } else await wheelZoom(page, cx, cy, 30, 100)
    await sleep(500)
    r.evidence.push(`level after zoom out: ${await levelChecked(page)}`)
    // pan down repeatedly (finger moves down -> map moves down -> exposes the north)
    for (let i = 0; i < 6; i++) await drag(page, mobile, [cx, pr.y + pr.insetTop + 40], [cx, pr.y + pr.height - pr.insetBottom - 40], 8, 15, 1)
    await sleep(600)
    const topRow = await samplePixels(page, 10, pr.insetTop + 2, pr.width - 20, 3)
    r.evidence.push(`after 6 downward pans: top row of the visible band opaque ${topRow.opaque}/${topRow.total} px (map still covers the top edge: ${topRow.opaque === topRow.total})`)
    if (topRow.opaque !== topRow.total) ok = false
    r.evidence.push(await shot(page, ctxName, '04-pan-north-limit'))
    // pan east-west endlessly
    const panW = pr.width - 60
    for (let i = 0; i < 2; i++) await drag(page, mobile, [pr.x + 30, cy], [pr.x + pr.width - 30, cy], 8, 15, 1)
    await sleep(600)
    const two = await samplePixels(page, 0, pr.insetTop, pr.width, pr.visH)
    r.evidence.push(`after 2 rightward pans (${2 * panW}px): land fraction ${(two.landFrac * 100).toFixed(1)}%, opaque ${two.opaque}/${two.total}`)
    r.evidence.push(await shot(page, ctxName, '04-pan-east-west-2'))
    for (let i = 0; i < 8; i++) await drag(page, mobile, [pr.x + 30, cy], [pr.x + pr.width - 30, cy], 8, 15, 1)
    await sleep(600)
    const mid = await samplePixels(page, 0, pr.insetTop, pr.width, pr.visH)
    r.evidence.push(`after 10 rightward pans (${10 * panW}px total): land fraction ${(mid.landFrac * 100).toFixed(1)}%, opaque ${mid.opaque}/${mid.total}; tap on the blank map lifts anything? ${await (async () => { await tap(page, mobile, cx, cy); await sleep(500); return (await labels(page)).length })()} labels`)
    if (mid.landFrac < 0.05 || mid.opaque < mid.total * 0.95) ok = false
    r.evidence.push(await shot(page, ctxName, '04-pan-east-west'))
    await page.close()
    return ok
  })

  // 5. projection toggle
  await rec('5 Projection toggle (morph, hash, zoom preserved)', async (r) => {
    let ok = true
    const page = await newPage(r.errors); await dismissWhy(page); await markSeen(page)
    await page.click('[data-proj="equalearth"]')
    const frames = []
    for (let i = 0; i < 3; i++) { await sleep(300); frames.push(await page.screenshot()) }
    const d01 = !frames[0].equals(frames[1]), d12 = !frames[1].equals(frames[2])
    r.evidence.push(`morph frames differ: 0-1 ${d01}, 1-2 ${d12}`); if (!(d01 && d12)) ok = false
    await sleep(1300)
    const s1 = await page.screenshot(); await sleep(300); const s2 = await page.screenshot()
    r.evidence.push(`stable after morph: ${s1.equals(s2)}`)
    const hash = await hashOf(page)
    r.evidence.push(`hash: ${hash}; aria-checked equalearth: ${await q1(page, '[data-proj="equalearth"]', b => b.getAttribute('aria-checked'))}`); if (!hash.includes('m=e')) ok = false
    r.evidence.push(await shot(page, ctxName, '05-equal-earth'))
    await page.click('[data-proj="mercator"]'); await sleep(1600)
    r.evidence.push(`hash after toggling back: ${await hashOf(page)}`)
    // zoomed toggle: lift two neighbours via search, zoom, toggle, compare label spacing
    for (const q of ['Egypt', 'Libya']) { await pickSearch(page, q); await sleep(700) }
    const pr = await projector(page)
    const cx = pr.x + pr.width / 2, cy = pr.y + pr.insetTop + pr.visH / 2
    await zoomIn(page, mobile, cx, cy, 4); await sleep(800)
    const l0 = await labels(page)
    const dist = (ls) => ls.length >= 2 ? Math.hypot(ls[0].left - ls[1].left, ls[0].top - ls[1].top) : NaN
    const lvl0 = await levelChecked(page)
    r.evidence.push(await shot(page, ctxName, '05-zoomed-before-toggle'))
    await page.click('[data-proj="equalearth"]'); await sleep(1800)
    const l1 = await labels(page)
    const d0 = dist(l0), d1 = dist(l1)
    r.evidence.push(`zoomed toggle: labels ${JSON.stringify(l0.map(l => l.text.split(' · ')[0]))} spacing ${d0.toFixed(0)}px -> ${d1.toFixed(0)}px (ratio ${(d1 / d0).toFixed(2)}); level ${lvl0} -> ${await levelChecked(page)}; hash ${await hashOf(page)}`)
    r.evidence.push(await shot(page, ctxName, '05-zoomed-after-toggle'))
    if (!(d1 / d0 > 0.6 && d1 / d0 < 1.6)) ok = false
    await page.close()
    return ok
  })

  // 6. compare card
  await rec('6 Compare card / remove / max 3 + toast', async (r) => {
    let ok = true
    const page = await newPage(r.errors); await dismissWhy(page); await markSeen(page)
    const pr = await projector(page)
    const [bx, by] = pr.toScreen(-49.56, -12.1)
    await tap(page, mobile, bx, by); await sleep(900)
    await tap(page, mobile, bx, by); await sleep(500) // tap the lifted shape
    const cmp = await run(page, () => ({ hidden: document.querySelector('#compare').hidden, a: document.querySelector('#cmp-a-name').textContent, b: document.querySelector('#cmp-b-name').textContent, ratio: document.querySelector('#cmp-ratio').textContent, sentence: document.querySelector('#cmp-sentence').textContent }))
    r.evidence.push(`after tapping shape: ${JSON.stringify(cmp)}`)
    if (cmp.hidden || !cmp.a || !cmp.b || !cmp.ratio) ok = false
    r.evidence.push(await shot(page, ctxName, '06-compare-card'))
    await page.click('#cmp-remove'); await sleep(400)
    const n1 = (await labels(page)).length, hidden1 = await q1(page, '#compare', e => e.hidden)
    r.evidence.push(`after Remove: labels=${n1}, compare hidden=${hidden1}`); if (n1 !== 0 || !hidden1) ok = false
    for (const q of ['Brazil', 'India', 'Australia', 'Canada']) { await pickSearch(page, q); await sleep(500) }
    const toast = await q1(page, '#toast', t => ({ hidden: t.hidden, text: t.textContent }))
    await sleep(600)
    const ls = await labels(page)
    const hash6 = await hashOf(page)
    const nGhosts = ((hash6.match(/g=([^&]*)/) || [])[1] || '').split(';').filter(Boolean)
    r.evidence.push(`after lifting 4: shapes in hash=${nGhosts.length} ${JSON.stringify(nGhosts)}; visible labels=${ls.length} ${JSON.stringify(ls.map(l => l.text.split(' · ')[0]))}; toast: ${JSON.stringify(toast)}`)
    if (ls.length !== 3) r.evidence.push('NOTE: a lifted shape has no label on screen — it sits outside the visible longitude range of this viewport')
    if (nGhosts.length !== 3 || toast.hidden || !/Three/.test(toast.text)) ok = false
    r.evidence.push(await shot(page, ctxName, '06-three-shapes-toast'))
    await page.close()
    return ok
  })

  // 7. presets
  const DST = { 'Africa': 'Africa', 'Europe': 'Europe', 'Mexico': 'Mexico', 'DR Congo': 'Dem. Rep. Congo', 'USA': 'United States of America', 'Argentina': 'Argentina', 'Madagascar': 'Madagascar', 'Tokyo': 'Tokyo', 'Jakarta': 'Jakarta', 'Singapore': 'Singapore', 'Mumbai': 'Mumbai' }
  await rec('7 Presets (every chip, every tab) + rapid clicks', async (r) => {
    let ok = true
    const page = await newPage(r.errors); await dismissWhy(page); await markSeen(page)
    for (const level of ['continent', 'country', 'city']) {
      await page.click(`[data-level="${level}"]`); await sleep(300)
      const chips = await qa(page, '#presets button[data-preset]', bs => bs.map(b => b.textContent))
      for (let i = 0; i < chips.length; i++) {
        const errBefore = r.errors.length
        const tClick = Date.now()
        await page.click(`#presets button[data-preset="${i}"]`)
        const clickMs = Date.now() - tClick
        await sleep(3500)
        const dstKey = chips[i].split('→')[1].trim(); const dst = DST[dstKey] ?? dstKey
        const ls = await labels(page)
        const hit = ls.find(l => l.text.includes(dst))
        const busy = await q1(page, `#presets button[data-preset="${i}"]`, b => b.classList.contains('busy'))
        const cmpB = await q1(page, '#cmp-b-name', e => (document.querySelector('#compare').hidden ? '(hidden)' : e.textContent))
        r.evidence.push(`${level} "${chips[i]}": ${hit ? 'OK ' + JSON.stringify(hit.text) : 'NO label mentioning ' + dst + ' — got ' + JSON.stringify(ls.map(l => l.text))}; cmp-b ${JSON.stringify(cmpB)}${busy ? ' (chip still busy)' : ''}${r.errors.length > errBefore ? ' +errors' : ''}; click ${clickMs}ms`)
        if (!hit || r.errors.length > errBefore) ok = false
        await shot(page, ctxName, `07-preset-${level}-${i}`)
      }
    }
    // rapid: country presets 0,1,2 back to back
    await page.click('[data-level="country"]'); await sleep(300)
    const chips = await qa(page, '#presets button[data-preset]', bs => bs.map(b => b.textContent))
    for (const i of [0, 1, 2]) { await page.click(`#presets button[data-preset="${i}"]`, { force: true }); await sleep(120) }
    await sleep(5000)
    const ls = await labels(page)
    const finalDst = DST[chips[2].split('→')[1].trim()]
    const busyAny = await qa(page, '#presets .busy', b => b.length)
    r.evidence.push(`rapid 0→1→2 (${chips.slice(0, 3).join(' | ')}): labels ${JSON.stringify(ls.map(l => l.text))}; busy chips left: ${busyAny}`)
    if (!ls.some(l => l.text.includes(finalDst)) || busyAny) ok = false
    // still responsive afterwards?
    await page.click(`#presets button[data-preset="3"]`); await sleep(3500)
    const ls2 = await labels(page)
    r.evidence.push(`follow-up preset "${chips[3]}": ${JSON.stringify(ls2.map(l => l.text))}`)
    if (!ls2.some(l => l.text.includes(DST[chips[3].split('→')[1].trim()]))) ok = false
    r.evidence.push(await shot(page, ctxName, '07-rapid-presets'))
    await page.close()
    return ok
  })

  // 8. city flow
  await rec('8 City flow (search Tokyo, Jakarta, drag)', async (r) => {
    let ok = true
    const page = await newPage(r.errors); await dismissWhy(page); await markSeen(page)
    await page.click('[data-level="city"]'); await sleep(200)
    const pr = await projector(page)
    const band0 = await samplePixels(page, 0, pr.insetTop, pr.width, pr.visH)
    await page.fill('#search', 'Tokyo'); await sleep(250)
    const res = await qa(page, '#results li', ls => ls.map(l => ({ name: l.querySelector('span')?.textContent, tag: l.querySelector('.tag')?.textContent })))
    r.evidence.push(`search results: ${JSON.stringify(res.slice(0, 3))}`)
    if (!res.some(x => x.name === 'Tokyo' && x.tag === 'city · Japan')) ok = false
    await page.click('#results li[data-i="0"]')
    const lbl = await waitForLabel(page, 'Tokyo', 5000); await sleep(1500)
    const lvl = await levelChecked(page)
    const band1 = await samplePixels(page, 0, pr.insetTop, pr.width, pr.visH)
    const full = (await labels(page)).map(l => l.text)
    r.evidence.push(`Tokyo label: ${lbl ? JSON.stringify(full) : 'NONE'}; hash ${await hashOf(page)}; compare: ${await run(page, () => document.querySelector('#compare').hidden ? 'hidden' : document.querySelector('#cmp-a-name').textContent + ' vs ' + document.querySelector('#cmp-b-name').textContent)}; level tab now: ${lvl}; land fraction in band ${(band0.landFrac * 100).toFixed(0)}% -> ${(band1.landFrac * 100).toFixed(0)}%`)
    r.evidence.push(`#app horizontal scroll after using search: scrollLeft=${await run(page, () => document.querySelector('#app').scrollLeft)} scrollWidth=${await run(page, () => document.querySelector('#app').scrollWidth)} vs viewport ${await run(page, () => innerWidth)}`)
    if (!lbl || !lbl.text.includes('Tokyo') || !lbl.text.includes('province')) ok = false
    r.evidence.push(await shot(page, ctxName, '08-tokyo'))
    // Jakarta
    await pickSearch(page, 'Jakarta')
    const jl = await waitForLabel(page, 'Jakarta', 5000); await sleep(1800)
    const lvl2 = await levelChecked(page)
    const ls2 = await labels(page)
    r.evidence.push(`after Jakarta: labels ${JSON.stringify(ls2.map(l => l.text))}; level tab: ${lvl2}; #reset visible: ${await q1(page, '#reset', b => !b.hidden)}`)
    if (!jl) ok = false
    if (lvl2 !== 'city') r.evidence.push('NOTE: level tab fell back to ' + lvl2 + ' — the view did not stay zoomed on a city after the second search')
    r.evidence.push(await shot(page, ctxName, '08-jakarta'))
    // drag a city ghost: the pill sits above its anchor, so grab just below the pill's anchor point
    const jk = ls2.find(l => l.text.includes('Jakarta'))
    if (jk) {
      const from = [pr.x + jk.left, pr.y + jk.top + 4]
      await drag(page, mobile, from, [from[0] + 90, from[1] + 30]); await sleep(1500)
      const ls3 = await labels(page)
      const jk2 = ls3.find(l => l.text.includes('Jakarta'))
      r.evidence.push(`drag Jakarta by (+90,+30)px: ${jk2 ? `label moved ${Math.hypot(jk2.left - jk.left, jk2.top - jk.top).toFixed(0)}px, now ${JSON.stringify(jk2.text)}` : 'label gone'}`)
      r.evidence.push(await shot(page, ctxName, '08-city-drag'))
    }
    await page.close()
    return ok
  })

  // 9. share link
  await rec('9 Share link round-trip', async (r) => {
    let ok = true
    const page = await newPage(r.errors); await dismissWhy(page); await markSeen(page)
    for (const q of ['Brazil', 'India']) { await pickSearch(page, q); await sleep(500) }
    const pr = await projector(page)
    const [bx, by] = pr.toScreen(-49.56, -12.1); const [ax, ay] = pr.toScreen(17, 6)
    await drag(page, mobile, [bx, by], [ax, ay]); await sleep(1500)
    const src = (await labels(page)).map(l => l.text)
    await page.click('#share'); await sleep(300)
    const toast = await q1(page, '#toast', t => ({ hidden: t.hidden, text: t.textContent }))
    const hash = await hashOf(page)
    let clip = null; try { clip = await run(page, () => navigator.clipboard.readText()) } catch (e) { clip = 'unreadable: ' + e.message.split('\n')[0] }
    r.evidence.push(`toast: ${JSON.stringify(toast)}; hash: ${hash}`)
    r.evidence.push(`clipboard: ${clip}`)
    if (!hash.includes('g=')) ok = false
    const c2 = await browser.newContext(ctxOpts)
    await c2.route(/gc\.zgo\.at|googletagmanager\.com/, x => x.fulfill({ status: 200, contentType: 'application/javascript', body: '' }))
    const p2 = await c2.newPage(); attachErrorCapture(p2, r.errors)
    await p2.goto(URL + hash); await waitForWorld(p2); await sleep(1500)
    const dst = (await labels(p2)).map(l => l.text)
    const why = await q1(p2, '#why', e => !e.hidden)
    r.evidence.push(`source labels: ${JSON.stringify(src)}`)
    r.evidence.push(`opened in fresh context: ${JSON.stringify(dst)}; why modal shown: ${why}; compare visible: ${await q1(p2, '#compare', e => !e.hidden)}`)
    const sameSet = dst.length === src.length && [...src].sort().every((t, i) => t === [...dst].sort()[i]) // labels are a set; DOM order is not meaningful
    if (why || !sameSet) ok = false
    r.evidence.push(await shot(p2, ctxName, '09-shared-link'))
    await c2.close(); await page.close()
    return ok
  })

  // 10. theme
  await rec('10 Theme toggle persists', async (r) => {
    const page = await newPage(r.errors); await dismissWhy(page); await markSeen(page)
    const state = () => run(page, () => ({ attr: document.documentElement.dataset.theme ?? null, scheme: getComputedStyle(document.documentElement).colorScheme, glyph: document.querySelector('#theme').textContent, stored: localStorage.getItem('theme'), bg: getComputedStyle(document.body).backgroundColor }))
    const t0 = await state()
    await page.click('#theme'); await sleep(600)
    const t1 = await state()
    r.evidence.push(await shot(page, ctxName, `10-theme-${t1.attr}`))
    await page.reload(); await waitForWorld(page)
    const t2 = await state()
    await page.click('#theme'); await sleep(600)
    const t3 = await state()
    r.evidence.push(await shot(page, ctxName, `10-theme-${t3.attr}`))
    r.evidence.push(`initial ${JSON.stringify(t0)}`)
    r.evidence.push(`after click ${JSON.stringify(t1)}`)
    r.evidence.push(`after reload ${JSON.stringify(t2)}`)
    r.evidence.push(`after 2nd click ${JSON.stringify(t3)}`)
    await page.close()
    return t1.attr !== null && t2.attr === t1.attr && t3.attr !== t1.attr && t1.scheme !== t0.scheme && t1.bg !== t0.bg
  })

  // 11. reset
  await rec('11 Reset after zoom + lift', async (r) => {
    const page = await newPage(r.errors); await dismissWhy(page); await markSeen(page)
    const pr = await projector(page)
    await pickSearch(page, 'Brazil'); await sleep(600)
    const cx = pr.x + pr.width / 2, cy = pr.y + pr.insetTop + pr.visH / 2
    await zoomIn(page, mobile, cx, cy, 4); await sleep(600)
    const resetVis = await q1(page, '#reset', b => !b.hidden)
    r.evidence.push(await shot(page, ctxName, '11-before-reset'))
    await page.click('#reset'); await sleep(2500)
    const after = { labels: (await labels(page)).length, resetHidden: await q1(page, '#reset', b => b.hidden), hint: await hintState(page), clearHidden: await q1(page, '#clear', b => b.hidden), hash: await hashOf(page) }
    r.evidence.push(`reset visible before: ${resetVis}; 2.5s after reset: ${JSON.stringify(after)}`)
    if (!after.resetHidden) { await page.click('#reset'); await sleep(1500); r.evidence.push(`pressed reset a 2nd time: #reset hidden=${await q1(page, '#reset', b => b.hidden)}`) }
    r.evidence.push(await shot(page, ctxName, '11-after-reset'))
    await page.close()
    return resetVis && after.labels === 0 && after.resetHidden && !after.hint.off && /^Tap a/.test(after.hint.text) && after.clearHidden
  })

  // 12. resize / orientation
  await rec('12 Landscape layout (mobile) / resize', async (r) => {
    const page = await newPage(r.errors); await dismissWhy(page); await markSeen(page)
    // portrait first: does any header/footer control overflow the viewport?
    const over0 = await run(page, () => [...document.querySelectorAll('.top button, .top .proj, .top h1, .level button, #search')].map(el => { const b = el.getBoundingClientRect(); return { el: el.id || el.dataset.proj || el.dataset.level || el.tagName.toLowerCase(), left: Math.round(b.left), right: Math.round(b.right), vw: innerWidth } }).filter(x => x.right > x.vw + 0.5 || x.left < -0.5))
    const app0 = await run(page, () => ({ scrollLeft: document.querySelector('#app').scrollLeft, scrollWidth: document.querySelector('#app').scrollWidth, topScrollWidth: document.querySelector('.top').scrollWidth, vw: innerWidth }))
    r.evidence.push(`portrait ${mobile ? '390x844' : '1280x800'}: header/level controls outside the viewport: ${JSON.stringify(over0)}; #app ${JSON.stringify(app0)}`)
    await page.fill('#search', 'Br'); await sleep(300); await page.keyboard.press('Escape'); await sleep(300)
    const app1 = await run(page, () => ({ scrollLeft: document.querySelector('#app').scrollLeft, h1Left: Math.round(document.querySelector('.top h1').getBoundingClientRect().left) }))
    r.evidence.push(`after focusing the search box: #app.scrollLeft=${app1.scrollLeft}, h1 left edge x=${app1.h1Left}`)
    r.evidence.push(await shot(page, ctxName, '12-portrait-after-search-focus'))
    const vp = mobile ? { width: 844, height: 390 } : { width: 900, height: 500 }
    await page.setViewportSize(vp); await sleep(800)
    const m = await run(page, () => {
      const box = (s) => { const r = document.querySelector(s).getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), h: Math.round(r.height) } }
      return { top: box('.top'), controls: box('.controls'), map: box('#map'), search: box('#search'), hint: box('#hint'), theme: box('#theme'), vw: innerWidth, vh: innerHeight, presetsScrollW: document.querySelector('.presets').scrollWidth, presetsClientW: document.querySelector('.presets').clientWidth }
    })
    const band = m.controls.top - m.top.bottom
    const overlap = m.top.bottom > m.controls.top
    r.evidence.push(`viewport ${m.vw}x${m.vh}: header ${m.top.top}-${m.top.bottom}, controls ${m.controls.top}-${m.controls.bottom}, visible map band ${band}px, header/controls overlap: ${overlap}`)
    r.evidence.push(`search ${JSON.stringify(m.search)}, theme ${JSON.stringify(m.theme)}, hint ${JSON.stringify(m.hint)}; preset row scrollW ${m.presetsScrollW} vs clientW ${m.presetsClientW}`)
    r.evidence.push(await shot(page, ctxName, '12-landscape'))
    // and a tap still lifts in landscape
    const pr = await projector(page)
    const [bx, by] = pr.toScreen(-49.56, -12.1)
    const inBand = by > pr.y + pr.insetTop && by < pr.y + pr.height - pr.insetBottom
    if (inBand) { await tap(page, mobile, bx, by); await sleep(800); r.evidence.push(`tap Brazil in landscape @(${bx | 0},${by | 0}) -> labels ${JSON.stringify((await labels(page)).map(l => l.text))}`); r.evidence.push(await shot(page, ctxName, '12-landscape-lift')) }
    else r.evidence.push(`Brazil at y=${by | 0} is under the chrome in landscape (band ${pr.y + pr.insetTop}-${pr.y + pr.height - pr.insetBottom}); tapped nothing`)
    await page.close()
    return !overlap && band >= 120 && m.controls.bottom <= m.vh && m.search.right <= m.vw && over0.length === 0 && app1.scrollLeft === 0
  })

  // 13. accessibility quick checks
  await rec('13 Accessibility: names, aria-checked, touch targets', async (r) => {
    let ok = true
    const page = await newPage(r.errors); await dismissWhy(page); await markSeen(page)
    await pickSearch(page, 'Brazil'); await sleep(600) // so #clear/#reset/#compare are visible too
    const a = await run(page, () => {
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !el.closest('[hidden]') }
      const name = (b) => (b.getAttribute('aria-label') || b.textContent.trim() || b.getAttribute('title') || '')
      const unnamed = [...document.querySelectorAll('button')].filter(b => !name(b)).map(b => b.outerHTML.slice(0, 80))
      const radios = [...document.querySelectorAll('[role="radio"]')].map(b => ({ id: b.dataset.proj ?? b.dataset.level, checked: b.getAttribute('aria-checked') }))
      const missingChecked = radios.filter(x => x.checked !== 'true' && x.checked !== 'false')
      const groups = [...document.querySelectorAll('[role="radiogroup"]')].map(g => g.getAttribute('aria-label'))
      const targets = [...document.querySelectorAll('.seg, .chip, .icon-btn')].filter(vis).map(b => { const r = b.getBoundingClientRect(); return { el: (b.className.split(' ')[0]) + ':' + (b.dataset.proj ?? b.dataset.level ?? b.id ?? b.textContent.trim().slice(0, 18)), w: +r.width.toFixed(1), h: +r.height.toFixed(1) } })
      return { unnamed, radios, missingChecked, groups, targets, coarse: matchMedia('(pointer: coarse)').matches, canvasLabel: document.querySelector('#map').getAttribute('aria-label'), whyDialog: { role: document.querySelector('#why').getAttribute('role'), modal: document.querySelector('#why').getAttribute('aria-modal'), labelledby: document.querySelector('#why').getAttribute('aria-labelledby') }, searchLabel: document.querySelector('#search').getAttribute('aria-label') || document.querySelector('label[for="search"]')?.textContent || ('placeholder only: ' + document.querySelector('#search').placeholder) }
    })
    r.evidence.push(`buttons without accessible name: ${a.unnamed.length} ${JSON.stringify(a.unnamed)}`); if (a.unnamed.length) ok = false
    r.evidence.push(`radios: ${JSON.stringify(a.radios)}; missing aria-checked: ${a.missingChecked.length}; radiogroup labels: ${JSON.stringify(a.groups)}`); if (a.missingChecked.length) ok = false
    const small = a.targets.filter(t => t.h < 40)
    r.evidence.push(`pointer:coarse=${a.coarse}; targets: ${JSON.stringify(a.targets)}`)
    r.evidence.push(`targets under 40px tall: ${small.length} ${JSON.stringify(small)}`)
    if (mobile && small.length) ok = false
    r.evidence.push(`canvas aria-label: ${JSON.stringify(a.canvasLabel)}; why dialog: ${JSON.stringify(a.whyDialog)}; search accessible name: ${JSON.stringify(a.searchLabel)}`)
    await page.close()
    return ok
  })

  await context.close()
}

// ------------------------------------------------------------------ main
const browser = await chromium.launch()
const iphone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' }
const desktop = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, hasTouch: false, isMobile: false }
const onlyCtx = process.env.TSM_CTX // 'mobile' | 'desktop' to run one
if (!onlyCtx || onlyCtx === 'mobile') await runContext(browser, 'mobile', iphone, true)
if (!onlyCtx || onlyCtx === 'desktop') await runContext(browser, 'desktop', desktop, false)
await browser.close()

// ------------------------------------------------------------------ report
const names = [...new Set(results.map(r => r.scenario))]
const cell = (r) => r ? (r.pass ? 'PASS' : 'FAIL') + (r.errors.length ? ` (${[...new Set(r.errors)].length} err)` : '') : 'n/a'
let md = `# truesizemap e2e report\n\nURL: ${URL} · ${new Date().toISOString()}\n\n| Scenario | Mobile | Desktop |\n|---|---|---|\n`
for (const n of names) md += `| ${n} | ${cell(results.find(r => r.scenario === n && r.ctx === 'mobile'))} | ${cell(results.find(r => r.scenario === n && r.ctx === 'desktop'))} |\n`
md += '\n## Evidence\n'
for (const r of results) {
  md += `\n### [${r.ctx}] ${r.scenario} — ${r.pass ? 'PASS' : 'FAIL'}\n`
  for (const e of r.evidence) md += `- ${e}\n`
  if (r.errors.length) md += `- errors:\n` + [...new Set(r.errors)].map(e => `  - ${e}\n`).join('')
}
fs.writeFileSync(path.join(here, 'report.md'), md)
console.log('\nreport: tests/report.md')
