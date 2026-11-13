// Recherche : arrêts et lignes en local, adresses via la Base Adresse Nationale (BAN).
import { Network, distance, distinctRoutes, stationLabel } from './net'

export interface Suggestion {
  kind: 'place' | 'route' | 'address' | 'station'
  label: string
  detail: string
  lat?: number
  lon?: number
  id?: number
}

export const normalize = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()

export function searchLocal(net: Network, q: string, near?: { lat: number; lon: number }): Suggestion[] {
  const nq = normalize(q)
  if (nq.length < 2) return []
  // « Gare de Valence » doit trouver « Valence Ville » : on ignore les petits mots s'il en reste d'autres
  const all = nq.split(' ')
  const STOP = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'd', 'l', 'a', 'au'])
  const words = all.some(w => !STOP.has(w)) ? all.filter(w => !STOP.has(w)) : all
  const out: (Suggestion & { score: number })[] = []
  for (const p of net.places) {
    const n = normalize(p.name)
    if (!words.every(w => n.includes(w))) continue
    const d = near ? distance(near.lat, near.lon, p.lat, p.lon) : 0
    const score = (n.startsWith(nq) ? 0 : 1) + d / 20000 + (p.routes.length ? 0 : 2)
    const lines = distinctRoutes(net, p.routes).slice(0, 5).map(r => net.routes[r].short).join(' · ')
    out.push({ kind: 'place', label: p.name, detail: `Arrêt · ${lines}${d > 15000 ? ` · ${Math.round(d / 1000)} km` : ''}`, lat: p.lat, lon: p.lon, id: p.i, score })
  }
  for (const st of net.stations) {
    const n = normalize(`gare ${st.name}`)
    if (!words.every(w => n.includes(w))) continue
    const lines = distinctRoutes(net, [...new Set(st.links.flatMap(([pl]) => net.places[pl].routes))]).slice(0, 5).map(r => net.routes[r].short).join(' · ')
    out.push({ kind: 'station', label: stationLabel(st.name), detail: `Gare SNCF · correspondance ${lines}`, lat: st.lat, lon: st.lon, id: st.i, score: -0.5 })
  }
  for (const r of net.routes) {
    const n = normalize(`${r.short} ${r.long}`)
    if (words.every(w => n.includes(w))) out.push({ kind: 'route', label: r.kind === 'train' ? `TER ${r.long}` : `Ligne ${r.short}`, detail: r.kind === 'train' ? 'Train régional SNCF' : r.long, id: r.i, score: normalize(r.short) === nq ? -1 : 0.5 })
  }
  return out.sort((a, b) => a.score - b.score).slice(0, 6)
}

/** Recherche d'adresses (BAN). Renvoie null si la requête a été annulée (frappe suivante). */
export async function searchAddress(q: string, near: { lat: number; lon: number }, signal?: AbortSignal): Promise<Suggestion[] | null> {
  if (q.trim().length < 3) return []
  const url = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(q)}&limit=5&lat=${near.lat}&lon=${near.lon}`
  try {
    const res = await fetch(url, { signal })
    if (!res.ok) return []
    const json = await res.json()
    return json.features.map((f: any) => ({
      kind: 'address' as const,
      label: f.properties.name,
      detail: `${f.properties.postcode ?? ''} ${f.properties.city ?? ''}`.trim(),
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
    }))
  } catch (e) {
    return (e as Error)?.name === 'AbortError' ? null : []
  }
}
