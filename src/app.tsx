import type { ComponentChildren } from 'preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { Network, loadNetwork, parisNow, distance } from './net'
import { MapView } from './map'
import { Icon } from './ui'
import { useFavorites } from './store'
import { Explore, PlaceView, RouteView } from './views/explore'
import { TripView, TripState, initialTrip } from './views/trip'
import { AlertsView, MeView, SourcesView } from './views/more'

type Tab = 'explore' | 'trip' | 'alerts' | 'me'
type Detail = { kind: 'place'; id: number } | { kind: 'route'; id: number } | { kind: 'sources' }
type Snap = 'peek' | 'half' | 'full'
type Pos = { lat: number; lon: number; simulated: boolean; reason?: string }

const isDesktop = () => window.matchMedia('(min-width: 900px)').matches

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

  const { fav, toggle } = useFavorites()
  const [tab, setTab] = useState<Tab>('explore')
  const [stack, setStack] = useState<Detail[]>([])
  const [trip, setTripState] = useState<TripState>(initialTrip)
  const setTrip = (u: (s: TripState) => TripState) => setTripState(u)
  const [focus, setFocus] = useState<{ lat: number; lon: number; zoom?: number; key: number } | null>(null)
  const [snap, setSnap] = useState<Snap>('half')

  const detail = stack[stack.length - 1]
  const push = (d: Detail) => { setStack(s => [...s, d]); setTab('explore') }
  const back = () => setStack(s => s.slice(0, -1))
  const openPlace = (i: number) => {
    push({ kind: 'place', id: i })
    setFocus({ lat: net.places[i].lat, lon: net.places[i].lon, key: Date.now() })
    if (snap === 'peek') setSnap('half')
  }
  const openRoute = (i: number) => { push({ kind: 'route', id: i }); if (snap === 'peek') setSnap('half') }
  const goTo = (i: number) => {
    const p = net.places[i]
    setTrip(s => ({ ...s, to: { lat: p.lat, lon: p.lon, label: p.name } }))
    setTab('trip')
  }
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
  const padding = desktop ? { top: 20, bottom: 20, left: 420 } : { top: 70, bottom: Math.min(sheetH, window.innerHeight * 0.62), left: 0 }

  let content: ComponentChildren
  if (tab === 'explore') {
    if (detail?.kind === 'place') content = <PlaceView key={detail.id} net={net} id={detail.id} now={now} pos={pos} fav={fav} toggleFav={toggle} onBack={back} onRoute={openRoute} onGo={goTo} onFrom={goFrom} />
    else if (detail?.kind === 'route') content = <RouteView key={detail.id} net={net} id={detail.id} now={now} fav={fav} toggleFav={toggle} onBack={back} onPlace={openPlace} />
    else if (detail?.kind === 'sources') content = <SourcesView net={net} onBack={back} />
    else content = <Explore net={net} now={now} pos={pos} fav={fav} onPlace={openPlace} onRoute={openRoute} onSearch={() => { setTrip(s => ({ ...s, focusTo: s.focusTo + 1 })); setTab('trip'); setSnap('full') }} />
  } else if (tab === 'trip') content = <TripView net={net} now={now} pos={pos} state={trip} setState={setTrip} />
  else if (tab === 'alerts') content = <AlertsView net={net} />
  else content = <MeView net={net} fav={fav} onPlace={openPlace} onRoute={openRoute} onSources={() => push({ kind: 'sources' })} />

  const switchTab = (t: Tab) => {
    if (t === tab && t === 'explore') setStack([])
    if (t === tab && t === 'trip') setTrip(s => ({ ...s, selected: null, booking: null }))
    setTab(t)
    if (snap === 'peek') setSnap('half')
  }

  return (
    <div class={`shell${desktop ? ' desktop' : ''}`}>
      <MapView net={net} user={pos} highlightRoute={highlightRoute} journey={journey} focus={focus} padding={padding} onPlace={openPlace} />
      <div class="topbar">
        <span class="brand"><span class="brand-mark" aria-hidden="true" />Maillage<em>démo · {net.tenant.name}</em></span>
        <button class="icon-btn floating" onClick={locate} aria-label="Me localiser"><Icon name="locate" /></button>
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
