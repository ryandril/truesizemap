# truesizemap e2e report

URL: http://localhost:4173/ · 2026-09-08T04:35:44.069Z

| Scenario | Mobile | Desktop |
|---|---|---|
| 1 First visit / Why modal / demo | PASS | PASS |
| 2 Tap to lift (Country tab) | PASS | PASS |
| 3 Drag shape; base map stays put | PASS | PASS |
| 4 Pan / pinch-zoom / pole limits / endless E-W | PASS | PASS |
| 5 Projection toggle (morph, hash, zoom preserved) | PASS | PASS |
| 6 Compare card / remove / max 3 + toast | PASS | PASS |
| 7 Presets (every chip, every tab) + rapid clicks | PASS | PASS |
| 8 City flow (search Tokyo, Jakarta, drag) | PASS | PASS |
| 9 Share link round-trip | PASS | PASS |
| 10 Theme toggle persists | PASS | PASS |
| 11 Reset after zoom + lift | PASS | PASS |
| 12 Landscape layout (mobile) / resize | PASS | PASS |
| 13 Accessibility: names, aria-checked, touch targets | PASS | PASS |

## Evidence

### [mobile] 1 First visit / Why modal / demo — PASS
- modal appeared within 1.5s: true
- tests/shots/mobile-01-why-modal.png
- hidden after 'Just explore': true
- reappeared after reload: false (localStorage seenWhy=1)
- 'Why?' reopens: true
- first label seen: "Greenland · 8.9% of North America"; compare card appeared 697ms after the label read "of Africa"
- demo label: "Greenland · 7.2% of Africa"; compare visible: true; cmp-b: "Africa"
- tests/shots/mobile-01-demo-greenland-africa.png

### [mobile] 2 Tap to lift (Country tab) — PASS
- tap Brazil @(73,453) -> labels: ["Brazil · 8.50M km²"]
- hint: {"text":"Drag it anywhere · tap to compare","off":true}
- tests/shots/mobile-02-tap-lift.png

### [mobile] 3 Drag shape; base map stays put — PASS
- label before: "Brazil · 8.50M km²" @(79,442)
- label after:  "Brazil · 14× the size of Central African Rep." @(209,405)
- base-map probe (80x80 px around India) changed pixels: 0/25600
- tests/shots/mobile-03-after-drag.png
- label moved: true; ratio text changed: true; hash: #m=w&g=BRA@17.00,6.00

### [mobile] 4 Pan / pinch-zoom / pole limits / endless E-W — PASS
- level after deep zoom: city; distinct colours in band 112 -> 125
- tests/shots/mobile-04-zoomed-in.png
- level after zoom out: country
- after 6 downward pans: top row of the visible band opaque 4440/4440 px (map still covers the top edge: true)
- tests/shots/mobile-04-pan-north-limit.png
- after 2 rightward pans (660px): land fraction 45.2%, opaque 1017120/1017120
- tests/shots/mobile-04-pan-east-west-2.png
- after 10 rightward pans (3300px total): land fraction 35.2%, opaque 1017120/1017120; tap on the blank map lifts anything? 0 labels
- tests/shots/mobile-04-pan-east-west.png

### [mobile] 5 Projection toggle (morph, hash, zoom preserved) — PASS
- morph frames differ: 0-1 true, 1-2 true
- stable after morph: true
- hash: #m=e; aria-checked equalearth: true
- tests/shots/mobile-05-equal-earth.png
- hash after toggling back: #m=w
- tests/shots/mobile-05-zoomed-before-toggle.png
- zoomed toggle: labels ["Egypt","Libya"] spacing 55px -> 46px (ratio 0.84); level country -> country; hash #m=e&g=EGY@29.45,26.19;LBY@18.01,26.64&l=country
- tests/shots/mobile-05-zoomed-after-toggle.png

### [mobile] 6 Compare card / remove / max 3 + toast — PASS
- after tapping shape: {"hidden":false,"a":"Brazil","b":"Home","ratio":"1×","sentence":"Brazil is where it belongs. Drag it onto another place to compare."}
- tests/shots/mobile-06-compare-card.png
- after Remove: labels=0, compare hidden=true
- after lifting 4: shapes in hash=3 ["IND@79.36,22.69","AUS@134.05,-24.13","CAN@-101.91,60.32"]; visible labels=1 ["Canada"]; toast: {"hidden":false,"text":"Three at a time — oldest removed"}
- NOTE: a lifted shape has no label on screen — it sits outside the visible longitude range of this viewport
- tests/shots/mobile-06-three-shapes-toast.png

