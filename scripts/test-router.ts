// Tests de bout en bout du calculateur sur les vraies données (npm run test:router).
// Vérifie surtout l'invariant clé : chaque horaire affiché existe dans les GTFS.
import { readFileSync } from 'node:fs'
import { parseNetwork, fmtHM, departures, addDays, distance, trainPasses, stationLabel } from '../src/net'
import { plan, Point } from '../src/router'

const net = parseNetwork(JSON.parse(readFileSync(new URL('../public/data/network.json', import.meta.url), 'utf8')))
const place = (q: string): Point => {
  const p = net.places.find(p => p.name.toLowerCase().includes(q.toLowerCase()))
  if (!p) throw new Error('lieu introuvable : ' + q)
  return { lat: p.lat, lon: p.lon, label: p.name }
}
const DATE = '2026-11-16' // lundi
const now = { date: '2026-11-13', sec: 9 * 3600 }
let failures = 0
const check = (cond: boolean, msg: string) => { if (!cond) { failures++; console.log('  ✗', msg) } }

function show(from: Point, to: Point, t0: number, opts: Partial<{ includeScolaire: boolean; includeTad: boolean }> = {}, date = DATE) {
  const t = performance.now()
  const r = plan(net, from, to, date, t0, { includeScolaire: false, includeTad: true, now, ...opts })
  console.log(`\n${from.label} → ${to.label}  (${date} ${fmtHM(t0)})  ${(performance.now() - t).toFixed(0)} ms`)
  r.notes.forEach(n => console.log('  note:', n))
  if (r.directWalk) console.log(`  à pied : ${fmtHM(r.directWalk.dep)} → ${fmtHM(r.directWalk.arr)}`)
  for (const j of r.journeys) {
    console.log(`  ${fmtHM(j.dep)} → ${fmtHM(j.arr)}  corresp.=${j.transfers} marche=${j.walkMeters} m ${j.hasBooking ? '[réservation]' : ''}`)
    let prevArr = -Infinity
    for (const l of j.legs) {
      check(l.arr >= l.dep, 'étape à durée négative')
      check(l.dep >= prevArr - 1, 'étapes non chronologiques')
      prevArr = l.arr
      if (l.type === 'ride') {
        const r = net.routes[l.trip.route]
        const off = l.dep - l.trip.dep[l.fromPos]
        check(off % 86400 === 0, `horaire de départ absent du GTFS (${r.short})`)
        check(l.arr - l.trip.arr[l.toPos] === off, `horaire d'arrivée absent du GTFS (${r.short})`)
        console.log(`     [${r.short}] ${net.stops[l.trip.stops[l.fromPos]].name} ${fmtHM(l.dep)} → ${net.stops[l.trip.stops[l.toPos]].name} ${fmtHM(l.arr)} (${l.trip.headsign})`)
      } else console.log(`     à pied ${l.meters} m (${Math.round((l.arr - l.dep) / 60)} min) → ${l.to.label}`)
    }
  }
  return r
}

const gare = place('Gare Routière')
show(place('Varagnes'), place('Roiffieux - Village'), 7 * 3600 + 30 * 60)
show(gare, place('Lyon-Part-Dieu'), 8 * 3600)
const l17 = net.routes.find(r => r.short === 'L17')!
const l17trip = net.trips.filter(t => t.route === l17.i).sort((a, b) => b.stops.length - a.stops.length)[0]
const term = net.stops[l17trip.stops[l17trip.stops.length - 1]]
show(gare, { lat: term.lat, lon: term.lon, label: term.name + ' (terminus L17)' }, 12 * 3600)
show(place('Varagnes'), place('Hopital'), 8 * 3600)
const r = show(place('Vanosc - Mairie'), gare, 7 * 3600, { includeTad: true })
check(r.journeys.some(j => j.hasBooking), 'le TAD devrait apparaître depuis Vanosc')
const late = show(place('Vanosc - Mairie'), gare, 7 * 3600, { includeTad: true }, '2026-11-13')
// le jour même : TAD exclu (délai dépassé) → bascule sur le lendemain, où il redevient réservable
check(late.notes.some(n => n.includes('plus réservable')), 'le délai de réservation TAD devrait être signalé')
check(late.journeys.every(j => j.dep >= 86400), "aucun trajet TAD ne doit être proposé le jour même")
show(gare, place('Chantebise'), 22 * 3600) // pas de bus le soir → lendemain
show(place('Gare Routière'), { lat: 45.2445, lon: 4.6637, label: 'Rue de Bourgogne (adresse)' }, 10 * 3600)

const d = departures(net, net.places.find(p => p.name === 'Gare Routière')!.stops, { date: DATE, sec: 8 * 3600 }, { limit: 6 })
console.log('\nProchains départs Gare routière lundi 8 h :', d.map(x => `${net.routes[x.trip.route].short} ${fmtHM(x.time)} → ${x.trip.headsign}`).join(' · '))
check(d.length > 0, 'aucun départ à la gare routière')
// --- trains en correspondance
for (const st of net.stations) {
  // sur 7 jours à partir du début de la fenêtre : certaines gares n'ont qu'une desserte ponctuelle (Saint-Péray)
  const from = { date: addDays(net.windowStart, 1), sec: 0 }
  const dep = trainPasses(net, st.i, from, { kind: 'dep', limit: 3, horizonDays: 7 })
  const arr = trainPasses(net, st.i, from, { kind: 'arr', limit: 3, horizonDays: 7 })
  console.log(`${stationLabel(st.name).padEnd(36)} départs : ${dep.map(t => `${fmtHM(t.abs)} ${t.mode.replace('Train ', '')} → ${t.to}`).join(' · ')}`)
  check(dep.length > 0 && arr.length > 0, `aucun train à ${st.name}`)
  check(dep.every(t => t.to !== st.name && !t.noPickup), `départ invalide (terminus ou sans montée) à ${st.name}`)
  check(dep.every((t, k) => k === 0 || t.abs >= dep[k - 1].abs), `départs non triés à ${st.name}`)
}
const peage = net.places.find(p => p.stations.length && /SNCF/i.test(p.name))
check(!!peage, 'aucun pôle de bus rattaché à une gare')
void addDays; void distance
console.log(failures ? `\n${failures} échec(s)` : '\nTous les contrôles passent ✓')
process.exit(failures ? 1 : 0)
