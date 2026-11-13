// Calculateur d'itinéraires du démonstrateur : Connection Scan Algorithm (CSA).
//
// Choix volontaire pour le démonstrateur : un petit réseau (~15 000 connexions/jour)
// se calcule en quelques millisecondes dans le navigateur, sans serveur.
// La cible production reste OpenTripPlanner 2 (ADR-004), qui gère aussi GTFS-RT et GTFS-Flex.
//
// Garanties : on ne renvoie que des horaires présents dans les GTFS. Aucune estimation.

import { Network, Trip, addDays, distance, serviceActive, walkSeconds } from './net'

export interface Point { lat: number; lon: number; label: string }

export type Leg =
  | { type: 'walk'; from: Point; to: Point; dep: number; arr: number; meters: number }
  | { type: 'ride'; trip: Trip; date: string; fromPos: number; toPos: number; dep: number; arr: number; booking: boolean }

export interface Journey { dep: number; arr: number; legs: Leg[]; transfers: number; walkMeters: number; hasBooking: boolean; key: string }

export interface RouterOptions {
  includeScolaire: boolean
  includeTad: boolean
  /** Instant présent (pour le délai de réservation TAD). */
  now: { date: string; sec: number }
  maxWalk?: number
}

export interface PlanResult { journeys: Journey[]; directWalk?: Journey; notes: string[] }

interface Conn { dep: number; arr: number; from: number; to: number; trip: number; pos: number }

const TRANSFER_SLACK = 60 // s, changement de véhicule au même arrêt

/** Délai de réservation TAD : la veille avant HH:MM. */
export function tadBookable(net: Network, date: string, now: { date: string; sec: number }): boolean {
  const b = net.booking['tad']
  const [h, m] = (b?.deadline_day_before ?? '15:00').split(':').map(Number)
  const deadlineDate = addDays(date, -1)
  return now.date < deadlineDate || (now.date === deadlineDate && now.sec < h * 3600 + m * 60)
}

/** Connexions élémentaires d'une journée (courses de la veille après minuit incluses), triées par départ. */
function connectionsFor(net: Network, date: string, opt: RouterOptions, tripDates: Map<number, string>): Conn[] {
  const conns: Conn[] = []
  const tadOk = opt.includeTad && tadBookable(net, date, opt.now)
  for (const [shift, d] of [[-86400, addDays(date, -1)], [0, date]] as const) {
    for (const t of net.trips) {
      const kind = net.routes[t.route].kind
      if (kind === 'scolaire' && !opt.includeScolaire) continue
      if (kind === 'tad' && !tadOk) continue
      if (!serviceActive(net, t.service, d)) continue
      if (shift && t.dep[t.dep.length - 1] < 86400) continue
      // identifiant de course "datée" : trip.i pour J, trip.i + nTrips pour J-1
      const id = shift ? t.i + net.trips.length : t.i
      tripDates.set(id, d)
      for (let k = 0; k < t.stops.length - 1; k++) {
        conns.push({ dep: t.dep[k] + shift, arr: t.arr[k + 1] + shift, from: t.stops[k], to: t.stops[k + 1], trip: id, pos: k })
      }
    }
  }
  conns.sort((a, b) => a.dep - b.dep || a.arr - b.arr)
  return conns
}

const cache = new Map<string, { conns: Conn[]; tripDates: Map<number, string> }>()

function getConnections(net: Network, date: string, opt: RouterOptions) {
  const tadOk = opt.includeTad && tadBookable(net, date, opt.now)
  const key = `${date}|${opt.includeScolaire}|${tadOk}`
  let c = cache.get(key)
  if (!c) {
    const tripDates = new Map<number, string>()
    c = { conns: connectionsFor(net, date, opt, tripDates), tripDates }
    cache.set(key, c)
  }
  return c
}

function nearStops(net: Network, p: Point, maxWalk: number): [number, number, number][] {
  const out: [number, number, number][] = []
  for (const s of net.stops) {
    const d = distance(p.lat, p.lon, s.lat, s.lon)
    if (d <= maxWalk && net.tripsAt[s.i].length) out.push([s.i, walkSeconds(d), Math.round(d * 1.25)])
  }
  return out
}

