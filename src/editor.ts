// Éditeur de tracés (editeur.html), servi par le seul serveur de développement : corrige à la main le tracé
// d'une ligne entre deux arrêts consécutifs. Les corrections vont dans pipeline/tenants/<territoire>-corrections.json
// (points d'accès /__editeur de vite.config.ts) ; le pipeline les applique après le calcul automatique.
import { Map as MLMap, LngLatBounds, type GeoJSONSource, type MapMouseEvent } from 'maplibre-gl'
import type * as GeoJSON from 'geojson'
import 'maplibre-gl/dist/maplibre-gl.css'
import './editor.css'

type LngLat = [number, number]
interface Stop { name: string; lat: number; lon: number }
interface Correction { id: string; route: string; kind: string; from: Stop; to: Stop; coords: LngLat[]; mode: string; updated: string }
interface Troncon { key: string; a: Stop; b: Stop; trips: number; order: number; slice: LngLat[] | null; flags: string[]; score: number
  /** milieu du plus long segment droit (> 350 m), à confirmer auprès du moteur OSRM */
  straight?: { mid: LngLat; len: number } }
interface Route { i: number; short: string; long: string; color: string; text: string; kind: string }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const app = $('app')
if (!import.meta.env.DEV) {
  app.innerHTML = '<p class="ed-blocked">L’éditeur de tracés ne fonctionne qu’en local, avec <code>npm run dev</code>.</p>'
  throw new Error('éditeur indisponible hors développement')
}

// ------------------------------------------------------------------ géométrie (mètres, approximation locale)
const KY = 110540
const kx = (lat: number) => 111320 * Math.cos(lat * Math.PI / 180)
const dist = (a: LngLat, b: LngLat) => Math.hypot((a[0] - b[0]) * kx(a[1]), (a[1] - b[1]) * KY)
const length = (c: LngLat[]) => c.slice(1).reduce((s, p, i) => s + dist(c[i], p), 0)

/** Simplification (Douglas-Peucker, tolérance en mètres) : moins de poignées à manipuler. */
function simplify(c: LngLat[], tol = 2): LngLat[] {
  if (c.length < 3) return c
  const keep = new Uint8Array(c.length); keep[0] = keep[c.length - 1] = 1
  const stack: [number, number][] = [[0, c.length - 1]]
  while (stack.length) {
    const [i, j] = stack.pop()!
    let bi = -1, bd = tol
    for (let k = i + 1; k < j; k++) { const q = project([c[i], c[j]], c[k], 0, Infinity); if (q && q.off > bd) { bd = q.off; bi = k } }
    if (bi > 0) { keep[bi] = 1; stack.push([i, bi], [bi, j]) }
  }
  return c.filter((_, k) => keep[k])
}

/** Projection de p sur la polyligne à partir de l'abscisse minAlong : écart le plus faible sous maxOff. */
function project(line: LngLat[], p: LngLat, minAlong = 0, maxOff = 60) {
  let best: { s: number; i: number; q: LngLat; off: number } | null = null
  let acc = 0
  const k = kx(p[1])
  for (let i = 0; i < line.length - 1; i++) {
    const ax = (line[i][0] - p[0]) * k, ay = (line[i][1] - p[1]) * KY
    const bx = (line[i + 1][0] - p[0]) * k, by = (line[i + 1][1] - p[1]) * KY
    const vx = bx - ax, vy = by - ay, L = Math.hypot(vx, vy)
    const t = L < 1e-9 ? 0 : Math.max(0, Math.min(1, -(ax * vx + ay * vy) / (L * L)))
    const off = Math.hypot(ax + t * vx, ay + t * vy), s = acc + t * L
    if (s >= minAlong - 1e-6 && off <= maxOff && (!best || off < best.off - 5)) {
      best = { s, i, q: [line[i][0] + t * (line[i + 1][0] - line[i][0]), line[i][1] + t * (line[i + 1][1] - line[i][1])], off }
      if (off < 5) break
    }
    acc += L
  }
  return best
}

/** Portion d'un tracé entre deux arrêts (projetés dans l'ordre), ou null. */
function slice(line: LngLat[], a: LngLat, b: LngLat): LngLat[] | null {
  const pa = project(line, a)
  if (!pa) return null
  const pb = project(line, b, pa.s + 1)
  if (!pb) return null
  return [pa.q, ...line.slice(pa.i + 1, pb.i + 1), pb.q]
}

