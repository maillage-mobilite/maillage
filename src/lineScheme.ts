// Schéma d'une ligne : tronc commun, tronçons où l'aller et le retour prennent des rues différentes,
// et variantes (services partiels, détours). Calculé à partir de toutes les courses publiées.
import type { Network, Trip } from './net'

export type Block =
  | { kind: 'common'; places: number[] }
  /** `aller` dans le sens 0, `retour` remis dans l'ordre du sens 0 (lu de bas en haut) */
  | { kind: 'split'; aller: number[]; retour: number[] }

export interface Variant {
  /** sens 0 ou 1 ; -1 : les deux sens (même écart à l'aller et au retour) */
  dir: number
  /** « partiel » : une partie du parcours seulement ; « détour » : arrêts hors du parcours principal ;
   *  « prolongement » : arrêts au-delà d'un terminus */
  kind: 'partiel' | 'detour' | 'prolongement'
  /** pour un prolongement, `from` (ou `to`) vaut -1 côté terminus dépassé */
  from: number
  to: number
  /** arrêts du détour */
  via: number[]
  /** part des courses de ce sens concernées (0–1) */
  share: number
}

export interface Scheme {
  /** terminus du parcours principal, sens 0 */
  ends: [number, number]
  headsign: [string, string | null]
  blocks: Block[]
  variants: Variant[]
}

/** Arrêts d'une course ramenés aux pôles (deux pôles de même nom n'en font qu'un), sans répétition consécutive. */
function placesOf(net: Network, t: Trip, byName: Map<string, number>): number[] {
  const out: number[] = []
  for (const s of t.stops) {
    let p = net.stops[s].place
    const name = net.places[p].name
    p = byName.get(name) ?? (byName.set(name, p), p)
    if (out[out.length - 1] !== p) out.push(p)
  }
  return out
}

/** Plus longue sous-suite commune : couples d'indices alignés (croissants). */
function lcs(a: number[], b: number[]): [number, number][] {
  const n = a.length, m = b.length
  const L = Array.from({ length: n + 1 }, () => new Int16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  const out: [number, number][] = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push([i, j]); i++; j++ } else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++
  }
  return out
}

export function lineScheme(net: Network, route: number): Scheme | null {
  // parcours distincts par sens, avec leur nombre de courses
  const pats: Map<string, { places: number[]; n: number; headsign: string }>[] = [new Map(), new Map()]
  const total = [0, 0]
  const byName = new Map<string, number>()
  for (const t of net.trips) {
    if (t.route !== route) continue
    const d = t.dir === 1 ? 1 : 0
    const pl = placesOf(net, t, byName)
    const k = pl.join(',')
    const e = pats[d].get(k)
    if (e) e.n++; else pats[d].set(k, { places: pl, n: 1, headsign: t.headsign })
    total[d]++
  }
  if (!total[0]) return null
  // parcours principal : le plus fréquent, pondéré par sa longueur (un service partiel fréquent ne l'emporte pas)
  const main = pats.map(m => [...m.values()].sort((a, b) => b.n * b.places.length - a.n * a.places.length)[0])
  const A = main[0].places
  const B = main[1] ? [...main[1].places].reverse() : null

  const blocks: Block[] = []
  const push = (b: Block) => {
    const last = blocks[blocks.length - 1]
    if (b.kind === 'common' && last?.kind === 'common') last.places.push(...b.places)
    else if (b.kind === 'common' ? b.places.length : b.aller.length || b.retour.length) blocks.push(b)
  }
  if (!B) push({ kind: 'common', places: [...A] })
  else {
    const pairs = lcs(A, B)
    let pi = -1, pj = -1
    for (const [i, j] of [...pairs, [A.length, B.length] as [number, number]]) {
      push({ kind: 'split', aller: A.slice(pi + 1, i), retour: B.slice(pj + 1, j) })
      if (i < A.length) push({ kind: 'common', places: [A[i]] })
      pi = i; pj = j
    }
  }

  // variantes : écart de chaque autre parcours au parcours principal de son sens
  const found = new Map<string, Variant>()
  pats.forEach((m, d) => {
    const M = main[d]?.places
    if (!M) return
    const idx = new Map(M.map((p, k) => [p, k]))
    for (const p of m.values()) {
      if (p === main[d]) continue
      const share = p.n / total[d]
      const onMain = p.places.filter(x => idx.has(x))
      if (onMain.length < p.places.length / 2) continue // parcours sans rapport (sens mal renseigné dans le flux)
      // détours : suites d'arrêts absents du parcours principal, avec l'arrêt avant et après
      let k = 0
      while (k < p.places.length) {
        if (idx.has(p.places[k])) { k++; continue }
        const start = k
        while (k < p.places.length && !idx.has(p.places[k])) k++
        const via = p.places.slice(start, k)
        const from = p.places[start - 1] ?? -1, to = p.places[k] ?? -1
        const kind = from < 0 || to < 0 ? 'prolongement' : 'detour'
        const key = `d${d}:${from}:${via.join(',')}:${to}`
        const v = found.get(key)
        if (v) v.share += share; else found.set(key, { dir: d, kind, from, to, via, share })
      }
      // service partiel : ne va pas d'un terminus à l'autre
      const first = onMain[0], last = onMain[onMain.length - 1]
      if (first !== M[0] || last !== M[M.length - 1]) {
        const key = `p${d}:${first}:${last}`
        const v = found.get(key)
        if (v) v.share += share; else found.set(key, { dir: d, kind: 'partiel', from: first, to: last, via: [], share })
      }
    }
  })
  // même écart dans les deux sens (parcours inverse) : une seule ligne « dans les deux sens »
  const all = [...found.values()]
  const same = (a: Variant, b: Variant) => a.kind === b.kind && a.from === b.to && a.to === b.from
    && a.via.length === b.via.length && a.via.every((x, k) => x === b.via[b.via.length - 1 - k])
  const merged: Variant[] = []
  for (const v of all) {
    if (v.dir !== 0) continue
    const w = all.find(x => x.dir === 1 && same(v, x))
    if (w) { merged.push({ ...v, dir: -1, share: Math.max(v.share, w.share) }); w.dir = -2 } else merged.push(v)
  }
  for (const v of all) if (v.dir === 1) merged.push(v)
  const order = { partiel: 0, prolongement: 1, detour: 2 }
  const variants = merged.sort((a, b) => a.dir - b.dir || order[a.kind] - order[b.kind] || b.share - a.share)

  return {
    ends: [A[0], A[A.length - 1]],
    headsign: [main[0].headsign, main[1]?.headsign ?? null],
    blocks,
    variants,
  }
}

/** Le schéma apporte-t-il quelque chose au-delà de la simple liste d'arrêts ? */
export function schemeWorthShowing(s: Scheme | null): s is Scheme {
  return !!s && (s.blocks.some(b => b.kind === 'split') || s.variants.length > 0)
}

export function shareLabel(x: number): string {
  return x >= 0.35 ? 'beaucoup de courses' : x >= 0.1 ? 'certaines courses' : 'quelques courses'
}