/** Un passage CSA : itinéraire arrivant au plus tôt en partant après `t0`. */
function scan(net: Network, conns: Conn[], tripDates: Map<number, string>, origin: Point, dest: Point, t0: number, maxWalk: number): Journey | null {
  const n = net.stops.length
  const S = new Float64Array(n).fill(Infinity)
  const byVehicle = new Uint8Array(n)
  const byBooking = new Uint8Array(n) // atteint en TAD : pas d'enchaînement TAD → TAD
  const J: ({ k: 'access' } | { k: 'ride'; board: number; alight: number } | { k: 'walk'; from: number; sec: number })[] = new Array(n)
  const boarded = new Map<number, number>() // trip -> index connexion d'embarquement

  for (const [s, sec] of nearStops(net, origin, maxWalk)) {
    if (t0 + sec < S[s]) { S[s] = t0 + sec; J[s] = { k: 'access' } }
  }
  const egress = new Map<number, number>()
  for (const [s, sec] of nearStops(net, dest, maxWalk)) egress.set(s, sec)

  const directM = distance(origin.lat, origin.lon, dest.lat, dest.lon)
  let best = directM <= 2500 ? t0 + walkSeconds(directM) : Infinity
  let bestStop = -1

  // première connexion partant après t0 (recherche dichotomique)
  let lo = 0, hi = conns.length
  while (lo < hi) { const m = (lo + hi) >> 1; if (conns[m].dep < t0) lo = m + 1; else hi = m }

  for (let i = lo; i < conns.length; i++) {
    const c = conns[i]
    if (c.dep >= best) break
    const onTrip = boarded.has(c.trip)
    if (!onTrip) {
      const ready = S[c.from] + (byVehicle[c.from] ? TRANSFER_SLACK : 0)
      if (ready > c.dep) continue
      if (byBooking[c.from] && net.trips[c.trip % net.trips.length].booking) continue
      boarded.set(c.trip, i)
    }
    if (c.arr < S[c.to]) {
      S[c.to] = c.arr
      byVehicle[c.to] = 1
      byBooking[c.to] = net.trips[c.trip % net.trips.length].booking ? 1 : 0
      J[c.to] = { k: 'ride', board: boarded.get(c.trip)!, alight: i }
      for (const [to, sec] of net.foot[c.to]) {
        if (c.arr + sec < S[to]) { S[to] = c.arr + sec; byVehicle[to] = 0; byBooking[to] = byBooking[c.to]; J[to] = { k: 'walk', from: c.to, sec } }
      }
    }
  }
  // meilleure sortie
  for (const [s, sec] of egress) {
    if (S[s] + sec < best) { best = S[s] + sec; bestStop = s }
  }
  if (!isFinite(best)) return null

  const P = (s: number): Point => ({ lat: net.stops[s].lat, lon: net.stops[s].lon, label: net.places[net.stops[s].place].name })
  if (bestStop < 0) {
    return finalize([{ type: 'walk', from: origin, to: dest, dep: t0, arr: best, meters: Math.round(directM * 1.25) }])
  }
  const legs: Leg[] = []
  const eg = egress.get(bestStop)!
  legs.unshift({ type: 'walk', from: P(bestStop), to: dest, dep: S[bestStop], arr: S[bestStop] + eg, meters: Math.round(distance(net.stops[bestStop].lat, net.stops[bestStop].lon, dest.lat, dest.lon) * 1.25) })
  let s = bestStop
  let guard = 0
  while (J[s] && J[s].k !== 'access' && guard++ < 50) {
    const j = J[s]!
    if (j.k === 'ride') {
      const b = conns[j.board], a = conns[j.alight]
      const trip = net.trips[b.trip % net.trips.length]
      legs.unshift({ type: 'ride', trip, date: tripDates.get(b.trip)!, fromPos: b.pos, toPos: a.pos + 1, dep: b.dep, arr: a.arr, booking: trip.booking })
      s = b.from
    } else if (j.k === 'walk') {
      legs.unshift({ type: 'walk', from: P(j.from), to: P(s), dep: S[s] - j.sec, arr: S[s], meters: Math.round(distance(net.stops[j.from].lat, net.stops[j.from].lon, net.stops[s].lat, net.stops[s].lon) * 1.25) })
      s = j.from
    }
  }
  const firstRide = legs.find(l => l.type === 'ride')
  const accessM = Math.round(distance(origin.lat, origin.lon, net.stops[s].lat, net.stops[s].lon) * 1.25)
  const accessSec = walkSeconds(accessM / 1.25)
  const leave = (firstRide?.dep ?? S[s]) - accessSec
  legs.unshift({ type: 'walk', from: origin, to: P(s), dep: leave, arr: leave + accessSec, meters: accessM })
  // on « recale » les marches d'attente : départ au plus tard compatible
  return finalize(legs.filter(l => l.type === 'ride' || l.meters > 20 || l === legs[0]))
}

