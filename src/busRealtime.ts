// Temps réel des bus : retards par arrêt, servis par le relais du serveur (tempsreel/serveur.py, /api/tr/<territoire>.json).
// Seulement pour les territoires dont un réseau publie son temps réel (network.json « realtime »).
// Chargé à la demande, rafraîchi toutes les 30 s tant qu'un écran l'affiche et que la page est visible.
import { useEffect, useState } from 'preact/hooks'
import { TENANT } from './tenant'
import type { Departure, Network } from './net'

const REFRESH_MS = 30_000

/** Retard de la course à chaque arrêt (secondes), null si inconnu, 'x' si l'arrêt n'est pas desservi. */
type Delays = (number | null | 'x')[]
export interface BusRealtime { trips: Map<string, { canceled: boolean; delays: Delays }>; feedTime: number; fetchedAt: number }

let state: BusRealtime = { trips: new Map(), feedTime: 0, fetchedAt: 0 }
let loading = false
const listeners = new Set<(s: BusRealtime) => void>()
let timer: ReturnType<typeof setInterval> | null = null

async function refresh() {
  if (loading || document.hidden) return
  loading = true
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}api/tr/${TENANT}.json`, { cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const doc = await res.json() as { t: number; trips: Record<string, [number, ...Delays]> }
    const trips = new Map<string, { canceled: boolean; delays: Delays }>()
    for (const [k, [c, ...d]] of Object.entries(doc.trips)) trips.set(k, { canceled: c === 1, delays: d })
    state = { trips, feedTime: doc.t, fetchedAt: Date.now() }
  } catch {
    // relais injoignable : on garde les dernières valeurs moins de 5 min, puis retour aux horaires théoriques
    if (Date.now() - state.fetchedAt > 300_000) state = { trips: new Map(), feedTime: 0, fetchedAt: state.fetchedAt }
  }
  loading = false
  listeners.forEach(l => l(state))
}

/** Abonne le composant au temps réel des bus du territoire (rien si aucun réseau ne le publie). */
export function useBusRealtime(net: Network): BusRealtime | null {
  const on = net.realtime.length > 0
  const [s, setS] = useState(state)
  useEffect(() => {
    if (!on) return
    listeners.add(setS)
    if (Date.now() - state.fetchedAt > REFRESH_MS - 5000) refresh()
    if (!timer) timer = setInterval(refresh, REFRESH_MS)
    return () => {
      listeners.delete(setS)
      if (listeners.size === 0 && timer) { clearInterval(timer); timer = null }
    }
  }, [on])
  return on ? s : null
}

export type BusStatus = { kind: 'canceled' } | { kind: 'skipped' } | { kind: 'live'; delay: number }

/** État en temps réel d'un départ, ou null s'il n'y a pas d'information (horaire théorique). */
export function busStatus(rt: BusRealtime | null, d: Departure): BusStatus | null {
  const t = rt?.trips.get(`${d.trip.i}@${d.date}`)
  if (!t) return null
  if (t.canceled) return { kind: 'canceled' }
  const v = t.delays[d.pos]
  if (v === 'x') return { kind: 'skipped' }
  return v == null ? null : { kind: 'live', delay: v }
}