/** Défauts probables d'un tronçon : détour, corde droite, demi-tours. */
function diagnose(c: LngLat[], a: Stop, b: Stop) {
  const flags: string[] = []
  const L = length(c), D = dist([a.lon, a.lat], [b.lon, b.lat])
  if (L > 2.2 * D + 300) flags.push(`détour ×${(L / Math.max(D, 1)).toFixed(1)}`)
  // plus long segment droit : suspect seulement s'il quitte la route (vérifié ensuite par le moteur OSRM)
  let longSeg = 0, mid: LngLat = c[0]
  c.slice(1).forEach((p, i) => { const d = dist(c[i], p); if (d > longSeg) { longSeg = d; mid = [(c[i][0] + p[0]) / 2, (c[i][1] + p[1]) / 2] } })
  let u = 0
  for (let i = 1; i < c.length - 1; i++) {
    const v1 = [(c[i][0] - c[i - 1][0]) * kx(c[i][1]), (c[i][1] - c[i - 1][1]) * KY]
    const v2 = [(c[i + 1][0] - c[i][0]) * kx(c[i][1]), (c[i + 1][1] - c[i][1]) * KY]
    const l1 = Math.hypot(v1[0], v1[1]), l2 = Math.hypot(v2[0], v2[1])
    if (l1 > 1 && l2 > 1 && (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2) < -0.9) u++
  }
  if (u) flags.push(`${u} demi-tour${u > 1 ? 's' : ''}`)
  return { flags, score: (L > 2.2 * D + 300 ? 3 : 0) + u, straight: longSeg > 350 ? { mid, len: longSeg } : undefined }
}

// ------------------------------------------------------------------ état
let reseau = ''
let routes: Route[] = []
let stops: Stop[] = []
let trips: [number, number[]][] = []
let lines: { route: number; coords: LngLat[] }[] = []
/** tracé d'affichage de l'application (un seul trait par rue) */
let shown: { route: number; coords: LngLat[] }[] = []
let showVariants = false
let corrections: Correction[] = []
let current: Route | null = null
let troncons: Troncon[] = []
let sel: Troncon | null = null
let edit: LngLat[] = []
let mode: 'points' | 'route' | 'main' = 'points'
let vias: LngLat[] = []
let tab: 'troncons' | 'suspects' = 'troncons'
const status = (t: string) => { $('statut').textContent = t }
const today = () => new Date().toISOString().slice(0, 10)
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
const keyOf = (r: Route, a: Stop, b: Stop) => `${r.short}|${r.kind}|${a.name}|${b.name}`
const corrOf = (r: Route, t: Troncon) => corrections.find(c => c.route === r.short && c.kind === r.kind
  && dist([c.from.lon, c.from.lat], [t.a.lon, t.a.lat]) < 60 && dist([c.to.lon, c.to.lat], [t.b.lon, t.b.lat]) < 60)

// ------------------------------------------------------------------ carte
const EMPTY = { type: 'FeatureCollection', features: [] } as GeoJSON.FeatureCollection
const map = new MLMap({ container: 'carte', style: 'https://tiles.openfreemap.org/styles/positron', center: [6.1, 46.25], zoom: 12, attributionControl: false, doubleClickZoom: false })
;(window as any).__ed = map
const ready = new Promise<void>(ok => map.on('load', () => ok()))
const src = (id: string) => map.getSource(id) as GeoJSONSource