function finalize(legs: Leg[]): Journey {
  const rides = legs.filter(l => l.type === 'ride') as Extract<Leg, { type: 'ride' }>[]
  return {
    dep: legs[0].dep,
    arr: legs[legs.length - 1].arr,
    legs,
    transfers: Math.max(0, rides.length - 1),
    walkMeters: legs.reduce((a, l) => a + (l.type === 'walk' ? l.meters : 0), 0),
    hasBooking: rides.some(r => r.booking),
    key: rides.map(r => `${r.trip.i}:${r.fromPos}-${r.toPos}`).join('|') || 'walk',
  }
}

/** Plusieurs options : on relance le scan juste après le premier embarquement de l'option précédente. */
export function plan(net: Network, origin: Point, dest: Point, date: string, t0: number, opt: RouterOptions): PlanResult {
  const maxWalk = opt.maxWalk ?? 1200
  const notes: string[] = []
  const journeys: Journey[] = []
  let directWalk: Journey | undefined
  const seen = new Set<string>()
  let t = t0
  // on peut chercher sur le jour J et, si rien, sur J+1
  for (const d of [date, addDays(date, 1)]) {
    const { conns, tripDates } = getConnections(net, d, opt)
    const base = d === date ? 0 : 86400
    t = d === date ? t0 : 0
    for (let k = 0; k < 8 && journeys.length < 4; k++) {
      const j = scan(net, conns, tripDates, origin, dest, t, maxWalk)
      if (!j) break
      if (j.key === 'walk') { directWalk = directWalk ?? shift(j, base); break }
      const first = j.legs.find(l => l.type === 'ride')!
      if (!seen.has(j.key)) { seen.add(j.key); journeys.push(shift(j, base)) }
      t = first.dep + 60
    }
    if (journeys.length || directWalk) break
    if (d === date) notes.push("Aucun trajet en transport en commun ne part encore aujourd'hui : options du lendemain.")
  }
  // on ne signale le délai TAD que s'il prive l'usager d'une option le jour demandé
  if (opt.includeTad && !tadBookable(net, date, opt.now) && (journeys.length === 0 || journeys[0].dep >= 86400)) notes.push("Le transport à la demande n'est plus réservable pour ce jour (réservation la veille avant 15 h).")
  // on retire les options dominées (arrive plus tard ou en même temps, part plus tôt, autant de correspondances)
  const kept = journeys.filter(j => !journeys.some(o => o !== j && o.arr <= j.arr && o.dep >= j.dep && o.transfers <= j.transfers && (o.arr < j.arr || o.dep > j.dep || o.transfers < j.transfers)))
  return { journeys: kept.sort((a, b) => a.arr - b.arr || b.dep - a.dep), directWalk, notes }
}

function shift(j: Journey, base: number): Journey {
  if (!base) return j
  return { ...j, dep: j.dep + base, arr: j.arr + base, legs: j.legs.map(l => ({ ...l, dep: l.dep + base, arr: l.arr + base })) }
}
