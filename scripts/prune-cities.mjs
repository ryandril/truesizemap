// Keep only major cities whose boundary data we trust. Reads the full index the pipeline wrote to
// data/cities-index.json and writes the pruned src/assets/cities.json; boundary files for dropped cities are
// removed from public/cities (the full set stays reproducible from the cache). Run: node scripts/prune-cities.mjs
import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync } from 'node:fs'
const ROOT = new URL('../', import.meta.url)
const P = (r) => new URL(r, ROOT)
const all = JSON.parse(readFileSync(P('data/cities-index.json'), 'utf8'))
const MIN_POP = 1_000_000, CAPITAL_MIN_POP = 300_000, MAX_AREA = 40_000
const keep = all.filter(c => {
  const big = c.pop >= MIN_POP || (c.cap && c.pop >= CAPITAL_MIN_POP)
  if (!big) return false
  if (c.a > MAX_AREA) return false            // a whole province matched instead of the city
  if (c.a < 15) return false                   // an old-town district matched instead of the city
  if (c.pop >= 2_000_000 && c.a < 60) return false // metropolis mapped to a tiny core
  return true
}).map(({ src, ...row }) => row)
writeFileSync(P('src/assets/cities.json'), JSON.stringify(keep))
const ids = new Set(keep.map(c => c.id))
let removed = 0
for (const f of readdirSync(P('public/cities/'))) if (!ids.has(f.replace('.json', ''))) { unlinkSync(P('public/cities/' + f)); removed++ }
const dropped = all.filter(c => !ids.has(c.id))
const lines = [`# Pruned city set`, ``, `Kept **${keep.length}** of ${all.length} (pop ≥ ${MIN_POP.toLocaleString()}, or capitals ≥ ${CAPITAL_MIN_POP.toLocaleString()}; area 15–${MAX_AREA.toLocaleString()} km²).`, ``,
  `## Dropped despite population ≥ 1M (data looked wrong)`, ``, `| City | Country | Pop | Area km² | Definition |`, `|---|---|---|---|---|`,
  ...dropped.filter(c => c.pop >= MIN_POP).sort((a, b) => b.pop - a.pop).map(c => `| ${c.n} | ${c.c} | ${c.pop.toLocaleString()} | ${c.a.toLocaleString()} | ${c.def ?? ''} |`)]
writeFileSync(P('data/cities-pruned.md'), lines.join('\n') + '\n')
console.log(`kept ${keep.length} of ${all.length}; removed ${removed} boundary files; ${dropped.filter(c => c.pop >= MIN_POP).length} big cities dropped for bad data → data/cities-pruned.md`)
