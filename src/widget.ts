// Encart « prochains départs » à intégrer dans le site d'une commune (iframe).
// Page autonome et légère : ni carte ni calcul d'itinéraire, seulement les passages aux arrêts
// de la commune (data/<territoire>/widget-<commune>.json, produit par pipeline/build_widget.py).
//
// Paramètres d'adresse : ?reseau=paysdegex&commune=ornex
//   &format=complet (défaut) | compact (bandeau d'accueil) | venir (« Comment venir » à un lieu, avec &lieu=<nom>)
//   &couleur=<hexadécimal sans #> (couleur de la commune) · &id=<identifiant de l'iframe> (plusieurs encarts par page)
//   &lien=<adresse https du calculateur>
import './widget.css'

interface WRoute { short: string; long: string; color: string; text: string; kind: string }
interface WStop { name: string; lat: number; lon: number; deps: [number, number, number, string][] }
interface WData {
  name: string; generated_at: string; window_start: string; window_days: number; valid_until?: string | null; operator_url?: string | null
  routes: WRoute[]; services: string[]; stops: WStop[]
  /** lieux de la commune (OpenStreetMap) : [nom, catégorie, type, lat, lon] */
  lieux?: [string, string, string, number, number][]
}

const params = new URLSearchParams(location.search)
const slug = (v: string | null, d: string) => (v && /^[a-z0-9-]+$/.test(v) ? v : d)
const reseau = slug(params.get('reseau'), 'paysdegex')
const commune = slug(params.get('commune'), 'ornex')
const format = (['complet', 'compact', 'venir'] as const).find(f => f === params.get('format')) ?? 'complet'
const lieuParam = (params.get('lieu') ?? '').slice(0, 120)
const frameId = (params.get('id') ?? commune).replace(/[^a-z0-9-]/gi, '').slice(0, 40) || commune
// couleur de la commune : liens, temps d'attente, bouton (hexadécimal seul : rien d'autre n'entre dans la feuille de style)
const couleur = /^[0-9a-f]{6}$/i.test(params.get('couleur') ?? '') ? `#${params.get('couleur')}` : null
if (couleur) {
  document.documentElement.style.setProperty('--accent', couleur)
  // texte du bouton : blanc ou noir selon la clarté de la couleur (contraste lisible)
  const [r, g, b] = [1, 3, 5].map(i => parseInt(couleur.slice(i, i + 2), 16) / 255).map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  document.documentElement.style.setProperty('--accent-ink', 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.18 ? '#111' : '#fff')
}
document.documentElement.dataset.format = format
// lien fourni par la commune (page publique) : remplace aussi le bouton « Itinéraire jusqu'ici » (sans préremplissage)
const lienFourni = /^https:\/\//.test(params.get('lien') ?? '')
const lien = (() => {
  const v = params.get('lien')
  try { if (v && /^https:\/\//.test(v)) return new URL(v).toString() } catch { /* adresse invalide */ }
  return new URL(`./?reseau=${reseau}&src=encart&commune=${commune}`, location.href).toString()
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

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
const metres = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
  Math.hypot((a.lat - b.lat) * 111_000, (a.lon - b.lon) * 111_000 * Math.cos(a.lat * Math.PI / 180))
const shortName = (data: WData, stop: WStop) => stop.name.replace(new RegExp(`^${data.name},\\s*`, 'i'), '')
const pill = (r: WRoute) => `<span class="w-pill" style="background:${esc(r.color)};color:${esc(r.text)}" aria-label="Ligne ${esc(r.short)}">${esc(r.short)}</span>`

/** Départs d'un arrêt regroupés par ligne et direction (au plus 2 par groupe dans les 3 h), les plus proches d'abord. */
function groupsOf(data: WData, stop: WStop, now: { date: string; sec: number }) {
  const groups = new Map<string, { route: number; head: string; next: { wait: number; at: number }[] }>()
  for (const d of upcoming(data, stop, now)) {
    const key = `${d.route}|${d.head}`
    const g = groups.get(key) ?? { route: d.route, head: d.head, next: [] }
    if (!g.next.length || (g.next.length < 2 && d.wait < HORIZON)) g.next.push(d)
    groups.set(key, g)
  }
  return [...groups.values()].sort((a, b) => a.next[0].wait - b.next[0].wait)
}

function rowsHtml(data: WData, groups: ReturnType<typeof groupsOf>, max = 99) {
  return groups.slice(0, max).map(g => `<li class="w-row">
        ${pill(data.routes[g.route])}
        <span class="w-head"><span class="sr">vers </span>${esc(g.head)}</span>
        <span class="w-when">${g.next.map(n => when(n.wait, n.at)).join('<span class="w-sep" aria-hidden="true"> · </span><span class="sr">, puis </span>')}</span>
      </li>`).join('')
}

const credit = '<p class="w-muted w-credit">Horaires théoriques, sans retards en temps réel. Données : Pays de Gex Agglo (Licence Ouverte) · <a href="./a-propos.html" target="_blank" rel="noopener">Maillage, service indépendant</a>.</p>'
const linkHtml = (href: string, label: string, cls = 'w-link') =>
  `<a class="${cls}" href="${esc(href)}" target="_blank" rel="noopener">${label}<span class="sr"> (nouvel onglet)</span> ↗</a>`

/** Bandeau compact (page d'accueil, colonne) : une ligne par arrêt, prochain départ de chaque direction. */
function renderCompact(data: WData, now: { date: string; sec: number }) {
  const rows = data.stops.map(stop => {
    // un départ par direction (la ligne la plus tôt), pour tenir en une ligne par arrêt
    const seen = new Set<string>()
    const items = groupsOf(data, stop, now).filter(g => (seen.has(g.head) ? false : (seen.add(g.head), true))).slice(0, 2).map(g => {
      const r = data.routes[g.route]
      return `<span class="w-chip">${pill(r)}<span class="sr">vers </span><span class="w-dir">${esc(g.head.replace(/^Genève, gare Cornavin$/, 'Genève Cornavin'))}</span> ${when(g.next[0].wait, g.next[0].at)}</span>`
    })
    return `<li class="w-crow"><span class="w-cstop">${esc(shortName(data, stop))}</span>${items.length ? items.join('') : '<span class="w-muted">pas de départ avant demain</span>'}</li>`
  }).join('')
  root.innerHTML = `
    <div class="w-ctop"><h2>Prochains bus à ${esc(data.name)}</h2>${linkHtml(lien, 'Itinéraire', 'w-link w-small')}</div>
    <ul class="w-clist">${rows}</ul>`
}

/** « Comment venir » à un lieu de la commune : arrêts les plus proches, marche, départs, itinéraire prérempli. */
function renderVenir(data: WData, now: { date: string; sec: number }) {
  const q = norm(lieuParam)
  const l = q ? (data.lieux ?? []).find(x => norm(x[0]) === q) ?? (data.lieux ?? []).find(x => norm(x[0]).includes(q)) : undefined
  if (!l) {
    root.innerHTML = `<p class="w-muted">Lieu introuvable${lieuParam ? ` : « ${esc(lieuParam)} »` : ''}. ${linkHtml(lien, 'Calculer un itinéraire')}</p>`
    return
  }
  const [nom, , type, lat, lon] = l
  const near = data.stops.map(s => ({ s, m: metres({ lat, lon }, s) })).sort((a, b) => a.m - b.m).slice(0, 2)
    .filter((x, k) => k === 0 || x.m < 900)
  const walk = (m: number) => Math.max(1, Math.round(m * 1.3 / 75)) // détour des rues ≈ × 1,3 ; 4,5 km/h
  const vers = lienFourni ? lien
    : new URL(`./?reseau=${reseau}&src=encart-venir&commune=${commune}&vers=${lat.toFixed(5)},${lon.toFixed(5)},${encodeURIComponent(nom)}`, location.href).toString()
  const blocks = near.map(({ s, m }) => `<section class="w-stop" aria-label="Arrêt ${esc(s.name)}">
      <h3>${esc(shortName(data, s))} <span class="w-walk">· ${walk(m)} min à pied</span></h3>
      <ul>${rowsHtml(data, groupsOf(data, s, now), 4) || '<li class="w-muted">Aucun départ dans les prochaines 24 h.</li>'}</ul>
    </section>`).join('')
  root.innerHTML = `
    <header class="w-top"><h2>Venir en bus · ${esc(nom)}</h2><p class="w-muted">${esc(type)}</p></header>
    ${blocks}
    <footer class="w-foot">
      ${linkHtml(vers, 'Itinéraire jusqu’ici', 'w-btn')}
      ${credit}
    </footer>`
}

function render(data: WData) {
  const now = parisNow()
  // données expirées (flux GTFS échu ou fenêtre précalculée dépassée) : on ne fait pas croire qu'il n'y a pas de bus
  if ((data.valid_until && now.date > data.valid_until) || dayIndex(data.window_start, now.date) >= data.window_days) {
    root.innerHTML = `
      <header class="w-top"><h2>Prochains départs à ${esc(data.name)}</h2></header>
      <p class="w-muted">Les horaires sont en cours de mise à jour.${data.operator_url ? ' En attendant, consultez le site du transporteur.' : ''}</p>
      ${data.operator_url && /^https:\/\//.test(data.operator_url) ? `<footer class="w-foot"><a class="w-link" href="${esc(data.operator_url)}" target="_blank" rel="noopener">Site du transporteur<span class="sr"> (nouvel onglet)</span> ↗</a></footer>` : ''}`
    root.removeAttribute('aria-busy')
    return
  }
  if (format !== 'complet') {
    if (format === 'compact') renderCompact(data, now)
    else renderVenir(data, now)
    root.removeAttribute('aria-busy')
    return
  }
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
      <p class="w-muted">Horaires théoriques, sans retards en temps réel. Données : Pays de Gex Agglo (Licence Ouverte) · <a href="./a-propos.html" target="_blank" rel="noopener">Maillage, service indépendant</a>.</p>
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
    window.parent.postMessage({ type: 'maillage-widget-height', commune: frameId, height }, '*')
  }
}).observe(root)

// Messages et lieux publiés par la mairie (espace mairie) : contenus/<territoire>/messages.json, lieux.json
interface WMessage { commune: string; titre: string; texte: string; debut: string; fin: string; gravite: string; arrets: string[]; lien: string }
let messages: WMessage[] = []
const contenu = (f: string) => fetch(`./contenus/${reseau}/${f}`, { cache: 'no-cache' }).then(r => (r.ok ? r.json() : null)).catch(() => null)

function bannerHtml(data: WData) {
  const today = parisNow().date
  const names = new Set(data.stops.map(s => s.name))
  const active = messages.filter(m => m.debut <= today && m.fin >= today && (m.commune === commune || m.arrets.some(a => names.has(a))))
    .sort((a, b) => (a.gravite === b.gravite ? 0 : a.gravite === 'perturbation' ? -1 : 1))
  if (!active.length) return ''
  return `<div class="w-msgs" role="status">${active.map(m => `<div class="w-msg${m.gravite === 'perturbation' ? ' warn' : ''}">
    <strong>${esc(m.titre)}</strong>${format !== 'compact' && m.texte ? `<span>${esc(m.texte)}</span>` : ''}${m.lien && format !== 'compact' ? ` <a class="w-link" href="${esc(m.lien)}" target="_blank" rel="noopener">En savoir plus ↗</a>` : ''}</div>`).join('')}</div>`
}

function draw(data: WData) {
  render(data)
  const b = bannerHtml(data)
  if (b) root.insertAdjacentHTML('afterbegin', b)
}

async function main() {
  try {
    const [res, msg, lieux] = await Promise.all([fetch(`./data/${reseau}/widget-${commune}.json`, { cache: 'no-cache' }), contenu('messages.json'), contenu('lieux.json')])
    if (!res.ok) throw new Error(String(res.status))
    const data: WData = await res.json()
    messages = Array.isArray(msg?.messages) ? msg.messages : []
    if (lieux) {
      const masques = new Set((lieux.masques ?? []).filter((m: any) => m.commune === commune).map((m: any) => m.cle))
      data.lieux = (data.lieux ?? []).filter(([n, , , lat, lon]) => !masques.has(`${n}|${lat.toFixed(5)}|${lon.toFixed(5)}`))
      for (const a of lieux.ajouts ?? []) if (a.commune === commune) data.lieux.push([a.nom, a.cat, a.cat, a.lat, a.lon])
    }
    draw(data)
    setInterval(() => draw(data), 30_000)
  } catch {
    root.innerHTML = `<p class="w-muted">Horaires indisponibles pour le moment. <a class="w-link" href="${esc(lien)}" target="_blank" rel="noopener">Ouvrir le calculateur ↗</a></p>`
    root.removeAttribute('aria-busy')
  }
}
main()
