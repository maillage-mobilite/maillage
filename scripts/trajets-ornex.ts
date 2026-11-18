// Trajets de référence de la présentation Ornex, recalculés sur les données du jour (npx vite-node scripts/trajets-ornex.ts)
import { readFileSync } from 'node:fs'
import { parseNetwork, fmtHM } from '../src/net'
import { plan } from '../src/router'

const net = parseNetwork(JSON.parse(readFileSync(new URL('../public/data/paysdegex/network.json', import.meta.url), 'utf8')))
const place = (q: string) => { const p = net.places.find(p => p.name === q) ?? net.places.find(p => p.name.startsWith(q)); if (!p) throw new Error(q); return { lat: p.lat, lon: p.lon, label: p.name } }
const from = place('Ornex, Prénépla')
const now = { date: '2026-11-16', sec: 9 * 3600 }
const cases: [string, string, string, number][] = [
  ['Genève, gare Cornavin', 'Genève, gare Cornavin', '2026-11-17', 7.5],
  ['Genève-Aéroport', 'Genève-Aéroport, Terminal', '2026-11-17', 9.2],
  ['Gex, L\'Aiglette', 'Gex, L\'Aiglette', '2026-11-21', 10],
  ['Bellegarde', 'Bellegarde', '2026-11-17', 8.5],
  ['Annecy', 'Annecy', '2026-11-17', 8.9],
  ['Lausanne', 'Lausanne', '2026-11-17', 7.5],
]
for (const [label, q, date, h] of cases) {
  const r = plan(net, from, place(q), date, Math.round(h * 3600), { includeScolaire: false, includeTad: false, includeTrain: true, now })
  const j = r.journeys[0]
  if (!j) { console.log(label, 'aucun'); continue }
  const rides = j.legs.filter(l => l.type === 'ride').map((l: any) => `${net.routes[l.trip.route].short} ${fmtHM(l.dep)}→${fmtHM(l.arr)} (${net.stops[l.trip.stops[l.fromPos]].name} → ${net.stops[l.trip.stops[l.toPos]].name})`)
  const walk = j.legs.filter(l => l.type === 'walk').map((l: any) => Math.round(l.meters))
  const d = j.arr - j.dep
  console.log(`${label.padEnd(24)} ${date} départ ${fmtHM(j.dep)} arrivée ${fmtHM(j.arr)} durée ${Math.floor(d / 3600)} h ${String(Math.round(d % 3600 / 60)).padStart(2, '0')} | ${rides.join(' + ')} | marche ${walk.join('/')} m`)
}
