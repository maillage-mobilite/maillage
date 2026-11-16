// Modèle de données du réseau + fonctions horaires (prochains départs, calendriers).
// Toutes les heures sont en secondes depuis minuit, heure de Paris.
import { dataUrl } from './tenant'

export type Kind = 'urbain' | 'scolaire' | 'tad' | 'region' | 'train'

export interface Route {
  i: number; short: string; long: string; color: string; text: string; kind: Kind; agency: string
  /** Code d'origine du GTFS (pour les TER, code interne SNCF non affiché aux voyageurs). */
  code: string
}

/**
 * Les codes de ligne du GTFS SNCF (K4, K64, P4…) ne sont pas les numéros affichés aux voyageurs
 * (TER Auvergne-Rhône-Alpes numérote ses lignes 01 à 76) et un même code sert dans plusieurs régions.
 * On affiche donc « TER » et le parcours en clair.
 */
const GARE_FIX: [RegExp, string][] = [
  [/\bLyon[ -]P(?:art)?[ -]?D(?:ieu)?\b/g, 'Lyon Part-Dieu'], [/\bLyon-Perrache\b/g, 'Lyon Perrache'],
  [/\bChambery\b/g, 'Chambéry'], [/\bBriancon\b/g, 'Briançon'], [/\bBourg En Bresse\b/g, 'Bourg-en-Bresse'],
  [/\bBourg St-Maurice\b/g, 'Bourg-Saint-Maurice'], [/\bSt-Gervais Les Bains\b/g, 'Saint-Gervais-les-Bains'],
  [/\bLe Puy En Velay\b/g, 'Le Puy-en-Velay'], [/\bVillefranche Sur Saône\b/g, 'Villefranche-sur-Saône'],
]
function trainLong(s: string) {
  s = s.replace(/\s+FT$/, '').replace(/\b[A-ZÉÈ]{3,}\b/g, w => w[0] + w.slice(1).toLowerCase())
  for (const [re, to] of GARE_FIX) s = s.replace(re, to)
  return s.replace(/\s+-\s+/g, ' – ')
}

/** Clé stable d'une ligne (favoris, dédoublonnage) : le parcours pour les TER, le numéro sinon. */
export const routeKey = (r: Route) => r.kind === 'train' ? `train:${r.long}` : `${r.kind}:${r.short}`

/** Lignes d'une liste sans doublon d'affichage (plusieurs TER ne font qu'une pastille « TER »). */
export function distinctRoutes(net: Network, ids: number[]) {
  const seen = new Set<string>()
  return ids.filter(i => { const r = net.routes[i]; const k = r.kind === 'train' ? 'train' : routeKey(r); return seen.has(k) ? false : (seen.add(k), true) })
}
export interface Stop { i: number; name: string; lat: number; lon: number; place: number; feed: Kind }
export interface Place { i: number; name: string; lat: number; lon: number; feeds: Kind[]; stops: number[]; routes: number[]; /** gares à distance de marche : [gare, mètres] */ stations: [number, number][] }
/** Gare ferroviaire en correspondance avec au moins un arrêt du réseau. */
export interface Station { i: number; name: string; lat: number; lon: number; uic: string; segment: string; /** pôles reliés : [pôle, mètres] */ links: [number, number][] }
export interface Trip { i: number; route: number; service: number; headsign: string; dir: number; stops: number[]; arr: number[]; dep: number[]; booking: boolean }
export interface FeedReport {
  id: string; name: string; kind: Kind; licence: string; page: string; url: string; last_modified: string | null
  start: string | null; end: string | null; days_left: number | null; fixes: Record<string, number>; checks: Record<string, number | null>
}
export interface Booking { deadline_day_before: string; phone: string; confirm_window: string; fare: string }

