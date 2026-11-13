// Géométrie des itinéraires : marche sur les rues (OSRM piéton) et étapes en bus sur le tracé des lignes.
//
// - Marche : service OSRM « foot » de FOSSGIS (routing.openstreetmap.de, données OSM, CORS ouvert).
//   Les coordonnées de départ/arrivée lui sont envoyées : c'est un tiers, à remplacer en production
//   par un OSRM ou un OpenTripPlanner hébergé par l'opérateur. Sans réponse, on garde l'estimation
//   à vol d'oiseau (× 1,25), affichée en pointillés plus clairs.
// - Bus : on découpe le tracé de la ligne (lines.geojson, recalé sur la voirie) entre l'arrêt de
//   montée et l'arrêt de descente, au lieu de relier les arrêts en ligne droite.
import { Network, distance } from './net'
import type { Journey, Leg } from './router'

type LngLat = [number, number]

const WALK_URL = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot'
const WALK_SPEED = 1.2 // m/s, même allure que le calcul d'itinéraire (public âgé compris)
const cache = new Map<string, Promise<WalkRoute | null>>()

export interface WalkRoute { meters: number; sec: number; coords: LngLat[] }

const key = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
  `${a.lon.toFixed(5)},${a.lat.toFixed(5)};${b.lon.toFixed(5)},${b.lat.toFixed(5)}`

/** Trajet à pied par les rues (mis en cache). null si le service ne répond pas. */
export function walkRoute(a: { lat: number; lon: number }, b: { lat: number; lon: number }): Promise<WalkRoute | null> {
  const k = key(a, b)
  let p = cache.get(k)
  if (!p) {
    p = (async () => {
      try {
        const ctl = new AbortController()
        const timer = setTimeout(() => ctl.abort(), 6000)
        const res = await fetch(`${WALK_URL}/${k}?overview=full&geometries=geojson`, { signal: ctl.signal })
        clearTimeout(timer)
        if (!res.ok) return null
        const j = await res.json()
        const r = j.routes?.[0]
        if (!r) return null
        const coords: LngLat[] = r.geometry.coordinates
        // on raccorde le tracé aux points exacts (le service s'accroche à la rue la plus proche)
        coords.unshift([a.lon, a.lat]); coords.push([b.lon, b.lat])
        const snap = (j.waypoints ?? []).reduce((s: number, w: any) => s + (w.distance ?? 0), 0)
        const meters = Math.round(r.distance + snap)
        return { meters, sec: Math.round(meters / WALK_SPEED), coords }
      } catch { cache.delete(k); return null }
    })()
    cache.set(k, p)
  }
  return p
}

async function pool<T>(items: (() => Promise<T>)[], n = 4) {
  const out: T[] = new Array(items.length)
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await items[k]() } }))
  return out
}

/**
 * Recalcule les étapes à pied d'un ensemble d'itinéraires sur les rues : distance, durée, tracé.
 * Les horaires des véhicules ne bougent jamais ; seuls l'heure de départ (marche d'accès),
 * l'heure d'arrivée (marche finale) et les correspondances à pied sont ajustées.
 */
export async function refineWalks(journeys: Journey[]): Promise<Journey[]> {
  const legs = journeys.flatMap(j => j.legs.filter(l => l.type === 'walk')) as Extract<Leg, { type: 'walk' }>[]
  const todo = legs.filter(l => distance(l.from.lat, l.from.lon, l.to.lat, l.to.lon) >= 40)
  const routes = new Map<Leg, WalkRoute | null>()
  const res = await pool(todo.map(l => () => walkRoute(l.from, l.to)))
  todo.forEach((l, k) => routes.set(l, res[k]))
  return journeys.map(j => refineJourney(j, routes))
}

function refineJourney(j: Journey, routes: Map<Leg, WalkRoute | null>): Journey {
  if (!j.legs.some(l => routes.get(l))) return j
  const legs: Leg[] = j.legs.map(l => ({ ...l }))
  let tight = false
  for (let k = 0; k < legs.length; k++) {
    const l = legs[k]
    if (l.type !== 'walk') continue
    const r = routes.get(j.legs[k])
    if (!r) continue
    const next = legs[k + 1], prev = legs[k - 1]
    l.meters = r.meters
    l.geom = r.coords
    if (!prev && next?.type === 'ride') { l.arr = next.dep; l.dep = next.dep - r.sec } // marche d'accès : partir plus tôt
    else if (!prev && !next) { l.arr = l.dep + r.sec } // trajet entièrement à pied
    else {
      l.arr = l.dep + r.sec
      if (next?.type === 'ride' && l.arr > next.dep) tight = true // correspondance à pied plus longue que prévu
    }
  }
  return {
    ...j, legs, dep: legs[0].dep, arr: legs[legs.length - 1].arr, tightWalk: tight || undefined,
    walkMeters: legs.reduce((a, l) => a + (l.type === 'walk' ? l.meters : 0), 0),
  }
}

