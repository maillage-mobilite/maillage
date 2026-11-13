// Temps réel des trains (GTFS-RT SNCF via transport.data.gouv.fr).
// Le flux couvre toute la France (~900 Ko) : on ne le charge que lorsqu'un écran l'utilise,
// puis toutes les minutes tant qu'il reste affiché. En production, un serveur le filtrerait.
import { useEffect, useState } from 'preact/hooks'
import { decodeTripUpdates, type RtTrip } from './gtfsrt'

const URL = 'https://proxy.transport.data.gouv.fr/resource/sncf-gtfs-rt-trip-updates'
const REFRESH_MS = 60_000

export interface RealtimeState {
  /** Courses indexées par « numéro de train|AAAAMMJJ ». */
  trips: Map<string, RtTrip>
  /** Heure du flux (secondes Unix) et de notre dernier chargement (ms). */
  feedTime: number
  fetchedAt: number
  loading: boolean
  error?: string
}

let state: RealtimeState = { trips: new Map(), feedTime: 0, fetchedAt: 0, loading: false }
const listeners = new Set<(s: RealtimeState) => void>()
let subscribers = 0
let timer: ReturnType<typeof setInterval> | null = null

const emit = () => listeners.forEach(l => l(state))

async function refresh() {
  if (state.loading) return
  state = { ...state, loading: true }
  emit()
  try {
    const res = await fetch(URL, { cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const feed = decodeTripUpdates(new Uint8Array(await res.arrayBuffer()))
    const trips = new Map<string, RtTrip>()
    for (const t of feed.trips) {
      const num = t.tripId.match(/SN(\d+)F/)?.[1]
      if (num) trips.set(`${num}|${t.startDate ?? ''}`, t)
    }
    state = { trips, feedTime: feed.timestamp, fetchedAt: Date.now(), loading: false }
  } catch (e) {
    state = { ...state, loading: false, error: (e as Error).message, fetchedAt: Date.now() }
  }
  emit()
}

/** Abonne le composant au temps réel des trains (chargement à la demande, rafraîchi chaque minute). */
export function useTrainRealtime(): RealtimeState {
  const [s, setS] = useState(state)
  useEffect(() => {
    listeners.add(setS)
    subscribers++
    if (Date.now() - state.fetchedAt > REFRESH_MS - 5000) refresh()
    if (!timer) timer = setInterval(refresh, REFRESH_MS)
    return () => {
      listeners.delete(setS)
      if (--subscribers === 0 && timer) { clearInterval(timer); timer = null }
    }
  }, [])
  return s
}

export type TrainStatus = { kind: 'canceled' | 'skipped' | 'late' | 'ontime'; delay: number }

/**
 * Statut temps réel d'un passage : train identifié par son numéro et sa date de circulation,
 * gare par ses codes UIC. Renvoie null si le flux ne parle pas de ce train (donc : horaire théorique).
 */
export function trainStatus(rt: RealtimeState, number: string, date: string, uics: string[], kind: 'dep' | 'arr'): TrainStatus | null {
  const t = rt.trips.get(`${number}|${date.replace(/-/g, '')}`)
  if (!t) return null
  if (t.canceled) return { kind: 'canceled', delay: 0 }
  const st = t.stops.find(s => uics.some(u => s.stopId.endsWith(u)))
  if (st?.skipped) return { kind: 'skipped', delay: 0 }
  const delay = (kind === 'dep' ? st?.depDelay ?? st?.arrDelay : st?.arrDelay ?? st?.depDelay) ?? t.delay
  if (delay == null) return null
  return { kind: delay >= 60 ? 'late' : 'ontime', delay }
}