ready.then(() => {
  for (const id of ['route-lines', 'route-variants', 'route-stops', 'sel', 'edit-line', 'edit-pts', 'vias']) map.addSource(id, { type: 'geojson', data: EMPTY })
  // trait unique, comme dans l'application ; variantes brutes (un tracé par parcours) à la demande
  map.addLayer({ id: 'route-lines', type: 'line', source: 'route-lines', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 4, 'line-opacity': 0.75 } })
  map.addLayer({ id: 'route-variants', type: 'line', source: 'route-variants', layout: { visibility: 'none' }, paint: { 'line-color': '#111827', 'line-width': 1.2, 'line-opacity': 0.6, 'line-dasharray': [2, 2] } })
  map.addLayer({ id: 'sel', type: 'line', source: 'sel', paint: { 'line-color': '#111827', 'line-width': 7, 'line-opacity': 0.18 } })
  map.addLayer({ id: 'route-stops', type: 'circle', source: 'route-stops', paint: { 'circle-radius': 4.5, 'circle-color': '#fff', 'circle-stroke-color': '#111', 'circle-stroke-width': 1.5 } })
  map.addLayer({ id: 'route-stops-label', type: 'symbol', source: 'route-stops', minzoom: 14,
    layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0, 1], 'text-anchor': 'top' },
    paint: { 'text-color': '#111', 'text-halo-color': '#fff', 'text-halo-width': 1.5 } })
  map.addLayer({ id: 'edit-line', type: 'line', source: 'edit-line', paint: { 'line-color': '#e11d48', 'line-width': 4 } })
  map.addLayer({ id: 'edit-pts', type: 'circle', source: 'edit-pts',
    paint: { 'circle-radius': ['case', ['get', 'fixed'], 7, ['get', 'r']], 'circle-color': ['case', ['get', 'fixed'], '#111827', '#fff'], 'circle-stroke-color': '#e11d48', 'circle-stroke-width': 2 } })
  map.addLayer({ id: 'vias', type: 'circle', source: 'vias', paint: { 'circle-radius': 7, 'circle-color': '#2563eb', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } })

  // déplacement d'un point (souris)
  let dragging = -1
  map.on('mousedown', 'edit-pts', (e: any) => {
    if (mode !== 'points' || e.originalEvent.button !== 0 || e.originalEvent.altKey) return
    const i = e.features[0].properties.i as number
    if (i === 0 || i === edit.length - 1) return // extrémités : accrochées aux arrêts
    e.preventDefault(); dragging = i; map.getCanvas().style.cursor = 'grabbing'
  })
  map.on('mousemove', (e: MapMouseEvent) => {
    if (dragging < 0) return
    edit[dragging] = [e.lngLat.lng, e.lngLat.lat]; drawEdit()
  })
  map.on('mouseup', () => { if (dragging >= 0) { dragging = -1; map.getCanvas().style.cursor = ''; dirty() } })
  // suppression : clic droit ou Alt+clic sur un point
  const remove = (e: any) => {
    const i = e.features?.[0]?.properties.i as number
    if (mode !== 'points' || i == null || i === 0 || i === edit.length - 1) return
    edit.splice(i, 1); drawEdit(); dirty()
  }
  map.on('contextmenu', 'edit-pts', (e: any) => { e.preventDefault(); remove(e) })
  map.on('click', (e: MapMouseEvent) => {
    if (!sel) return
    const pt = map.queryRenderedFeatures(e.point, { layers: ['edit-pts'] })[0]
    if (mode === 'points') {
      if (pt && (e.originalEvent as MouseEvent).altKey) return remove({ features: [pt] })
      if (pt) return
      // clic sur le trait : nouveau point dans le segment le plus proche
      const near = map.queryRenderedFeatures([[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]], { layers: ['edit-line'] })
      if (!near.length) return
      const p: LngLat = [e.lngLat.lng, e.lngLat.lat]
      let bi = 0, bd = Infinity
      for (let i = 0; i < edit.length - 1; i++) {
        const q = project([edit[i], edit[i + 1]], p, 0, Infinity)
        if (q && q.off < bd) { bd = q.off; bi = i }
      }
      edit.splice(bi + 1, 0, p); drawEdit(); dirty()
    } else if (mode === 'route') {
      vias.push([e.lngLat.lng, e.lngLat.lat]); reroute()
    } else {
      edit.splice(edit.length - 1, 0, [e.lngLat.lng, e.lngLat.lat]); drawEdit(); dirty()
    }
  })
  map.on('mouseenter', 'edit-pts', () => { if (mode === 'points') map.getCanvas().style.cursor = 'grab' })
  map.on('mouseleave', 'edit-pts', () => { if (dragging < 0) map.getCanvas().style.cursor = '' })
})

