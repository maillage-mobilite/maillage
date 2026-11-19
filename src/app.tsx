import { BRAND } from './brand'
import type { ComponentChildren } from 'preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { Fares, Kind, Network, Pois, Trip, loadFares, loadNetwork, parisNow, distance, usePois } from './net'
import type { Journey } from './router'
import { MapView, type Basemap } from './map'
import { Icon, RoutePreview } from './ui'
import { RoutePreviewCard } from './preview'
import { useFavorites } from './store'
import { Explore, PlaceView, RouteView } from './views/explore'
import { TripView, TripState, initialTrip } from './views/trip'
import { AlertsView, FaresView, MeView, SourcesView } from './views/more'
import { TENANT, storageKey } from './tenant'
import { TenantPicker } from './views/tenants'
import { PoiBadge } from './poiIcons'

type Tab = 'explore' | 'trip' | 'alerts' | 'me'
type Detail = { kind: 'place'; id: number } | { kind: 'route'; id: number; from?: number; dir?: number } | { kind: 'sources' } | { kind: 'fares' }
type Snap = 'peek' | 'half' | 'full'
type Pos = { lat: number; lon: number; simulated: boolean; reason?: string; at?: string }

const isDesktop = () => window.matchMedia('(min-width: 900px)').matches

type MapKey = Kind | 'gares' | 'lieux'
const ALL_KINDS: MapKey[] = ['urbain', 'tad', 'scolaire', 'region', 'gares', 'lieux']
// v3 : ajout des lieux utiles, affichés par défaut (une préférence v2 les aurait masqués)
const KINDS_KEY = storageKey('map-kinds:v3')

/** Types de lignes affichés sur la carte, mémorisés sur l'appareil. */
function useMapKinds() {
  const [kinds, setKinds] = useState<MapKey[]>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(KINDS_KEY) || 'null')
      if (Array.isArray(v)) return ALL_KINDS.filter(k => v.includes(k))
    } catch { /* stockage indisponible */ }
    return ALL_KINDS
  })
  useEffect(() => { try { localStorage.setItem(KINDS_KEY, JSON.stringify(kinds)) } catch { /* idem */ } }, [kinds])
  const toggle = (k: MapKey) => setKinds(cur => (cur.includes(k) ? cur.filter(x => x !== k) : ALL_KINDS.filter(x => x === k || cur.includes(x))))
  const setGroup = (group: MapKey[], on: boolean) => setKinds(cur => ALL_KINDS.filter(x => (group.includes(x) ? on : cur.includes(x))))
  return { kinds, toggle, setGroup }
}

/** Filtre de la carte : réseau local (urbain, TAD, scolaire) et cars Région. */
function MapFilters({ net, pois, kinds, toggle, setGroup, legendOpen, onLegend }: {
  net: Network; pois: Pois | null; kinds: MapKey[]; toggle: (k: MapKey) => void; setGroup: (g: MapKey[], on: boolean) => void
  /** Puce « Lieux » : ouvre la légende des catégories (qui sert aussi de filtre). */
  legendOpen: boolean; onLegend: () => void
}) {
  const has = (k: Kind) => net.routes.some(r => r.kind === k)
  const local = (['urbain', 'tad', 'scolaire'] as Kind[]).filter(has)
  const labels: Record<MapKey, string> = { urbain: 'Urbain', tad: 'TAD', scolaire: 'Scolaire', region: 'Région', train: 'Trains', gares: 'Trains', lieux: 'Lieux' }
  const swatch = (k: MapKey) => (k === 'gares' ? '#1e3a8a' : net.routes.find(r => r.kind === k)?.color ?? '#888')
  const allLocal = local.every(k => kinds.includes(k))
  const chip = (k: MapKey) => k === 'lieux' ? (
    <button key={k} class={`map-chip${kinds.includes(k) ? ' on' : ''}`} aria-expanded={legendOpen} aria-haspopup="dialog" onClick={onLegend}
      title="Lieux utiles : légende et choix des catégories">
      <span class="swatch swatch-lieux" aria-hidden="true" />Lieux<span class="chip-caret" aria-hidden="true">▾</span>
    </button>
  ) : (
    <button key={k} class={`map-chip${kinds.includes(k) ? ' on' : ''}`} aria-pressed={kinds.includes(k)} onClick={() => toggle(k)}
      title={kinds.includes(k) ? `Masquer les lignes ${labels[k].toLowerCase()}` : `Afficher les lignes ${labels[k].toLowerCase()}`}>
      <span class={`swatch swatch-${k}`} style={{ background: swatch(k) }} aria-hidden="true" />{labels[k]}
    </button>
  )
  return (
    <div class="map-filters" role="group" aria-label="Lignes et lieux affichés sur la carte">
      <div class="filter-group">
        <button class={`group-label${allLocal ? ' on' : ''}`} aria-pressed={allLocal} onClick={() => setGroup(local, !allLocal)}
          title={allLocal ? `Masquer tout le réseau ${net.tenant.name}` : `Afficher tout le réseau ${net.tenant.name}`}>{net.tenant.name}</button>
        {local.map(chip)}
      </div>
      {(has('region') || net.stations.length > 0 || pois) && <div class="filter-group">{has('region') && chip('region')}{net.stations.length > 0 && chip('gares')}{pois && chip('lieux')}</div>}
    </div>
  )
}