### [mobile] 7 Presets (every chip, every tab) + rapid clicks — PASS
- continent "Greenland → Africa": OK "Greenland · 7.2% of Africa"; cmp-b "Africa"; click 64ms
- continent "Europe → Africa": OK "Europe · 33% of Africa"; cmp-b "Africa"; click 22ms
- continent "Antarctica → Africa": OK "Antarctica · 41% of Africa"; cmp-b "Africa"; click 36ms
- continent "Oceania → Europe": OK "Oceania · 87% of Europe"; cmp-b "Europe"; click 30ms
- country "Alaska → Mexico": OK "Alaska · 76% of Mexico"; cmp-b "Mexico"; click 26ms
- country "Greenland → DR Congo": OK "Greenland · 92% of Dem. Rep. Congo"; cmp-b "Dem. Rep. Congo"; click 29ms
- country "Australia → USA": OK "Australia · 82% of United States of America"; cmp-b "United States of America"; click 28ms
- country "India → Argentina": OK "India · 1.1× the size of Argentina"; cmp-b "Argentina"; click 24ms
- country "Japan → Madagascar": OK "Japan · 62% of Madagascar"; cmp-b "Madagascar"; click 25ms
- city "New York → Tokyo": OK "New York City · city · 33% of Tokyo"; cmp-b "Tokyo"; click 27ms
- city "London → Jakarta": OK "London · administrative area · 2.3× the size of Jakarta"; cmp-b "Jakarta"; click 139ms
- city "Shanghai → Singapore": OK "Shanghai · province-level · 14× the size of Singapore"; cmp-b "Singapore"; click 133ms
- city "Mexico City → Mumbai": OK "Mexico City · state · 3.7× the size of Mumbai"; cmp-b "Mumbai"; click 37ms
- rapid 0→1→2 (Alaska → Mexico | Greenland → DR Congo | Australia → USA): labels ["Australia · 82% of United States of America"]; busy chips left: 0
- follow-up preset "India → Argentina": ["India · 1.1× the size of Argentina"]
- tests/shots/mobile-07-rapid-presets.png

### [mobile] 8 City flow (search Tokyo, Jakarta, drag) — PASS
- search results: [{"name":"Tokyo","tag":"city · Japan"}]
- Tokyo label: ["Tokyo · province · 0.61% of Japan"]; hash #m=w&g=Q1490@139.75,35.69&l=city; compare: Tokyo vs Japan; level tab now: city; land fraction in band 45% -> 44%
- #app horizontal scroll after using search: scrollLeft=0 scrollWidth=390 vs viewport 390
- tests/shots/mobile-08-tokyo.png
- after Jakarta: labels ["Jakarta · province · 0.04% of Indonesia"]; level tab: city; #reset visible: true
- tests/shots/mobile-08-jakarta.png
- drag Jakarta by (+90,+30)px: label moved 55px, now "Jakarta · province · 0.04% of Indonesia"
- tests/shots/mobile-08-city-drag.png

### [mobile] 9 Share link round-trip — PASS
- toast: {"hidden":false,"text":"Link copied — it opens on this exact view"}; hash: #m=w&g=IND@79.36,22.69;BRA@17.00,6.00&l=country
- clipboard: http://localhost:4173/#m=w&g=IND@79.36,22.69;BRA@17.00,6.00&l=country
- source labels: ["Brazil · 14× the size of Central African Rep.","India · 3.16M km²"]
- opened in fresh context: ["India · 3.16M km²","Brazil · 14× the size of Central African Rep."]; why modal shown: false; compare visible: true
- tests/shots/mobile-09-shared-link.png

### [mobile] 10 Theme toggle persists — PASS
- tests/shots/mobile-10-theme-dark.png
- tests/shots/mobile-10-theme-light.png
- initial {"attr":null,"scheme":"light","glyph":"☾","stored":null,"bg":"rgb(245, 245, 247)"}
- after click {"attr":"dark","scheme":"dark","glyph":"☀","stored":"dark","bg":"rgb(11, 13, 18)"}
- after reload {"attr":"dark","scheme":"dark","glyph":"☀","stored":"dark","bg":"rgb(11, 13, 18)"}
- after 2nd click {"attr":"light","scheme":"light","glyph":"☾","stored":"light","bg":"rgb(245, 245, 247)"}

### [mobile] 11 Reset after zoom + lift — PASS
- tests/shots/mobile-11-before-reset.png
- reset visible before: true; 2.5s after reset: {"labels":0,"resetHidden":true,"hint":{"text":"Tap a country, then drag it","off":false},"clearHidden":true,"hash":"#m=w&l=country"}
- tests/shots/mobile-11-after-reset.png