function drawEdit() {
  src('edit-line').setData(edit.length ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: edit } } as any : EMPTY)
  const r = edit.length > 60 ? 3 : edit.length > 25 ? 4 : 5 // poignées plus discrètes quand elles sont nombreuses
  src('edit-pts').setData({ type: 'FeatureCollection', features: edit.map((c, i) => ({ type: 'Feature', properties: { i, r, fixed: i === 0 || i === edit.length - 1 }, geometry: { type: 'Point', coordinates: c } })) } as any)
  src('vias').setData({ type: 'FeatureCollection', features: vias.map(c => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } })) } as any)
  if (sel && edit.length > 1) {
    const L = length(edit), D = dist([sel.a.lon, sel.a.lat], [sel.b.lon, sel.b.lat])
    $('ed-info').textContent = `${Math.round(L)} m de tracé pour ${Math.round(D)} m à vol d’oiseau · ${edit.length} points`
  }
}

let modified = false
const dirty = () => { modified = true; ($('b-enregistrer') as HTMLButtonElement).disabled = false }

async function reroute() {
  if (!sel) return
  const pts: LngLat[] = [edit[0], ...vias, edit[edit.length - 1]]
  status('Calcul par la chaussée…')
  try {
    const r = await (await fetch(`/__editeur/route?reseau=${reseau}&coords=${pts.map(p => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join(';')}`)).json()
    if (r.code !== 'Ok') throw new Error(r.message ?? r.erreur ?? r.code)
    const c: LngLat[] = r.routes[0].geometry.coordinates
    edit = simplify([pts[0], ...c.slice(1, -1), pts[pts.length - 1]], 2) // extrémités : les points d'accroche exacts
    drawEdit(); dirty(); status(`Itinéraire par la chaussée : ${Math.round(r.routes[0].distance)} m`)
  } catch (e) { status(`Moteur OSRM indisponible (${(e as Error).message}) : lancer pipeline/osrm/osrm.sh start-genf ou start`) }
}

// ------------------------------------------------------------------ données
async function loadReseau(id: string) {
  reseau = id
  suspects = null
  ;($('reseau') as HTMLSelectElement).value = id
  status('Chargement…')
  const bust = `?t=${Date.now()}`
  const [net, geo, disp, corr] = await Promise.all([
    fetch(`/data/${id}/network.json${bust}`).then(r => r.json()),
    fetch(`/data/${id}/lines.geojson${bust}`).then(r => r.json()),
    fetch(`/data/${id}/lines-display.geojson${bust}`).then(r => r.ok ? r.json() : { features: [] }),
    fetch(`/__editeur/corrections?reseau=${id}`).then(r => r.json()),
  ])
  routes = net.routes.map((r: any[], i: number) => ({ i, short: r[0], long: r[1], color: '#' + r[2], text: '#' + r[3], kind: r[4] }))
  stops = net.stops.map((s: any[]) => ({ name: s[0], lat: s[1], lon: s[2] }))
  trips = net.trips.map((t: any[]) => [t[0], t[4]])
  lines = geo.features.map((f: any) => ({ route: f.properties.route, coords: f.geometry.coordinates }))
  shown = disp.features.map((f: any) => ({ route: f.properties.route, coords: f.geometry.coordinates }))
  corrections = corr.corrections ?? []
  const sel$ = $('ligne') as HTMLSelectElement
  const seen = new Set<string>()
  const editable = routes.filter(r => r.kind !== 'train' && !seen.has(`${r.short}|${r.kind}`) && seen.add(`${r.short}|${r.kind}`))
  sel$.innerHTML = editable.map(r => `<option value="${r.i}">${esc(r.short)} · ${esc(r.long)}</option>`).join('')
  const b = new LngLatBounds()
  for (const s of stops) b.extend([s.lon, s.lat])
  await ready
  status(`${corrections.length} correction${corrections.length > 1 ? 's' : ''} enregistrée${corrections.length > 1 ? 's' : ''}`)
  if (editable.length) selectRoute(editable[0].i, true)
}