export function App() {
  const [net, setNet] = useState<Network | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { if (TENANT) loadNetwork().then(setNet).catch(e => setError(String(e.message ?? e))) }, [])
  if (!TENANT) return <TenantPicker />
  if (error) return <div class="splash"><strong>Impossible de charger les données</strong><p>{error}</p></div>
  if (!net) return <div class="splash"><div class="spinner" /><p>Chargement du réseau…</p></div>
  return <Shell net={net} />
}

function Shell({ net }: { net: Network }) {
  const [now, setNow] = useState(parisNow())
  useEffect(() => { const t = setInterval(() => setNow(parisNow()), 30000); return () => clearInterval(t) }, [])

  // position : réelle si disponible et sur le territoire, sinon simulée au pôle principal (configuration du territoire)
  const hub = useMemo(() => {
    const d = net.tenant.default_place
    if (d) {
      const p = net.places.reduce((a, b) => (distance(d.lat, d.lon, b.lat, b.lon) < distance(d.lat, d.lon, a.lat, a.lon) ? b : a))
      return { lat: p.lat, lon: p.lon, at: d.name }
    }
    const p = net.places.filter(p => /gare rout/i.test(p.name)).sort((a, b) => b.feeds.length - a.feeds.length)[0] ?? net.places[0]
    return { lat: p.lat, lon: p.lon, at: p.name }
  }, [net])
  const [pos, setPos] = useState<Pos>({ ...hub, simulated: true, reason: 'Localisation en attente' })
  const locate = () => {
    if (!('geolocation' in navigator)) { setPos(p => ({ ...p, reason: 'Géolocalisation indisponible' })); return }
    navigator.geolocation.getCurrentPosition(
      g => {
        const { latitude: lat, longitude: lon } = g.coords
        if (distance(lat, lon, net.tenant.center[1], net.tenant.center[0]) > 25000) setPos({ ...hub, simulated: true, reason: 'Vous êtes hors du territoire' })
        else { setPos({ lat, lon, simulated: false }); setFocus({ lat, lon, zoom: 15.5, key: Date.now() }) }
      },
      () => setPos({ ...hub, simulated: true, reason: 'Localisation refusée' }),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 },
    )
  }
  useEffect(locate, [])

  const [fares, setFares] = useState<Fares | null>(null)
  useEffect(() => { loadFares().then(setFares) }, [])
  const { fav, toggle, saveLocation, removeLocation } = useFavorites()
  const mapKinds = useMapKinds()
  const pois = usePois()
  const [legendOpen, setLegendOpen] = useState(false)
  const POI_HIDDEN_KEY = storageKey('poi-hidden')
  const [poiHidden, setPoiHiddenState] = useState<string[]>(() => {
    try { const v = JSON.parse(localStorage.getItem(POI_HIDDEN_KEY) || '[]'); return Array.isArray(v) ? v : [] } catch { return [] }
  })
  const setPoiHidden = (v: string[]) => { setPoiHiddenState(v); try { localStorage.setItem(POI_HIDDEN_KEY, JSON.stringify(v)) } catch { /* stockage indisponible */ } }
  const [basemap, setBasemapState] = useState<Basemap>(() => {
    try { const v = localStorage.getItem('maillage:basemap'); if (v === 'plan' || v === 'satellite' || v === 'velo') return v } catch { /* stockage indisponible */ }
    return 'plan'
  })
  const setBasemap = (b: Basemap) => { setBasemapState(b); try { localStorage.setItem('maillage:basemap', b) } catch { /* idem */ } }
  const [basemapOpen, setBasemapOpen] = useState(false)
  const [mapReady, setMapReady] = useState(false)
  const [tab, setTab] = useState<Tab>('explore')
  const [stack, setStack] = useState<Detail[]>([])
  const basemapBtn = useRef<HTMLButtonElement>(null)
  const [trip, setTripState] = useState<TripState>(initialTrip)
  const setTrip = (u: (s: TripState) => TripState) => setTripState(u)
  const [focus, setFocus] = useState<{ lat: number; lon: number; zoom?: number; key: number } | null>(null)
  const [snap, setSnap] = useState<Snap>('half')
  // aperçu d'une ligne survolée dans le panneau
  const [previewRoute, setPreviewRoute] = useState<number | null>(null)
  const preview = useMemo(() => ({
    enter: (r: number) => setPreviewRoute(r),
    leave: (r: number) => setPreviewRoute(cur => (cur === r ? null : cur)),
  }), [])

  const detail = stack[stack.length - 1]
  useEffect(() => setPreviewRoute(null), [tab, stack.length, trip.selected])
  const push = (d: Detail) => { setStack(s => [...s, d]); setTab('explore') }
  const back = () => setStack(s => s.slice(0, -1))
  const openPlace = (i: number) => {
    push({ kind: 'place', id: i })
    setFocus({ lat: net.places[i].lat, lon: net.places[i].lon, key: Date.now() })
    if (snap === 'peek') setSnap('half')
  }
  const openRoute = (i: number, from?: number, dir?: number) => { push({ kind: 'route', id: i, from, dir }); if (snap === 'peek') setSnap('half') }
  const goTo = (i: number) => {
    const p = net.places[i]
    setTrip(s => ({ ...s, to: { lat: p.lat, lon: p.lon, label: p.name } }))
    setTab('trip')
  }
  const goLocation = (l: { lat: number; lon: number; name: string }) => {
    setTrip(s => ({ ...s, from: null, to: { lat: l.lat, lon: l.lon, label: l.name }, when: null, mode: 'depart', selected: null, booking: null }))
    setTab('trip')
    if (snap === 'peek') setSnap('half')
  }
  // arrivée depuis l'encart « Comment venir » : ?vers=lat,lon,nom → itinéraire déjà rempli jusqu'au lieu
  useEffect(() => {
    const v = new URLSearchParams(location.search).get('vers')
    const m = v?.match(/^(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+),(.{1,120})$/)
    if (!m) return
    const [lat, lon] = [Number(m[1]), Number(m[2])]
    if (distance(lat, lon, net.tenant.center[1], net.tenant.center[0]) > 60000) return // hors territoire : ignoré
    goLocation({ lat, lon, name: m[3] })
  }, [])
  const manageLocations = () => { setStack([]); setTab('me') }
  const goFrom = (i: number) => {
    const p = net.places[i]
    setTrip(s => ({ ...s, from: { lat: p.lat, lon: p.lon, label: p.name }, focusTo: s.to ? s.focusTo : s.focusTo + 1 }))
    setTab('trip')
  }

  // fiche ligne : le parcours de la course choisie est tracé seul, les autres variantes restent en retrait
  const [routeTrip, setRouteTrip] = useState<{ trip: Trip; date: string } | null>(null)
  const onRouteView = tab === 'explore' && detail?.kind === 'route'
  const highlightRoute = onRouteView && !routeTrip ? detail.id : null
  const tripJourney = useMemo<Journey | null>(() => {
    if (!onRouteView || !routeTrip) return null
    const t = routeTrip.trip, last = t.stops.length - 1
    return { dep: t.dep[0], arr: t.arr[last], transfers: 0, walkMeters: 0, hasBooking: t.booking, key: `route:${t.i}`,
      legs: [{ type: 'ride', trip: t, date: routeTrip.date, fromPos: 0, toPos: last, dep: t.dep[0], arr: t.arr[last], booking: t.booking }] }
  }, [onRouteView, routeTrip])
  const journey = tab === 'trip' && trip.result && trip.selected != null
    ? (trip.selected === -1 ? trip.result.directWalk ?? null : trip.result.journeys[trip.selected] ?? null)
    : tripJourney

  // hauteur de la feuille → marges de la carte
  const [sheetH, setSheetH] = useState(0)
  const [desktop, setDesktop] = useState(isDesktop())
  useEffect(() => { const f = () => setDesktop(isDesktop()); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f) }, [])
  const padding = desktop ? { top: 70, bottom: 20, left: 420 } : { top: 110, bottom: Math.min(sheetH, window.innerHeight * 0.62), left: 0 }

  // titre de la page : l'écran courant, puis le territoire (RGAA 8.6)
  const viewTitle = tab === 'explore'
    ? detail?.kind === 'place' ? net.places[detail.id]?.name ?? 'Arrêt'
      : detail?.kind === 'route' ? `Ligne ${net.routes[detail.id]?.short ?? ''} ${net.routes[detail.id]?.long ?? ''}`.trim()
      : detail?.kind === 'sources' ? 'Sources et qualité des données' : detail?.kind === 'fares' ? 'Tarifs' : 'Explorer'
    : tab === 'trip' ? (trip.to?.label ? `Itinéraire vers ${trip.to.label}` : 'Itinéraire') : tab === 'alerts' ? 'Info trafic' : 'Mes trajets'
  useEffect(() => { document.title = `${viewTitle} · ${net.tenant.name} · ${BRAND.name}` }, [viewTitle])

  let content: ComponentChildren
  if (tab === 'explore') {
    if (detail?.kind === 'place') content = <PlaceView key={detail.id} net={net} id={detail.id} now={now} pos={pos} fav={fav} toggleFav={toggle} onBack={back} onRoute={openRoute} onGo={goTo} onFrom={goFrom} />
    else if (detail?.kind === 'route') content = <RouteView key={`${detail.id}-${detail.from ?? ''}-${detail.dir ?? ''}`} net={net} id={detail.id} fromPlace={detail.from} fromDir={detail.dir} now={now} fav={fav} toggleFav={toggle} onBack={back} onPlace={openPlace} onTrip={setRouteTrip} />
    else if (detail?.kind === 'sources') content = <SourcesView net={net} onBack={back} />
    else if (detail?.kind === 'fares' && fares) content = <FaresView net={net} fares={fares} onBack={back} />
    else content = <Explore net={net} now={now} pos={pos} fav={fav} onPlace={openPlace} onRoute={openRoute} onSearch={() => { setTrip(s => ({ ...s, focusTo: s.focusTo + 1 })); setTab('trip'); setSnap('full') }}
      onGoLocation={goLocation} onManageLocations={manageLocations} />
  } else if (tab === 'trip') content = <TripView net={net} now={now} pos={pos} state={trip} setState={setTrip} fares={fares} saved={fav.locations} onManageLocations={manageLocations} />
  else if (tab === 'alerts') content = <AlertsView net={net} />
  else content = <MeView net={net} fav={fav} near={pos} saveLocation={saveLocation} removeLocation={removeLocation} onPlace={openPlace} onRoute={openRoute} onSources={() => push({ kind: 'sources' })} onFares={() => push({ kind: 'fares' })} hasFares={!!fares} />

  const switchTab = (t: Tab) => {
    if (t === tab && t === 'explore') setStack([])
    if (t === tab && t === 'trip') setTrip(s => ({ ...s, selected: null, booking: null }))
    setTab(t)
    if (snap === 'peek') setSnap('half')
  }

  return (
    <RoutePreview.Provider value={preview}>
    <div class={`shell${desktop ? ' desktop' : ''}${!desktop && snap === 'full' ? ' sheet-full' : ''}`}>
      <a class="skip-link" href="#contenu" onClick={e => { e.preventDefault(); if (snap === 'peek') setSnap('half'); document.getElementById('contenu')?.focus() }}>Aller au contenu</a>
      {!mapReady && <div class="map-loading" role="status"><div class="spinner" /> Chargement de la carte…</div>}
      <MapView net={net} basemap={basemap} onReady={() => setMapReady(true)} user={pos} highlightRoute={highlightRoute} previewRoute={previewRoute} journey={journey} focus={focus} padding={padding} onPlace={openPlace} onRoute={openRoute} kinds={mapKinds.kinds}
        pois={pois} poiHidden={poiHidden} onPoi={p => goLocation({ lat: p.lat, lon: p.lon, name: p.name.toLowerCase().includes(p.commune.toLowerCase()) ? p.name : `${p.name}, ${p.commune}` })} />
      {previewRoute != null && previewRoute !== highlightRoute && <RoutePreviewCard net={net} route={previewRoute} now={now} />}
      <header class="top-zone">
      <MapFilters net={net} pois={pois} {...mapKinds} legendOpen={legendOpen} onLegend={() => { setLegendOpen(o => !o); setBasemapOpen(false) }} />
      {legendOpen && pois && (
        <PoiLegend pois={pois} shown={mapKinds.kinds.includes('lieux')} onShown={() => mapKinds.toggle('lieux')}
          hidden={poiHidden} setHidden={setPoiHidden} onClose={() => setLegendOpen(false)} />
      )}
      <div class="topbar">
        <span class="brand"><span class="brand-mark" aria-hidden="true" />{BRAND.name}<em>{net.tenant.name}</em></span>
        <span class="top-actions">
          <span class="basemap-wrap">
            <button ref={basemapBtn} class="icon-btn floating" onClick={() => setBasemapOpen(o => !o)} aria-label="Fond de carte" aria-expanded={basemapOpen} aria-controls="basemap-menu"><Icon name="layers" /></button>
            {basemapOpen && (
              <div class="basemap-menu" id="basemap-menu" role="group" aria-label="Fond de carte"
                onKeyDown={e => { if (e.key === 'Escape') { setBasemapOpen(false); basemapBtn.current?.focus() } }}>
                {([['plan', 'Plan', 'Rues et lieux'], ['satellite', 'Satellite', 'Photos aériennes IGN'], ['velo', 'Vélo', 'Pistes et bandes cyclables']] as const).map(([k, label, sub]) => (
                  <button key={k} aria-pressed={basemap === k} class={`basemap-opt${basemap === k ? ' on' : ''}`}
                    onClick={() => { setBasemap(k); setBasemapOpen(false); basemapBtn.current?.focus() }}>
                    <span class={`basemap-thumb thumb-${k}`} aria-hidden="true" />
                    <span><strong>{label}</strong><small>{sub}</small></span>
                  </button>
                ))}
              </div>
            )}
          </span>
          <button class="icon-btn floating" onClick={locate} aria-label="Me localiser"><Icon name="locate" /></button>
        </span>
      </div>
      </header>
      <Sheet snap={snap} setSnap={setSnap} onHeight={setSheetH} desktop={desktop} scrollKey={`${tab}|${stack.length}|${trip.selected}|${trip.booking}`}>
        {content}
      </Sheet>
      <nav class="tabbar" aria-label="Navigation principale">
        {([['explore', 'map', 'Explorer'], ['trip', 'route', 'Itinéraire'], ['alerts', 'alert', 'Info trafic'], ['me', 'star', 'Mes trajets']] as const).map(([t, ic, label]) => (
          <button key={t} class={tab === t ? 'on' : ''} aria-current={tab === t ? 'page' : undefined} onClick={() => switchTab(t)}>
            <Icon name={ic} /><span>{label}</span>
          </button>
        ))}
      </nav>
    </div>
    </RoutePreview.Provider>
  )
}