export interface Network {
  generatedAt: string
  tenant: {
    tenant: string; name: string; territory: string; center: [number, number]; bbox: number[]; links: Record<string, string | undefined>
    default_place?: { name: string; lat: number; lon: number }; data_gaps?: string[]; credits?: string; fares_note?: string
  }
  booking: Record<string, Booking>
  windowStart: string
  windowDays: number
  feeds: FeedReport[]
  reconciliation: { stops: number; places: number; cross_feed_merges: number }
  /** Recalage des tracés droits sur la voirie OSM (si effectué par le pipeline). */
  shapes?: { snapped_features: number; kept_straight: number; service: string }
  /** Qualité des tracés après appariement sur la chaussée, par ligne (index de route). */
  shapesQuality?: Record<string, { median_m: number; p95_m: number; max_m: number; blocks: number; kept_original: number }>
  stations: Station[]
  stationsSource: { name: string; licence: string; page: string } | null
  /** Passages de trains par gare (index de Station). */
  trains: Record<number, TrainRow[]>
  trainServices: string[]
  trainsSource: { name: string; licence: string; page: string } | null
  routes: Route[]
  stops: Stop[]
  places: Place[]
  trips: Trip[]
  services: string[]
  /** footpaths[stop] = [[toStop, seconds], ...] */
  foot: [number, number][][]
  /** tripsAt[stop] = [[trip, position], ...] */
  tripsAt: [number, number][][]
}

export async function loadNetwork(): Promise<Network> {
  const res = await fetch(dataUrl('network.json'))
  if (!res.ok) throw new Error(`Données indisponibles (${res.status})`)
  return parseNetwork(await res.json())
}

export function parseNetwork(raw: any): Network {
  const routes: Route[] = raw.routes.map((r: any[], i: number) => r[4] === 'train'
    ? { i, short: 'TER', long: trainLong(r[1]), code: r[0], color: '#' + r[2], text: '#' + r[3], kind: r[4], agency: r[5] }
    : { i, short: r[0], long: r[1], code: r[0], color: '#' + r[2], text: '#' + r[3], kind: r[4], agency: r[5] })
  const stops: Stop[] = raw.stops.map((s: any[], i: number) => ({ i, name: s[0], lat: s[1], lon: s[2], place: s[3], feed: s[4] }))
  const places: Place[] = raw.places.map((p: any[], i: number) => ({ i, name: p[0], lat: p[1], lon: p[2], feeds: p[3], stops: [], routes: [], stations: [] }))
  const stations: Station[] = (raw.stations ?? []).map((x: any[], i: number) => ({ i, name: x[0], lat: x[1], lon: x[2], uic: x[3], segment: x[4], links: x[5] }))
  for (const st of stations) for (const [pl, m] of st.links) places[pl].stations.push([st.i, m])
  const trips: Trip[] = raw.trips.map((t: any[], i: number) => ({ i, route: t[0], service: t[1], headsign: t[2], dir: t[3], stops: t[4], arr: t[5], dep: t[6], booking: !!t[7] }))
  stops.forEach(s => places[s.place].stops.push(s.i))
  // Directions illisibles dans certains flux (numéros de course Oùra, codes TAD) → nom du terminus
  for (const t of trips) {
    // boucle (même pôle au départ et à l'arrivée) : « Boucle via … » plutôt que « direction <là où l'on est> »
    const first = stops[t.stops[0]].place, last = stops[t.stops[t.stops.length - 1]].place
    if (first === last && t.stops.length > 2) {
      t.headsign = `Boucle via ${places[stops[t.stops[Math.floor(t.stops.length / 2)]].place].name}`
      continue
    }
    const code = /^[A-Za-z]{0,3}\d+[A-Za-z]{0,3}$/.test(t.headsign) // ex. « 59604 », « G09r »
    if (!t.headsign || code || /^tad\b/i.test(t.headsign)) t.headsign = places[stops[t.stops[t.stops.length - 1]].place].name
  }
  const tripsAt: [number, number][][] = stops.map(() => [])
  trips.forEach(t => t.stops.forEach((s, k) => tripsAt[s].push([t.i, k])))
  const placeRoutes = places.map(() => new Set<number>())
  trips.forEach(t => t.stops.forEach(s => placeRoutes[stops[s].place].add(t.route)))
  places.forEach(p => { p.routes = [...placeRoutes[p.i]].sort((a, b) => a - b) })
  const foot: [number, number][][] = stops.map(() => [])
  for (const [a, b, sec] of raw.footpaths) foot[a].push([b, sec])
  return {
    generatedAt: raw.generated_at, tenant: raw.tenant, booking: raw.booking, windowStart: raw.window_start, windowDays: raw.window_days,
    feeds: raw.feeds, reconciliation: raw.reconciliation, shapes: raw.shapes, shapesQuality: raw.shapes_quality, stations, stationsSource: raw.stations_source ?? null,
    trains: Object.fromEntries(Object.entries(raw.trains ?? {}).map(([k, rows]: [string, any]) => [Number(k), rows.map((r: any[]) => ({
      dep: r[0], arr: r[1], svc: r[2], mode: r[3], line: r[4], number: r[5], from: r[6], to: r[7], noPickup: !!r[8], noDrop: !!r[9],
    }))])),
    trainServices: raw.train_services ?? [], trainsSource: raw.trains_source ?? null, routes, stops, places, trips, services: raw.services, foot, tripsAt,
  }
}