/** Tronçons (paires d'arrêts consécutifs) d'une ligne, toutes variantes de même numéro, avec diagnostic. */
function tronconsOf(r: Route): Troncon[] {
  const same = routes.filter(x => x.short === r.short && x.kind === r.kind).map(x => x.i)
  const geoms = lines.filter(l => same.includes(l.route)).map(l => l.coords)
  const out = new Map<string, Troncon>()
  const longest = trips.filter(t => same.includes(t[0])).sort((a, b) => b[1].length - a[1].length)
  longest.forEach(([, st]) => st.slice(0, -1).forEach((s, k) => {
    const a = stops[s], b = stops[st[k + 1]]
    const key = keyOf(r, a, b)
    const t = out.get(key)
    if (t) { t.trips++; return }
    out.set(key, { key, a, b, trips: 1, order: out.size, slice: null, flags: [], score: 0 })
  }))
  for (const t of out.values()) {
    for (const g of geoms) { const s = slice(g, [t.a.lon, t.a.lat], [t.b.lon, t.b.lat]); if (s) { t.slice = s; break } }
    if (t.slice) Object.assign(t, diagnose(t.slice, t.a, t.b))
    else { t.flags = ['tracé introuvable']; t.score = 1 }
  }
  return [...out.values()].sort((a, b) => a.order - b.order)
}