/** Légende des lieux utiles : pictogramme et couleur de chaque catégorie, avec choix des catégories affichées. */
function PoiLegend({ pois, shown, onShown, hidden, setHidden, onClose }: {
  pois: Pois; shown: boolean; onShown: () => void; hidden: string[]; setHidden: (v: string[]) => void; onClose: () => void
}) {
  const count = useMemo(() => { const c: Record<string, number> = {}; for (const p of pois.pois) c[p.cat] = (c[p.cat] ?? 0) + 1; return c }, [pois])
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('input, button')?.focus()
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [])
  return (
    <div class="poi-legend" role="dialog" aria-label="Lieux sur la carte" ref={ref}>
      <div class="poi-legend-head">
        <label class="toggle"><input type="checkbox" checked={shown} onChange={onShown} /> <strong>Lieux sur la carte</strong></label>
        <button class="tip-close" onClick={onClose} aria-label="Fermer la légende"><Icon name="close" size={16} /></button>
      </div>
      <ul class={`poi-legend-list${shown ? '' : ' off'}`}>
        {pois.categories.map(c => {
          const on = !hidden.includes(c.id)
          return (
            <li key={c.id}>
              <button role="checkbox" aria-checked={on} disabled={!shown} class={on ? '' : 'hidden-cat'}
                onClick={() => setHidden(on ? [...hidden, c.id] : hidden.filter(x => x !== c.id))}>
                <PoiBadge cat={c.id} color={c.color} size={24} />
                <span class="poi-legend-label">{c.label}</span>
                <span class="poi-legend-n">{count[c.id] ?? 0}</span>
                <span class="poi-legend-check" aria-hidden="true">{on ? <Icon name="check" size={16} /> : null}</span>
              </button>
            </li>
          )
        })}
      </ul>
      <p class="tip-src">Visibles en zoomant sur un quartier. Touchez un lieu pour ses horaires et l’itinéraire. Données OpenStreetMap.</p>
    </div>
  )
}

