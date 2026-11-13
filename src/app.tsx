import type { ComponentChildren } from 'preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { Fares, Kind, Network, loadFares, loadNetwork, parisNow, distance } from './net'
import { MapView, type Basemap } from './map'
import { Icon, RoutePreview } from './ui'
import { RoutePreviewCard } from './preview'
import { useFavorites } from './store'
import { Explore, PlaceView, RouteView } from './views/explore'
import { TripView, TripState, initialTrip } from './views/trip'
import { AlertsView, FaresView, MeView, SourcesView } from './views/more'

type Tab = 'explore' | 'trip' | 'alerts' | 'me'
type Detail = { kind: 'place'; id: number } | { kind: 'route'; id: number; from?: number; dir?: number } | { kind: 'sources' } | { kind: 'fares' }
type Snap = 'peek' | 'half' | 'full'
type Pos = { lat: number; lon: number; simulated: boolean; reason?: string }

const isDesktop = () => window.matchMedia('(min-width: 900px)').matches

type MapKey = Kind | 'gares'
const ALL_KINDS: MapKey[] = ['urbain', 'tad', 'scolaire', 'region', 'gares']
const KINDS_KEY = 'maillage:map-kinds:v2'

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
function MapFilters({ net, kinds, toggle, setGroup }: { net: Network; kinds: MapKey[]; toggle: (k: MapKey) => void; setGroup: (g: MapKey[], on: boolean) => void }) {
  const local: Kind[] = ['urbain', 'tad', 'scolaire']
  const labels: Record<MapKey, string> = { urbain: 'Urbain', tad: 'TAD', scolaire: 'Scolaire', region: 'Région', train: 'Trains', gares: 'Trains' }
  const swatch = (k: MapKey) => (k === 'gares' ? '#1e3a8a' : net.routes.find(r => r.kind === k)?.color ?? '#888')
  const allLocal = local.every(k => kinds.includes(k))
  const chip = (k: MapKey) => (
    <button key={k} class={`map-chip${kinds.includes(k) ? ' on' : ''}`} aria-pressed={kinds.includes(k)} onClick={() => toggle(k)}
      title={kinds.includes(k) ? `Masquer les lignes ${labels[k].toLowerCase()}` : `Afficher les lignes ${labels[k].toLowerCase()}`}>
      <span class={`swatch swatch-${k}`} style={{ background: swatch(k) }} aria-hidden="true" />{labels[k]}
    </button>
  )
  return (
    <div class="map-filters" role="group" aria-label="Types de lignes affichés sur la carte">
      <div class="filter-group">
        <button class={`group-label${allLocal ? ' on' : ''}`} aria-pressed={allLocal} onClick={() => setGroup(local, !allLocal)}
          title={allLocal ? `Masquer tout le réseau ${net.tenant.name}` : `Afficher tout le réseau ${net.tenant.name}`}>{net.tenant.name}</button>
        {local.map(chip)}
      </div>
      <div class="filter-group">{chip('region')}{net.stations.length > 0 && chip('gares')}</div>
    </div>
  )
}

export function App() {
  const [net, setNet] = useState<Network | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { loadNetwork().then(setNet).catch(e => setError(String(e.message ?? e))) }, [])
  if (error) return <div class="splash"><strong>Impossible de charger les données</strong><p>{error}</p></div>
  if (!net) return <div class="splash"><div class="spinner" /><p>Chargement du réseau…</p></div>
  return <Shell net={net} />
}