/** Confirme les segments droits suspects : signalés seulement si leur milieu est à plus de 15 m d'une route. */
const checked = new Map<string, number | null>()
async function checkStraight(ts: Troncon[]) {
  const todo = ts.filter(t => t.straight && !checked.has(`${t.straight.mid}`))
  if (todo.length) {
    try {
      const r = await (await fetch(`/__editeur/nearest?reseau=${reseau}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ points: todo.map(t => t.straight!.mid) }) })).json()
      todo.forEach((t, k) => checked.set(`${t.straight!.mid}`, r.distances?.[k] ?? null))
    } catch { /* moteur indisponible : pas de signalement */ }
  }
  for (const t of ts) {
    if (!t.straight) continue
    const d = checked.get(`${t.straight.mid}`)
    // au-delà d'1 km : point hors de la zone couverte par le moteur (cars Région vers Bellegarde…), pas un défaut
    if (d != null && d > 15 && d < 1000 && !t.flags.some(f => f.startsWith('hors route'))) { t.flags.push(`hors route ${Math.round(d)} m`); t.score += 3 }
  }
}

function selectRoute(i: number, fit = false) {
  current = routes[i]
  ;($('ligne') as HTMLSelectElement).value = String(i)
  const same = routes.filter(x => x.short === current!.short && x.kind === current!.kind).map(x => x.i)
  const fc = (ls: typeof lines) => ({ type: 'FeatureCollection', features: ls.filter(l => same.includes(l.route)).map(l => ({ type: 'Feature', properties: { color: current!.color }, geometry: { type: 'LineString', coordinates: l.coords } })) }) as any
  src('route-lines').setData(fc(shown.length ? shown : lines))
  src('route-variants').setData(fc(lines))
  const nv = lines.filter(l => same.includes(l.route)).length
  $('variantes').textContent = `Voir les ${nv} tracés bruts (un par parcours)`
  const ids = new Set<number>(trips.filter(t => same.includes(t[0])).flatMap(t => t[1]))
  src('route-stops').setData({ type: 'FeatureCollection', features: [...ids].map(s => ({ type: 'Feature', properties: { name: stops[s].name }, geometry: { type: 'Point', coordinates: [stops[s].lon, stops[s].lat] } })) } as any)
  troncons = tronconsOf(current)
  checkStraight(troncons).then(() => { if (tab === 'troncons') renderList() })
  if (fit && ids.size) { const b = new LngLatBounds(); for (const s of ids) b.extend([stops[s].lon, stops[s].lat]); map.fitBounds(b, { padding: 40, duration: 0 }) }
  closeEdit()
  renderList()
}

let suspects: { r: Route; t: Troncon; n: string }[] | null = null
async function computeSuspects() {
  const seen = new Set<string>(), all: { r: Route; t: Troncon; n: string }[] = []
  for (const r of routes) {
    if (r.kind === 'train' || seen.has(`${r.short}|${r.kind}`)) continue
    seen.add(`${r.short}|${r.kind}`)
    for (const t of tronconsOf(r)) if (!corrOf(r, t)) all.push({ r, t, n: '' })
  }
  await checkStraight(all.map(x => x.t))
  suspects = all.filter(x => x.t.score > 0).sort((a, b) => b.t.score - a.t.score).slice(0, 60)
}

function renderList() {
  const ul = $('liste')
  let items: { r: Route; t: Troncon; n: string }[]
  if (tab === 'troncons' && current) items = troncons.map((t, k) => ({ r: current!, t, n: String(k + 1) }))
  else items = (suspects ?? []).filter(x => !corrOf(x.r, x.t))
  ul.innerHTML = items.map(({ r, t, n }, k) => {
    const c = corrOf(r, t)
    const badges = [...(c ? ['<span class="badge ok">corrigé</span>'] : []), ...t.flags.map(f => `<span class="badge">${esc(f)}</span>`)].join('')
    const pill = tab === 'suspects' ? `<span class="pill" style="background:${r.color};color:${r.text}">${esc(r.short)}</span>` : ''
    return `<li><button data-k="${k}" class="${sel?.key === t.key ? 'on' : ''}"><span class="n">${n}</span><span class="t">${pill}${esc(t.a.name)} → ${esc(t.b.name)}</span><span class="b">${badges}</span></button></li>`
  }).join('') || '<li class="ed-muted" style="padding:8px">Rien à revoir.</li>'
  ul.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    const it = items[Number(b.dataset.k)]
    if (current?.i !== it.r.i) { current = it.r; ($('ligne') as HTMLSelectElement).value = String(it.r.i); troncons = tronconsOf(it.r); selectRouteKeepTab(it.r.i) }
    openEdit(troncons.find(x => x.key === it.t.key) ?? it.t)
    renderList()
  }))
}

function selectRouteKeepTab(i: number) {
  const keep = tab
  selectRoute(i)
  tab = keep
}

// ------------------------------------------------------------------ édition
function setMode(m: typeof mode) {
  mode = m
  for (const [id, v] of [['m-points', 'points'], ['m-route', 'route'], ['m-main', 'main']] as const) {
    $(id).classList.toggle('on', mode === v); $(id).setAttribute('aria-pressed', String(mode === v))
  }
  const aide = {
    points: 'Glissez un point pour le déplacer · clic sur le trait rouge pour ajouter un point · clic droit ou Alt+clic sur un point pour le supprimer. Les points noirs (arrêts) restent fixes.',
    route: 'Cliquez un ou plusieurs points de passage sur la carte, dans l’ordre : le tronçon suit la chaussée en passant par eux.',
    main: 'Le tronçon repart en ligne droite ; chaque clic ajoute un point juste avant l’arrivée. Pour un passage absent d’OpenStreetMap (voie bus, gare routière).',
  }
  $('ed-aide').textContent = aide[mode]
  if (mode === 'route') { vias = []; drawEdit() }
  if (mode === 'main' && edit.length) { edit = [edit[0], edit[edit.length - 1]]; vias = []; drawEdit(); dirty() }
}

function openEdit(t: Troncon) {
  sel = t
  const c = current ? corrOf(current, t) : undefined
  edit = c ? c.coords.map(p => [p[0], p[1]] as LngLat) : (t.slice ? simplify(t.slice.map(p => [p[0], p[1]] as LngLat), 1) : [[t.a.lon, t.a.lat], [t.b.lon, t.b.lat]])
  vias = []
  modified = false
  $('edition').hidden = false
  $('ed-titre').textContent = `${current?.short} · ${t.a.name} → ${t.b.name}`
  $('b-supprimer').hidden = !c
  ;($('b-enregistrer') as HTMLButtonElement).disabled = true
  src('sel').setData(t.slice ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: t.slice } } as any : EMPTY)
  setMode('points')
  drawEdit()
  const b = new LngLatBounds()
  for (const p of edit) b.extend(p)
  b.extend([t.a.lon, t.a.lat]); b.extend([t.b.lon, t.b.lat])
  map.fitBounds(b, { padding: 80, maxZoom: 17.5, duration: 400 })
}

function closeEdit() {
  sel = null; edit = []; vias = []
  $('edition').hidden = true
  if (map.isStyleLoaded()) { src('sel').setData(EMPTY); drawEdit() }
}

async function saveAll(msg: string) {
  const r = await fetch(`/__editeur/corrections?reseau=${reseau}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ corrections }) })
  const j = await r.json()
  if (!r.ok) throw new Error(j.erreur ?? r.status)
  status(`${msg} · ${j.n} correction${j.n > 1 ? 's' : ''} dans pipeline/tenants/${reseau}-corrections.json. « Appliquer à la carte » pour voir le résultat.`)
}

