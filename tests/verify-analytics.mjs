// Proves every analytics event is wired to the control that should fire it. Run against the dev server;
// track() records into a dev-only log there, and sends to Google Analytics only on the real site.
import { chromium } from 'playwright'
const b = await chromium.launch()
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] })
const page = await ctx.newPage()
const errs = []; page.on('pageerror', e => errs.push(String(e)))
await page.goto('http://localhost:5177/'); await page.waitForTimeout(2600)
const log = () => page.evaluate(() => window.__tsm.trackLog.map(e => e.name + ' ' + JSON.stringify(e.params)))
const since = async (n) => (await log()).slice(n)

console.log('first visit  :', (await log()).join(' | ') || '(none)')
let n = (await log()).length
await page.click('#why-try'); await page.waitForTimeout(3500)
console.log('“Show me”    :', (await since(n)).join(' | ')); n = (await log()).length

await page.click('[data-proj="equalearth"]'); await page.waitForTimeout(1800)
console.log('projection   :', (await since(n)).join(' | ')); n = (await log()).length
await page.click('[data-proj="mercator"]'); await page.waitForTimeout(1800); n = (await log()).length

await page.evaluate(() => document.querySelector('#clear').click()); await page.waitForTimeout(400)
await page.evaluate(() => window.__tsm.trackLog.length && 0); await page.fill('#search', 'Brazil'); await page.waitForTimeout(500); await page.keyboard.press('Enter'); await page.waitForTimeout(2000)
console.log('search lift  :', (await since(n)).join(' | ')); n = (await log()).length

// drag Brazil onto a definite landmass, so the pair is real
const [sx, sy] = await page.evaluate(() => window.__tsm.project(window.__tsm.ghosts[0].anchor).map(Math.round))
const [tx, ty] = await page.evaluate(() => window.__tsm.project(window.__tsm.world.byId.get('DZA').label).map(Math.round))
await page.mouse.move(sx, sy); await page.mouse.down()
for (let i = 1; i <= 16; i++) await page.mouse.move(sx + (tx - sx) * i / 16, sy + (ty - sy) * i / 16)
await page.mouse.up(); await page.waitForTimeout(1400)
const dragged = await since(n)
console.log('drag+compare :', dragged.join(' | ') || '(same pair as the preset — de-duplicated)')
console.log('  card shows :', await page.evaluate(() => document.querySelector('#cmp-b-name').textContent))
n = (await log()).length

await page.click('#share'); await page.waitForTimeout(500)
console.log('copy link    :', (await since(n)).join(' | ')); n = (await log()).length
await page.click('#theme'); await page.waitForTimeout(600)
console.log('theme        :', (await since(n)).join(' | ')); n = (await log()).length
await page.click('#why-btn'); await page.waitForTimeout(600)
console.log('why button   :', (await since(n)).join(' | '))

const names = new Set((await log()).map(l => l.split(' ')[0]))
const want = ['open_why', 'why_show_me', 'use_preset', 'lift_shape', 'compare', 'switch_projection', 'copy_link', 'switch_theme']
console.log('\nfired:', [...names].sort().join(', '))
console.log('missing:', want.filter(w => !names.has(w)).join(', ') || 'none')
console.log('page errors:', errs.length ? errs : 'none')
await b.close()