// ---------------------------------------------------------------------------------------------
// Étapes en bus sur le tracé des lignes

let shapes: Map<number, LngLat[][]> | null = null
let loading: Promise<void> | null = null

/** Charge les tracés des lignes (même fichier que la carte, servi depuis le cache du navigateur). */
export function loadShapes(): Promise<void> {
  if (!loading) loading = fetch(`${import.meta.env.BASE_URL}data/lines.geojson`).then(r => r.json()).then(g => {
    shapes = new Map()
    for (const f of g.features) {
      if (f.geometry?.type !== 'LineString') continue
      const r = f.properties.route as number
      if (!shapes.has(r)) shapes.set(r, [])
      shapes.get(r)!.push(f.geometry.coordinates)
    }
  }).catch(() => { loading = null })
  return loading
}

const M_LAT = 111320
/** Projection d'un point sur chaque segment proche : [abscisse curviligne (m), écart (m), segment, t]. */
function projections(line: LngLat[], p: LngLat, cum: number[], max: number) {
  const kx = M_LAT * Math.cos(p[1] * Math.PI / 180)
  const out: { along: number; off: number; seg: number; t: number }[] = []
  for (let i = 0; i < line.length - 1; i++) {
    const ax = (line[i][0] - p[0]) * kx, ay = (line[i][1] - p[1]) * M_LAT
    const bx = (line[i + 1][0] - p[0]) * kx, by = (line[i + 1][1] - p[1]) * M_LAT
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy
    const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0
    const off = Math.hypot(ax + t * dx, ay + t * dy)
    if (off <= max) out.push({ along: cum[i] + t * (cum[i + 1] - cum[i]), off, seg: i, t })
  }
  return out
}

function cumulative(line: LngLat[]) {
  const cum = [0]
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + distance(line[i - 1][1], line[i - 1][0], line[i][1], line[i][0]))
  return cum
}

const lerp = (a: LngLat, b: LngLat, t: number): LngLat => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]

/** Tracé d'une étape en bus : portion de la ligne entre montée et descente, ou null si introuvable. */
export function rideGeometry(net: Network, l: Extract<Leg, { type: 'ride' }>): LngLat[] | null {
  const cands = shapes?.get(l.trip.route)
  if (!cands) return null
  const pt = (pos: number): LngLat => { const s = net.stops[l.trip.stops[pos]]; return [s.lon, s.lat] }
  const A = pt(l.fromPos), B = pt(l.toPos)
  const mids = l.trip.stops.slice(l.fromPos + 1, l.toPos).map((_, k) => pt(l.fromPos + 1 + k))
  let best: { line: LngLat[]; a: ReturnType<typeof projections>[0]; b: ReturnType<typeof projections>[0]; score: number } | null = null
  for (const line of cands) {
    const cum = cumulative(line)
    const pa = projections(line, A, cum, 90), pb = projections(line, B, cum, 90)
    for (const a of pa) for (const b of pb) {
      if (b.along <= a.along) continue
      const len = b.along - a.along
      // les arrêts intermédiaires doivent longer la portion retenue
      let ok = 0
      for (const m of mids) if (projections(line, m, cum, 90).some(x => x.along >= a.along - 5 && x.along <= b.along + 5)) ok++
      if (mids.length && ok < mids.length * 0.8) continue
      const score = len + (a.off + b.off) * 5
      if (!best || score < best.score) best = { line, a, b, score }
    }
  }
  if (!best) return null
  const { line, a, b } = best
  const out: LngLat[] = [A, lerp(line[a.seg], line[a.seg + 1], a.t)]
  for (let i = a.seg + 1; i <= b.seg; i++) out.push(line[i])
  out.push(lerp(line[b.seg], line[b.seg + 1], b.t), B)
  return out
}