### [mobile] 12 Landscape layout (mobile) / resize — PASS
- portrait 390x844: header/level controls outside the viewport: []; #app {"scrollLeft":0,"scrollWidth":390,"topScrollWidth":390,"vw":390}
- after focusing the search box: #app.scrollLeft=0, h1 left edge x=10
- tests/shots/mobile-12-portrait-after-search-focus.png
- viewport 844x390: header 0-62, controls 259-390, visible map band 197px, header/controls overlap: false
- search {"top":268,"bottom":312,"left":251,"right":830,"h":44}, theme {"top":9,"bottom":53,"left":786,"right":830,"h":44}, hint {"top":0,"bottom":0,"left":0,"right":0,"h":0}; preset row scrollW 0 vs clientW 0
- tests/shots/mobile-12-landscape.png
- tap Brazil in landscape @(308,216) -> labels ["Brazil · 8.50M km²"]
- tests/shots/mobile-12-landscape-lift.png

### [mobile] 13 Accessibility: names, aria-checked, touch targets — PASS
- buttons without accessible name: 0 []
- radios: [{"id":"mercator","checked":"true"},{"id":"equalearth","checked":"false"},{"id":"city","checked":"false"},{"id":"country","checked":"true"},{"id":"continent","checked":"false"}]; missing aria-checked: 0; radiogroup labels: ["Map projection","What to pick up"]
- pointer:coarse=true; targets: [{"el":"icon-btn:reset","w":44,"h":44},{"el":"chip:clear","w":116.1,"h":43.4},{"el":"seg:mercator","w":71,"h":41.9},{"el":"seg:equalearth","w":90.9,"h":41.9},{"el":"icon-btn:theme","w":40,"h":40},{"el":"seg:city","w":53.9,"h":43.4},{"el":"seg:country","w":76.3,"h":43.4},{"el":"seg:continent","w":91.2,"h":43.4},{"el":"chip:","w":138.2,"h":43.4},{"el":"chip:","w":174.9,"h":43.4},{"el":"chip:","w":138.2,"h":43.4},{"el":"chip:","w":152.9,"h":43.4},{"el":"chip:","w":160.2,"h":43.4},{"el":"chip:share","w":94.1,"h":43.4}]
- targets under 40px tall: 0 []
- canvas aria-label: "World map. Tap a place to lift a copy, then drag it."; why dialog: {"role":"dialog","modal":"true","labelledby":"why-title"}; search accessible name: "Search a city, country or continent"

### [desktop] 1 First visit / Why modal / demo — PASS
- modal appeared within 1.5s: true
- tests/shots/desktop-01-why-modal.png
- hidden after 'Just explore': true
- reappeared after reload: false (localStorage seenWhy=1)
- 'Why?' reopens: true
- first label seen: "Greenland · 8.9% of North America"; compare card appeared 719ms after the label read "of Africa"
- demo label: "Greenland · 7.2% of Africa"; compare visible: true; cmp-b: "Africa"
- tests/shots/desktop-01-demo-greenland-africa.png

### [desktop] 2 Tap to lift (Country tab) — PASS
- tap Brazil @(465,449) -> labels: ["Brazil · 8.50M km²"]
- hint: {"text":"Drag it anywhere · tap to compare","off":true}
- tests/shots/desktop-02-tap-lift.png

### [desktop] 3 Drag shape; base map stays put — PASS
- label before: "Brazil · 8.50M km²" @(466,437)
- label after:  "Brazil · 14× the size of Central African Rep." @(700,373)
- base-map probe (80x80 px around India) changed pixels: 0/6400
- tests/shots/desktop-03-after-drag.png
- label moved: true; ratio text changed: true; hash: #m=w&g=BRA@17.00,6.00

### [desktop] 4 Pan / pinch-zoom / pole limits / endless E-W — PASS
- level after deep zoom: city; distinct colours in band 135 -> 245
- tests/shots/desktop-04-zoomed-in.png
- level after zoom out: country
- after 6 downward pans: top row of the visible band opaque 3780/3780 px (map still covers the top edge: true)
- tests/shots/desktop-04-pan-north-limit.png
- after 2 rightward pans (2440px): land fraction 41.3%, opaque 727040/727040
- tests/shots/desktop-04-pan-east-west-2.png
- after 10 rightward pans (12200px total): land fraction 41.5%, opaque 727040/727040; tap on the blank map lifts anything? 1 labels
- tests/shots/desktop-04-pan-east-west.png