// ------------------------------------------------------------------ temps

const TZ = 'Europe/Paris'

/** Date (AAAA-MM-JJ) et secondes depuis minuit, à Paris. */
export function parisNow(d = new Date()): { date: string; sec: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('fr-FR', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map(p => [p.type, p.value]))
  return { date: `${parts.year}-${parts.month}-${parts.day}`, sec: +parts.hour * 3600 + +parts.minute * 60 + +parts.second }
}

export function addDays(date: string, n: number): string {
  const d = new Date(date + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export function dayIndex(net: Network, date: string): number {
  return Math.round((Date.parse(date + 'T12:00:00Z') - Date.parse(net.windowStart + 'T12:00:00Z')) / 86400000)
}

export function serviceActive(net: Network, service: number, date: string): boolean {
  const k = dayIndex(net, date)
  return k >= 0 && k < net.windowDays && net.services[service][k] === '1'
}

export function inWindow(net: Network, date: string): boolean {
  const k = dayIndex(net, date)
  return k >= 1 && k < net.windowDays
}

export function fmtHM(sec: number): string {
  const s = ((sec % 86400) + 86400) % 86400
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`
}

export function fmtDuration(sec: number): string {
  const m = Math.round(sec / 60)
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`
}

export function fmtDay(date: string, ref: string): string {
  if (date === ref) return "aujourd'hui"
  if (date === addDays(ref, 1)) return 'demain'
  return new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(date + 'T12:00:00Z'))
}

// ------------------------------------------------------------------ départs

export interface Departure { trip: Trip; pos: number; date: string; time: number; /** secondes absolues depuis minuit de `from.date` */ abs: number }

/**
 * Prochains départs depuis un ensemble d'arrêts, à partir d'un instant donné,
 * en regardant jusqu'à `horizonDays` jours en avant (réseaux peu fréquents).
 */
export function departures(net: Network, stopIds: number[], from: { date: string; sec: number }, opts: { limit?: number; horizonDays?: number; routes?: Set<number> } = {}): Departure[] {
  const limit = opts.limit ?? 30
  const out: Departure[] = []
  for (let d = -1; d <= (opts.horizonDays ?? 2); d++) {
    const date = addDays(from.date, d)
    for (const s of stopIds) {
      for (const [ti, pos] of net.tripsAt[s]) {
        const t = net.trips[ti]
        if (pos === t.stops.length - 1) continue // terminus : pas de départ
        if (opts.routes && !opts.routes.has(t.route)) continue
        if (!serviceActive(net, t.service, date)) continue
        const abs = t.dep[pos] + d * 86400
        if (abs < from.sec) continue
        out.push({ trip: t, pos, date, time: t.dep[pos], abs })
      }
    }
    if (out.length >= limit && d >= 0) break
  }
  out.sort((a, b) => a.abs - b.abs)
  return out.slice(0, limit)
}

/** Courses d'une ligne actives à une date, par sens, triées par heure de départ. */
export function tripsOfRoute(net: Network, route: number, date: string): Trip[][] {
  const dirs: Trip[][] = [[], []]
  for (const t of net.trips) {
    if (t.route === route && serviceActive(net, t.service, date)) (dirs[t.dir] ?? dirs[0]).push(t)
  }
  dirs.forEach(d => d.sort((a, b) => a.dep[0] - b.dep[0]))
  return dirs
}

/** Course « type » d'une ligne pour un sens (celle qui dessert le plus d'arrêts). */
export function referenceTrip(net: Network, route: number, dir: number): Trip | undefined {
  let best: Trip | undefined
  for (const t of net.trips) if (t.route === route && t.dir === dir && (!best || t.stops.length > best.stops.length)) best = t
  return best
}

// ------------------------------------------------------------------ géo

export function distance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = 6371000, toR = Math.PI / 180
  const dphi = (lat2 - lat1) * toR, dl = (lon2 - lon1) * toR
  const a = Math.sin(dphi / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dl / 2) ** 2
  return 2 * r * Math.asin(Math.sqrt(a))
}

