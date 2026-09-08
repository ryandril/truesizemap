// Measure how smooth the Greenland → Africa preset is: sample the ghost's SCREEN position every animation
// frame and report the per-frame pixel step. Smooth motion = a gentle ramp up and down with no spikes or stalls.
import { chromium } from 'playwright'
const b = await chromium.launch()
const page = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
const errs = []; page.on('pageerror', e => errs.push(String(e)))
await page.goto('http://localhost:5177/'); await page.waitForTimeout(2500)
await page.evaluate(() => { try { localStorage.setItem('seenWhy', '1') } catch {} })
await page.reload(); await page.waitForTimeout(2500)

const samples = await page.evaluate(async () => {
  const out = []
  let stop = false
  const tick = () => {
    const g = window.__tsm?.ghosts?.[0]
    const p = g && window.__tsm.project(g.anchor)
    out.push({ t: performance.now(), n: window.__tsm?.ghosts?.length ?? -1,
      x: p ? +p[0].toFixed(1) : null, y: p ? +p[1].toFixed(1) : null,
      gl: g ? !!g.glide : null, pxx: g?.px ? +g.px.x.toFixed(0) : null, pxt: g?.px ? +g.px.target.toFixed(0) : null })
    if (!stop) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  document.querySelector('[data-level="continent"]').click()
  await new Promise(r => setTimeout(r, 300))
  document.querySelector('#presets [data-preset="0"]').click()
  await new Promise(r => setTimeout(r, 2600))
  stop = true
  const g = window.__tsm.ghosts[0]
  return { out, end: { anchor: g?.anchor, px: g && window.__tsm.project(g.anchor), label: document.querySelector('.label')?.textContent },
           home: { grl: window.__tsm.world.byId.get('GRL').label, af: window.__tsm.world.byId.get('AF').label,
                   grlPx: window.__tsm.project(window.__tsm.world.byId.get('GRL').label), afPx: window.__tsm.project(window.__tsm.world.byId.get('AF').label) } }
})
const { out, end, home } = samples
console.log('home:', JSON.stringify(home))
console.log('end :', JSON.stringify(end))
const moving = out.filter(s => s.x !== null)
const steps = []
for (let i = 1; i < moving.length; i++) {
  const d = Math.hypot(moving[i].x - moving[i-1].x, moving[i].y - moving[i-1].y)
  const dt = moving[i].t - moving[i-1].t
  if (d > 0.01) steps.push({ d: +d.toFixed(1), dt: +dt.toFixed(1) })
}
const px = steps.map(s => s.d), gaps = steps.map(s => s.dt)
const pct = (a, p) => a.slice().sort((x, y) => x - y)[Math.floor(a.length * p)]
const allGaps = out.slice(1).map((s,i)=>+(s.t-out[i].t).toFixed(1))
const worst = allGaps.map((g,i)=>({g,i})).sort((a,b)=>b.g-a.g).slice(0,6)
console.log('ALL-frame gaps ms  max 6 :', worst.map(w=>`${w.g}ms@frame${w.i}`).join(' '))
console.log('raw first 34:', out.slice(0,26).map(s=>`n${s.n}${s.x===null?'·':`@${s.x},${s.y}`}${s.gl?`>${s.pxx}/${s.pxt}`:''}`).join('  '))
console.log('frames sampled          :', out.length)
console.log('frames with movement    :', steps.length)
console.log('frame gap ms  med/p95/max:', pct(gaps, .5), '/', pct(gaps, .95), '/', Math.max(...gaps).toFixed(1))
console.log('px per frame  med/p95/max:', pct(px, .5), '/', pct(px, .95), '/', Math.max(...px))
console.log('travel px total          :', px.reduce((a, c) => a + c, 0).toFixed(0))
console.log('start px                :', moving[0]?.x, moving[0]?.y, '→ end px:', moving.at(-1)?.x, moving.at(-1)?.y)
console.log('first 8 steps px         :', px.slice(0, 8).join(' '))
console.log('last 8 steps px          :', px.slice(-8).join(' '))
console.log('pageerrors:', errs)
await b.close()
