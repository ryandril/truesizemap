// Reproduce: drag a shape and release; watch what the anchor does afterwards.
// Runs against the DEV server (port 5177) so the __tsm debug hook is available.
import { chromium } from 'playwright'
const URL = 'http://localhost:5177/'
const b = await chromium.launch()
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } })
const page = await ctx.newPage()
const errs = []
page.on('pageerror', e => errs.push(String(e)))
await page.goto(URL); await page.waitForTimeout(2500)
await page.evaluate(() => { try { localStorage.setItem('seenWhy', '1') } catch {} })
await page.reload(); await page.waitForTimeout(2500)

const state = () => page.evaluate(() => {
  const g = window.__tsm?.ghosts?.[0]
  if (!g) return null
  return {
    anchor: g.anchor.map(v => +v.toFixed(2)),
    sx: { x: +g.sx.x.toFixed(2), t: +g.sx.target.toFixed(2), v: +g.sx.v.toFixed(2), done: g.sx.done },
    sy: { x: +g.sy.x.toFixed(2), t: +g.sy.target.toFixed(2), v: +g.sy.v.toFixed(2), done: g.sy.done },
    label: document.querySelector('.label')?.textContent ?? null,
    ghosts: window.__tsm.ghosts.length,
  }
})

// continent level, lift Africa by clicking on it
await page.click('[data-level="continent"]')
await page.waitForTimeout(400)
// Africa centre on a 1280x800 mercator world ~ (10E, 5N); find its pixel via the debug projection
const africaPx = await page.evaluate(() => window.__tsm.project([20, 5]).map(Math.round))
console.log('africa px', africaPx)
await page.mouse.click(africaPx[0], africaPx[1])
await page.waitForTimeout(1200)
console.log('after lift  ', JSON.stringify(await state()))

// drag it to the middle of Asia (~90E, 45N), slowly, then release without moving
const asiaPx = await page.evaluate(() => window.__tsm.project([90, 45]).map(Math.round))
console.log('asia px', asiaPx)
await page.mouse.move(africaPx[0], africaPx[1])
await page.mouse.down()
const STEPS = Number(process.env.STEPS ?? 25), GAP = Number(process.env.GAP ?? 20)
for (let i = 1; i <= STEPS; i++) {
  const x = africaPx[0] + (asiaPx[0] - africaPx[0]) * i / STEPS
  const y = africaPx[1] + (asiaPx[1] - africaPx[1]) * i / STEPS
  await page.mouse.move(x, y)
  if (GAP) await page.waitForTimeout(GAP)
}
const atRelease = await state()
console.log('at release  ', JSON.stringify(atRelease))
await page.mouse.up()
for (const ms of [50, 150, 300, 600, 1000, 1600, 2400]) {
  await page.waitForTimeout(ms === 50 ? 50 : 0)
  if (ms !== 50) await page.waitForTimeout(ms - 50)
  console.log(`+${String(ms).padStart(4)}ms  `, JSON.stringify(await state()))
}
console.log('pageerrors:', errs)
await b.close()
