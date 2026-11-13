// Recherche : arrêts et lignes en local, adresses via la Base Adresse Nationale (BAN).
import { Network, distance } from './net'

export interface Suggestion {
  kind: 'place' | 'route' | 'address'
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
  const words = nq.split(' ')
  const out: (Suggestion & { score: number })[] = []
  for (const p of net.places) {
    const n = normalize(p.name)
    if (!words.every(w => n.includes(w))) continue
    const d = near ? distance(near.lat, near.lon, p.lat, p.lon) : 0
    const score = (n.startsWith(nq) ? 0 : 1) + d / 20000 + (p.routes.length ? 0 : 2)
    const lines = p.routes.slice(0, 5).map(r => net.routes[r].short).join(' · ')
    out.push({ kind: 'place', label: p.name, detail: `Arrêt · ${lines}${d > 15000 ? ` · ${Math.round(d / 1000)} km` : ''}`, lat: p.lat, lon: p.lon, id: p.i, score })
  }
  for (const r of net.routes) {
    const n = normalize(`${r.short} ${r.long}`)
    if (words.every(w => n.includes(w))) out.push({ kind: 'route', label: `Ligne ${r.short}`, detail: r.long, id: r.i, score: normalize(r.short) === nq ? -1 : 0.5 })
  }
  return out.sort((a, b) => a.score - b.score).slice(0, 6)
}

let controller: AbortController | null = null

export async function searchAddress(q: string, near: { lat: number; lon: number }): Promise<Suggestion[]> {
  if (q.trim().length < 3) return []
  controller?.abort()
  controller = new AbortController()
  const url = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(q)}&limit=5&lat=${near.lat}&lon=${near.lon}`
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) return []
    const json = await res.json()
    return json.features.map((f: any) => ({
      kind: 'address' as const,
      label: f.properties.name,
      detail: `${f.properties.postcode ?? ''} ${f.properties.city ?? ''}`.trim(),
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
    }))
  } catch {
    return []
  }
}
