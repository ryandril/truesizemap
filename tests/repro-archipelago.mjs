// Regression: dragging an archipelago (Indonesia) onto Russia used to leave a second, unwanted Russia shape.
// A press 40px off Indonesia's centre lands in the sea between its islands, so the release point fell outside
// the shape and the browser's synthetic click lifted whatever was underneath. Run against the dev server.
import { chromium } from 'playwright'
const b = await chromium.launch()
const page = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
const errs = []; page.on('pageerror', e => errs.push(String(e)))
await page.goto('http://localhost:5177/'); await page.waitForTimeout(2500)
await page.evaluate(() => { try { localStorage.setItem('seenWhy','1') } catch {} })
await page.reload(); await page.waitForTimeout(2500)
for (const [ox, oy] of [[0,0],[40,0],[-40,0],[25,-25],[80,10]]) {
  await page.evaluate(() => document.querySelector('#clear')?.click()); await page.waitForTimeout(200)
  await page.fill('#search', ''); await page.type('#search', 'Indone'); await page.waitForTimeout(400)
  await page.keyboard.press('Enter'); await page.waitForTimeout(1500)
  const [sx, sy] = await page.evaluate(() => window.__tsm.project(window.__tsm.ghosts[0].anchor).map(Math.round))
  const [rx, ry] = await page.evaluate(() => window.__tsm.project(window.__tsm.world.byId.get('RUS').label).map(Math.round))
  const grabbed = await page.evaluate(([x, y]) => !!window.__tsm.ghostAtPx([x, y]), [sx+ox, sy+oy])
  await page.mouse.move(sx+ox, sy+oy); await page.mouse.down()
  for (let i = 1; i <= 16; i++) await page.mouse.move(sx+ox+(rx-sx)*i/16, sy+oy+(ry-sy)*i/16)
  await page.mouse.up(); await page.waitForTimeout(900)
  const after = await page.evaluate(() => ({ n: window.__tsm.ghosts.length, names: window.__tsm.ghosts.map(g => g.place.name) }))
  console.log(`grab offset (${ox},${oy})  grabbable=${grabbed}  →  ghosts after drop: ${after.n} ${JSON.stringify(after.names)}`)
}
console.log('errors:', errs)
await b.close()