/** Feuille glissante (mobile) / panneau latéral (bureau). */
function Sheet({ snap, setSnap, onHeight, desktop, scrollKey, children }: {
  snap: Snap; setSnap: (s: Snap) => void; onHeight: (h: number) => void; desktop: boolean; scrollKey: string; children: ComponentChildren
}) {
  const ref = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const drag = useRef<{ y: number; h: number } | null>(null)
  const [dragH, setDragH] = useState<number | null>(null)
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800
  const tabbar = 64
  const heights: Record<Snap, number> = { peek: 0.3 * vh, half: 0.56 * vh, full: vh - tabbar - 56 }
  const h = dragH ?? heights[snap]
  useEffect(() => { onHeight(desktop ? 0 : h + tabbar) }, [h, desktop])
  useEffect(() => { scroller.current?.scrollTo({ top: 0 }) }, [scrollKey])

  const down = (e: PointerEvent) => { drag.current = { y: e.clientY, h }; (e.target as HTMLElement).setPointerCapture(e.pointerId) }
  const move = (e: PointerEvent) => { if (drag.current) setDragH(Math.max(heights.peek * 0.6, Math.min(heights.full, drag.current.h + drag.current.y - e.clientY))) }
  const up = () => {
    if (!drag.current) return
    const cur = dragH ?? h
    drag.current = null
    setDragH(null)
    const best = (Object.keys(heights) as Snap[]).sort((a, b) => Math.abs(heights[a] - cur) - Math.abs(heights[b] - cur))[0]
    setSnap(best)
  }
  const cycle = () => setSnap(snap === 'peek' ? 'half' : snap === 'half' ? 'full' : 'half')

  return (
    <div ref={ref} class={`sheet${dragH != null ? ' dragging' : ''}`} style={desktop ? undefined : { height: `${h}px` }}>
      {!desktop && (
        <div class="handle" onPointerDown={down as any} onPointerMove={move as any} onPointerUp={up} onPointerCancel={up}>
          <button class="handle-bar" onClick={cycle} aria-label={snap === 'full' ? 'Réduire le panneau' : 'Agrandir le panneau'} />
        </div>
      )}
      <main class="sheet-scroll" id="contenu" tabIndex={-1} ref={scroller as any}>{children}</main>
    </div>
  )
}
