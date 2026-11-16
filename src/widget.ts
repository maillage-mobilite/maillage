// Encart « prochains départs » à intégrer dans le site d'une commune (iframe).
// Page autonome et légère : ni carte ni calcul d'itinéraire, seulement les passages aux arrêts
// de la commune (data/<territoire>/widget-<commune>.json, produit par pipeline/build_widget.py).
//
// Paramètres d'adresse : ?reseau=paysdegex&commune=ornex[&lien=<adresse du calculateur>]
import './widget.css'

interface WRoute { short: string; long: string; color: string; text: string; kind: string }
interface WStop { name: string; lat: number; lon: number; deps: [number, number, number, string][] }
interface WData { name: string; generated_at: string; window_start: string; window_days: number; routes: WRoute[]; services: string[]; stops: WStop[] }

const params = new URLSearchParams(location.search)
const slug = (v: string | null, d: string) => (v && /^[a-z0-9-]+$/.test(v) ? v : d)
const reseau = slug(params.get('reseau'), 'paysdegex')
const commune = slug(params.get('commune'), 'ornex')
const lien = (() => {
  const v = params.get('lien')
  try { if (v && /^https:\/\//.test(v)) return new URL(v).toString() } catch { /* adresse invalide */ }
  return new URL(`./?reseau=${reseau}`, location.href).toString()
})()

const root = document.getElementById('widget')!
const TZ = 'Europe/Paris'
const HORIZON = 3 * 3600 // au-delà de 3 h, on n'affiche plus que le prochain départ de chaque direction

function parisNow(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('fr-FR', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map(x => [x.type, x.value]))
  return { date: `${p.year}-${p.month}-${p.day}`, sec: +p.hour * 3600 + +p.minute * 60 + +p.second }
}
const dayIndex = (start: string, date: string) => Math.round((Date.parse(date + 'T12:00:00Z') - Date.parse(start + 'T12:00:00Z')) / 86400000)
const hm = (sec: number) => { const s = ((sec % 86400) + 86400) % 86400; return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}` }
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

/** Passages à venir d'un arrêt, en secondes depuis maintenant (veille après minuit, aujourd'hui, demain). */
function upcoming(data: WData, stop: WStop, now: { date: string; sec: number }) {
  const k = dayIndex(data.window_start, now.date)
  const runs = (svc: number, day: number) => day >= 0 && data.services[svc][day] === '1'
  const out: { wait: number; at: number; route: number; head: string }[] = []
  for (const [sec, svc, route, head] of stop.deps) {
    for (const [day, shift] of [[k - 1, -86400], [k, 0], [k + 1, 86400]] as const) {
      const wait = sec + shift - now.sec
      if (wait >= -30 && wait < 86400 && runs(svc, day)) out.push({ wait, at: sec + shift, route, head })
    }
  }
  return out.sort((a, b) => a.wait - b.wait)
}

function when(wait: number, at: number) {
  if (wait < 60) return '<b>à l’approche</b>'
  if (wait < 3600) return `<b>${Math.floor(wait / 60)} min</b>`
  return at >= 86400 ? `demain ${hm(at)}` : hm(at)
}

function render(data: WData) {
  const now = parisNow()
  const stops = data.stops.map(stop => {
    const groups = new Map<string, { route: number; head: string; next: { wait: number; at: number }[] }>()
    for (const d of upcoming(data, stop, now)) {
      const key = `${d.route}|${d.head}`
      const g = groups.get(key) ?? { route: d.route, head: d.head, next: [] }
      if (!g.next.length || (g.next.length < 2 && d.wait < HORIZON)) g.next.push(d)
      groups.set(key, g)
    }
    const rows = [...groups.values()].sort((a, b) => a.next[0].wait - b.next[0].wait).map(g => {
      const r = data.routes[g.route]
      return `<li class="w-row">
        <span class="w-pill" style="background:${esc(r.color)};color:${esc(r.text)}" aria-label="Ligne ${esc(r.short)}">${esc(r.short)}</span>
        <span class="w-head"><span class="sr">vers </span>${esc(g.head)}</span>
        <span class="w-when">${g.next.map(n => when(n.wait, n.at)).join('<span class="w-sep" aria-hidden="true"> · </span><span class="sr">, puis </span>')}</span>
      </li>`
    }).join('')
    const short = stop.name.replace(new RegExp(`^${data.name},\\s*`, 'i'), '')
    return `<section class="w-stop" aria-label="Arrêt ${esc(stop.name)}">
      <h3>${esc(short)}</h3>
      ${rows ? `<ul>${rows}</ul>` : '<p class="w-muted">Aucun départ dans les prochaines 24 h.</p>'}
    </section>`
  }).join('')
  root.innerHTML = `
    <header class="w-top">
      <h2>Prochains départs à ${esc(data.name)}</h2>
      <p class="w-muted">Mis à jour à ${hm(now.sec)}</p>
    </header>
    ${stops}
    <footer class="w-foot">
      <a class="w-link" href="${esc(lien)}" target="_blank" rel="noopener">Calculer un itinéraire<span class="sr"> (nouvel onglet)</span> ↗</a>
      <p class="w-muted">Horaires théoriques, sans retards en temps réel. Données : Pays de Gex Agglo (Licence Ouverte).</p>
    </footer>`
  root.removeAttribute('aria-busy')
}

// hauteur transmise au site qui intègre l'encart (ajustement automatique de l'iframe), à chaque
// changement de taille du contenu : rendu, polices, largeur de la colonne du site hôte
let lastHeight = 0
new ResizeObserver(() => {
  const height = Math.ceil(root.getBoundingClientRect().height)
  if (height > 0 && height !== lastHeight && window.parent !== window) {
    lastHeight = height
    window.parent.postMessage({ type: 'maillage-widget-height', commune, height }, '*')
  }
}).observe(root)

async function main() {
  try {
    const res = await fetch(`./data/${reseau}/widget-${commune}.json`, { cache: 'no-cache' })
    if (!res.ok) throw new Error(String(res.status))
    const data: WData = await res.json()
    render(data)
    setInterval(() => render(data), 30_000)
  } catch {
    root.innerHTML = `<p class="w-muted">Horaires indisponibles pour le moment. <a class="w-link" href="${esc(lien)}" target="_blank" rel="noopener">Ouvrir le calculateur ↗</a></p>`
    root.removeAttribute('aria-busy')
  }
}
main()