$('b-enregistrer').addEventListener('click', async () => {
  if (!sel || !current || edit.length < 2) return
  const old = corrOf(current, sel)
  const c: Correction = {
    id: keyOf(current, sel.a, sel.b), route: current.short, kind: current.kind,
    from: { name: sel.a.name, lat: sel.a.lat, lon: sel.a.lon }, to: { name: sel.b.name, lat: sel.b.lat, lon: sel.b.lon },
    coords: edit.map(p => [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6] as LngLat), mode, updated: today(),
  }
  corrections = [...corrections.filter(x => x !== old), c]
  try { await saveAll('Correction enregistrée'); modified = false; ($('b-enregistrer') as HTMLButtonElement).disabled = true; $('b-supprimer').hidden = false; renderList() }
  catch (e) { status(`Échec de l’enregistrement : ${(e as Error).message}`) }
})
$('b-supprimer').addEventListener('click', async () => {
  if (!sel || !current) return
  const old = corrOf(current, sel)
  if (!old || !confirm(`Retirer la correction « ${sel.a.name} → ${sel.b.name} » ? Le tracé calculé reviendra après « Appliquer à la carte ».`)) return
  corrections = corrections.filter(x => x !== old)
  try { await saveAll('Correction retirée'); openEdit(sel); renderList() } catch (e) { status(`Échec : ${(e as Error).message}`) }
})
$('b-annuler').addEventListener('click', () => { if (sel) openEdit(sel) })
$('variantes').addEventListener('click', () => {
  showVariants = !showVariants
  map.setLayoutProperty('route-variants', 'visibility', showVariants ? 'visible' : 'none')
  $('variantes').setAttribute('aria-pressed', String(showVariants))
})
$('m-points').addEventListener('click', () => setMode('points'))
$('m-route').addEventListener('click', () => setMode('route'))
$('m-main').addEventListener('click', () => setMode('main'))
$('b-appliquer').addEventListener('click', async () => {
  const b = $('b-appliquer') as HTMLButtonElement
  b.disabled = true; status('Application des corrections…')
  try {
    const r = await fetch(`/__editeur/apply?reseau=${reseau}`, { method: 'POST' })
    const j = await r.json()
    if (!r.ok) throw new Error(j.erreur ?? r.status)
    const keep = sel?.key, route = current?.i
    await loadReseau(reseau)
    if (route != null) selectRoute(route)
    const t = troncons.find(x => x.key === keep)
    if (t) openEdit(t)
    status(`Appliqué : ${j.appliquees}/${j.corrections} corrections, ${j.traces_modifies} tracés modifiés${j.lignes_redessinees?.length ? `, lignes redessinées : ${j.lignes_redessinees.join(', ')}` : ''}.${j.sans_effet?.length ? ` Sans effet : ${j.sans_effet.join(' ; ')}` : ''}`)
  } catch (e) { status(`Échec : ${(e as Error).message}`) }
  finally { b.disabled = false }
})
$('ligne').addEventListener('change', e => { tab = 'troncons'; syncTabs(); selectRoute(Number((e.target as HTMLSelectElement).value), true) })
$('reseau').addEventListener('change', e => loadReseau((e.target as HTMLSelectElement).value))
const syncTabs = () => { $('tab-troncons').setAttribute('aria-selected', String(tab === 'troncons')); $('tab-suspects').setAttribute('aria-selected', String(tab === 'suspects')) }
$('tab-troncons').addEventListener('click', () => { tab = 'troncons'; syncTabs(); renderList() })
$('tab-suspects').addEventListener('click', async () => {
  tab = 'suspects'; syncTabs()
  if (!suspects) { status('Recherche des tronçons à revoir (contrôle des segments droits auprès du moteur OSRM)…'); $('liste').innerHTML = ''; await computeSuspects() }
  renderList(); status('Tronçons classés du plus suspect au moins suspect (détour, passage hors route, demi-tours), hors tronçons déjà corrigés.')
})
window.addEventListener('beforeunload', e => { if (modified) e.preventDefault() })

// ------------------------------------------------------------------ démarrage
fetch('/data/tenants.json').then(r => r.json()).then((ts: { id: string; name: string }[]) => {
  ;($('reseau') as HTMLSelectElement).innerHTML = ts.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')
  const pref = new URLSearchParams(location.search).get('reseau')
  loadReseau(ts.find(t => t.id === pref)?.id ?? ts[0].id)
})