function Shell({ net }: { net: Network }) {
  const [now, setNow] = useState(parisNow())
  useEffect(() => { const t = setInterval(() => setNow(parisNow()), 30000); return () => clearInterval(t) }, [])

  // position : réelle si disponible et sur le territoire, sinon simulée à la gare routière
  const hub = useMemo(() => net.places.filter(p => /gare rout/i.test(p.name)).sort((a, b) => b.feeds.length - a.feeds.length)[0], [net])
  const [pos, setPos] = useState<Pos>({ lat: hub.lat, lon: hub.lon, simulated: true, reason: 'Localisation en attente' })
  const locate = () => {
    if (!('geolocation' in navigator)) { setPos(p => ({ ...p, reason: 'Géolocalisation indisponible' })); return }
    navigator.geolocation.getCurrentPosition(
      g => {
        const { latitude: lat, longitude: lon } = g.coords
        if (distance(lat, lon, net.tenant.center[1], net.tenant.center[0]) > 25000) setPos({ lat: hub.lat, lon: hub.lon, simulated: true, reason: 'Vous êtes hors du territoire' })
        else { setPos({ lat, lon, simulated: false }); setFocus({ lat, lon, zoom: 15.5, key: Date.now() }) }
      },
      () => setPos({ lat: hub.lat, lon: hub.lon, simulated: true, reason: 'Localisation refusée' }),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 },
    )
  }
  useEffect(locate, [])

  const [fares, setFares] = useState<Fares | null>(null)
  useEffect(() => { loadFares().then(setFares) }, [])
  const { fav, toggle, saveLocation, removeLocation } = useFavorites()
  const mapKinds = useMapKinds()
  const [basemap, setBasemapState] = useState<Basemap>(() => {
    try { const v = localStorage.getItem('maillage:basemap'); if (v === 'plan' || v === 'satellite' || v === 'velo') return v } catch { /* stockage indisponible */ }
    return 'plan'
  })
  const setBasemap = (b: Basemap) => { setBasemapState(b); try { localStorage.setItem('maillage:basemap', b) } catch { /* idem */ } }
  const [basemapOpen, setBasemapOpen] = useState(false)
  const [mapReady, setMapReady] = useState(false)
  const [tab, setTab] = useState<Tab>('explore')
  const [stack, setStack] = useState<Detail[]>([])
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
  const manageLocations = () => { setStack([]); setTab('me') }
  const goFrom = (i: number) => {
    const p = net.places[i]
    setTrip(s => ({ ...s, from: { lat: p.lat, lon: p.lon, label: p.name }, focusTo: s.to ? s.focusTo : s.focusTo + 1 }))
    setTab('trip')
  }

  const highlightRoute = tab === 'explore' && detail?.kind === 'route' ? detail.id : null
  const journey = tab === 'trip' && trip.result && trip.selected != null
    ? (trip.selected === -1 ? trip.result.directWalk ?? null : trip.result.journeys[trip.selected] ?? null)
    : null

  // hauteur de la feuille → marges de la carte
  const [sheetH, setSheetH] = useState(0)
  const [desktop, setDesktop] = useState(isDesktop())
  useEffect(() => { const f = () => setDesktop(isDesktop()); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f) }, [])
  const padding = desktop ? { top: 70, bottom: 20, left: 420 } : { top: 110, bottom: Math.min(sheetH, window.innerHeight * 0.62), left: 0 }

  let content: ComponentChildren
  if (tab === 'explore') {
    if (detail?.kind === 'place') content = <PlaceView key={detail.id} net={net} id={detail.id} now={now} pos={pos} fav={fav} toggleFav={toggle} onBack={back} onRoute={openRoute} onGo={goTo} onFrom={goFrom} />
    else if (detail?.kind === 'route') content = <RouteView key={`${detail.id}-${detail.from ?? ''}-${detail.dir ?? ''}`} net={net} id={detail.id} fromPlace={detail.from} fromDir={detail.dir} now={now} fav={fav} toggleFav={toggle} onBack={back} onPlace={openPlace} />
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
      {!mapReady && <div class="map-loading" role="status"><div class="spinner" /> Chargement de la carte…</div>}
      <MapView net={net} basemap={basemap} onReady={() => setMapReady(true)} user={pos} highlightRoute={highlightRoute} previewRoute={previewRoute} journey={journey} focus={focus} padding={padding} onPlace={openPlace} onRoute={openRoute} kinds={mapKinds.kinds} />
      {previewRoute != null && previewRoute !== highlightRoute && <RoutePreviewCard net={net} route={previewRoute} now={now} />}
      <MapFilters net={net} {...mapKinds} />
      <div class="topbar">
        <span class="brand"><span class="brand-mark" aria-hidden="true" />Maillage<em>démo · {net.tenant.name}</em></span>
        <span class="top-actions">
          <span class="basemap-wrap">
            <button class="icon-btn floating" onClick={() => setBasemapOpen(o => !o)} aria-label="Fond de carte" aria-expanded={basemapOpen} aria-haspopup="menu"><Icon name="layers" /></button>
            {basemapOpen && (
              <div class="basemap-menu" role="menu" aria-label="Fond de carte">
                {([['plan', 'Plan', 'Rues et lieux'], ['satellite', 'Satellite', 'Photos aériennes IGN'], ['velo', 'Vélo', 'Pistes et bandes cyclables']] as const).map(([k, label, sub]) => (
                  <button key={k} role="menuitemradio" aria-checked={basemap === k} class={`basemap-opt${basemap === k ? ' on' : ''}`}
                    onClick={() => { setBasemap(k); setBasemapOpen(false) }}>
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
      <div class="sheet-scroll" ref={scroller}>{children}</div>
    </div>
  )
}