### [desktop] 5 Projection toggle (morph, hash, zoom preserved) — PASS
- morph frames differ: 0-1 true, 1-2 true
- stable after morph: true
- hash: #m=e; aria-checked equalearth: true
- tests/shots/desktop-05-equal-earth.png
- hash after toggling back: #m=w
- tests/shots/desktop-05-zoomed-before-toggle.png
- zoomed toggle: labels ["Egypt","Libya"] spacing 161px -> 138px (ratio 0.86); level country -> country; hash #m=e&g=EGY@29.45,26.19;LBY@18.01,26.64&l=country
- tests/shots/desktop-05-zoomed-after-toggle.png

### [desktop] 6 Compare card / remove / max 3 + toast — PASS
- after tapping shape: {"hidden":false,"a":"Brazil","b":"Home","ratio":"1×","sentence":"Brazil is where it belongs. Drag it onto another place to compare."}
- tests/shots/desktop-06-compare-card.png
- after Remove: labels=0, compare hidden=true
- after lifting 4: shapes in hash=3 ["IND@79.36,22.69","AUS@134.05,-24.13","CAN@-101.91,60.32"]; visible labels=3 ["India","Australia","Canada"]; toast: {"hidden":false,"text":"Three at a time — oldest removed"}
- tests/shots/desktop-06-three-shapes-toast.png

### [desktop] 7 Presets (every chip, every tab) + rapid clicks — PASS
- continent "Greenland → Africa": OK "Greenland · 7.2% of Africa"; cmp-b "Africa"; click 70ms
- continent "Europe → Africa": OK "Europe · 33% of Africa"; cmp-b "Africa"; click 21ms
- continent "Antarctica → Africa": OK "Antarctica · 41% of Africa"; cmp-b "Africa"; click 34ms
- continent "Oceania → Europe": OK "Oceania · 87% of Europe"; cmp-b "Europe"; click 26ms
- country "Alaska → Mexico": OK "Alaska · 76% of Mexico"; cmp-b "Mexico"; click 31ms
- country "Greenland → DR Congo": OK "Greenland · 92% of Dem. Rep. Congo"; cmp-b "Dem. Rep. Congo"; click 59ms
- country "Australia → USA": OK "Australia · 82% of United States of America"; cmp-b "United States of America"; click 37ms
- country "India → Argentina": OK "India · 1.1× the size of Argentina"; cmp-b "Argentina"; click 36ms
- country "Japan → Madagascar": OK "Japan · 62% of Madagascar"; cmp-b "Madagascar"; click 32ms
- city "New York → Tokyo": OK "New York City · city · 33% of Tokyo"; cmp-b "Tokyo"; click 25ms
- city "London → Jakarta": OK "London · administrative area · 2.3× the size of Jakarta"; cmp-b "Jakarta"; click 33ms
- city "Shanghai → Singapore": OK "Shanghai · province-level · 14× the size of Singapore"; cmp-b "Singapore"; click 28ms
- city "Mexico City → Mumbai": OK "Mexico City · state · 3.7× the size of Mumbai"; cmp-b "Mumbai"; click 31ms
- rapid 0→1→2 (Alaska → Mexico | Greenland → DR Congo | Australia → USA): labels ["Australia · 82% of United States of America"]; busy chips left: 0
- follow-up preset "India → Argentina": ["India · 1.1× the size of Argentina"]
- tests/shots/desktop-07-rapid-presets.png

### [desktop] 8 City flow (search Tokyo, Jakarta, drag) — PASS
- search results: [{"name":"Tokyo","tag":"city · Japan"}]
- Tokyo label: ["Tokyo · province · 0.61% of Japan"]; hash #m=w&g=Q1490@139.75,35.69&l=city; compare: Tokyo vs Japan; level tab now: city; land fraction in band 40% -> 42%
- #app horizontal scroll after using search: scrollLeft=0 scrollWidth=1280 vs viewport 1280
- tests/shots/desktop-08-tokyo.png
- after Jakarta: labels ["Jakarta · province · 0.04% of Indonesia"]; level tab: city; #reset visible: true
- tests/shots/desktop-08-jakarta.png
- drag Jakarta by (+90,+30)px: label moved 95px, now "Jakarta · province · 0.04% of Indonesia"
- tests/shots/desktop-08-city-drag.png

### [desktop] 9 Share link round-trip — PASS
- toast: {"hidden":false,"text":"Link copied — it opens on this exact view"}; hash: #m=w&g=IND@79.36,22.69;BRA@17.00,6.00&l=country
- clipboard: http://localhost:4173/#m=w&g=IND@79.36,22.69;BRA@17.00,6.00&l=country
- source labels: ["Brazil · 14× the size of Central African Rep.","India · 3.16M km²"]
- opened in fresh context: ["India · 3.16M km²","Brazil · 14× the size of Central African Rep."]; why modal shown: false; compare visible: true
- tests/shots/desktop-09-shared-link.png