/** Temps de marche estimé (détour 1,25 ; 4,3 km/h). */
export const walkSeconds = (meters: number) => Math.round((meters * 1.25) / 1.2)

export function nearestPlaces(net: Network, lat: number, lon: number, max = 6, radius = 1500) {
  return net.places
    .map(p => ({ p, d: distance(lat, lon, p.lat, p.lon) }))
    .filter(x => x.d <= radius && x.p.stops.some(s => net.tripsAt[s].length))
    .sort((a, b) => a.d - b.d)
    .slice(0, max)
}

export const KIND_LABEL: Record<Kind, string> = { urbain: 'Urbain', scolaire: 'Scolaire', tad: 'Transport à la demande', region: 'Car Région', train: 'Train TER' }

// ------------------------------------------------------------------ tarifs

export interface Fare { category: 'ticket' | 'abonnement'; name: string; price_eur: number; transfers: boolean; conditions: string }
export interface Fares { source: string; source_url: string; retrieved: string; note: string; fares: Fare[] }

export async function loadFares(): Promise<Fares | null> {
  try {
    const res = await fetch(dataUrl('fares.json'))
    return res.ok ? await res.json() : null
  } catch { return null }
}

export const fmtEur = (v: number) => (v === 0 ? 'Gratuit' : v.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' }))

/** « Gare du Péage-de-Roussillon », « Gare de Valence », « Gare des Arcs », « Gare de la Part-Dieu »… */
export function stationLabel(name: string): string {
  if (/^Le /.test(name)) return `Gare du ${name.slice(3)}`
  if (/^Les /.test(name)) return `Gare des ${name.slice(4)}`
  if (/^La /.test(name)) return `Gare de la ${name.slice(3)}`
  if (/^L'/.test(name)) return `Gare de l'${name.slice(2)}`
  return `Gare de ${name}`
}

// ------------------------------------------------------------------ trains

export interface TrainRow { dep: number; arr: number; svc: number; mode: string; line: string; number: string; from: string; to: string; noPickup: boolean; noDrop: boolean }
export interface TrainPass extends TrainRow { abs: number; date: string }

export const TRAIN_MODE: Record<string, { label: string; color: string }> = {
  'Train TER': { label: 'TER', color: '#1e3a8a' },
  'TGV INOUI': { label: 'TGV', color: '#8a1538' },
  'OUIGO': { label: 'OUIGO', color: '#d6006f' },
  'INTERCITES': { label: 'IC', color: '#00577d' },
  'INTERCITES de nuit': { label: 'IC Nuit', color: '#2b2b6b' },
  'ICE': { label: 'ICE', color: '#5b6770' },
}

/** Prochains départs (ou arrivées) de trains dans une gare, à partir d'un instant, sur quelques jours. */
export function trainPasses(net: Network, station: number, from: { date: string; sec: number }, opts: { kind?: 'dep' | 'arr'; limit?: number; horizonDays?: number; modes?: Set<string> } = {}): TrainPass[] {
  const rows = net.trains[station] ?? []
  const kind = opts.kind ?? 'dep'
  const name = net.stations[station]?.name
  const out: TrainPass[] = []
  for (let d = -1; d <= (opts.horizonDays ?? 1); d++) {
    const date = addDays(from.date, d)
    const k = dayIndex(net, date)
    if (k < 0 || k >= net.windowDays) continue
    for (const r of rows) {
      if (net.trainServices[r.svc][k] !== '1') continue
      if (opts.modes && !opts.modes.has(r.mode)) continue
      if (kind === 'dep' && (r.noPickup || r.to === name)) continue
      if (kind === 'arr' && (r.noDrop || r.from === name)) continue
      const t = kind === 'dep' ? r.dep : r.arr
      const abs = t + d * 86400
      if (abs < from.sec) continue
      out.push({ ...r, abs, date })
    }
  }
  out.sort((a, b) => a.abs - b.abs)
  return out.slice(0, opts.limit ?? 10)
}