### [desktop] 10 Theme toggle persists — PASS
- tests/shots/desktop-10-theme-dark.png
- tests/shots/desktop-10-theme-light.png
- initial {"attr":null,"scheme":"light","glyph":"☾","stored":null,"bg":"rgb(245, 245, 247)"}
- after click {"attr":"dark","scheme":"dark","glyph":"☀","stored":"dark","bg":"rgb(16, 18, 23)"}
- after reload {"attr":"dark","scheme":"dark","glyph":"☀","stored":"dark","bg":"rgb(11, 13, 18)"}
- after 2nd click {"attr":"light","scheme":"light","glyph":"☾","stored":"light","bg":"rgb(240, 240, 242)"}

### [desktop] 11 Reset after zoom + lift — PASS
- tests/shots/desktop-11-before-reset.png
- reset visible before: true; 2.5s after reset: {"labels":0,"resetHidden":true,"hint":{"text":"Tap a country, then drag it","off":false},"clearHidden":true,"hash":"#m=w&l=country"}
- tests/shots/desktop-11-after-reset.png

### [desktop] 12 Landscape layout (mobile) / resize — PASS
- portrait 1280x800: header/level controls outside the viewport: []; #app {"scrollLeft":0,"scrollWidth":1280,"topScrollWidth":1280,"vw":1280}
- after focusing the search box: #app.scrollLeft=0, h1 left edge x=24
- tests/shots/desktop-12-portrait-after-search-focus.png
- viewport 900x500: header 0-80, controls 332-500, visible map band 252px, header/controls overlap: false
- search {"top":345,"bottom":381,"left":273,"right":876,"h":36}, theme {"top":19,"bottom":53,"left":842,"right":876,"h":34}, hint {"top":90,"bottom":120,"left":346,"right":554,"h":30}; preset row scrollW 878 vs clientW 852
- tests/shots/desktop-12-landscape.png
- tap Brazil in landscape @(328,265) -> labels ["Brazil · 8.50M km²"]
- tests/shots/desktop-12-landscape-lift.png

### [desktop] 13 Accessibility: names, aria-checked, touch targets — PASS
- buttons without accessible name: 0 []
- radios: [{"id":"mercator","checked":"true"},{"id":"equalearth","checked":"false"},{"id":"city","checked":"false"},{"id":"country","checked":"true"},{"id":"continent","checked":"false"}]; missing aria-checked: 0; radiogroup labels: ["Map projection","What to pick up"]
- pointer:coarse=false; targets: [{"el":"icon-btn:reset","w":36,"h":36},{"el":"chip:clear","w":104.8,"h":29.9},{"el":"seg:mercator","w":87.7,"h":33.4},{"el":"seg:equalearth","w":110.1,"h":33.4},{"el":"icon-btn:theme","w":34,"h":34},{"el":"seg:city","w":57.9,"h":33.4},{"el":"seg:country","w":80.3,"h":33.4},{"el":"seg:continent","w":95.2,"h":33.4},{"el":"chip:","w":125,"h":29.9},{"el":"chip:","w":158.7,"h":29.9},{"el":"chip:","w":125,"h":29.9},{"el":"chip:","w":138.5,"h":29.9},{"el":"chip:","w":145.2,"h":29.9},{"el":"chip:share","w":84.6,"h":29.9}]
- targets under 40px tall: 14 [{"el":"icon-btn:reset","w":36,"h":36},{"el":"chip:clear","w":104.8,"h":29.9},{"el":"seg:mercator","w":87.7,"h":33.4},{"el":"seg:equalearth","w":110.1,"h":33.4},{"el":"icon-btn:theme","w":34,"h":34},{"el":"seg:city","w":57.9,"h":33.4},{"el":"seg:country","w":80.3,"h":33.4},{"el":"seg:continent","w":95.2,"h":33.4},{"el":"chip:","w":125,"h":29.9},{"el":"chip:","w":158.7,"h":29.9},{"el":"chip:","w":125,"h":29.9},{"el":"chip:","w":138.5,"h":29.9},{"el":"chip:","w":145.2,"h":29.9},{"el":"chip:share","w":84.6,"h":29.9}]
- canvas aria-label: "World map. Tap a place to lift a copy, then drag it."; why dialog: {"role":"dialog","modal":"true","labelledby":"why-title"}; search accessible name: "Search a city, country or continent"
