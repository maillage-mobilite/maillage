// Carte MapLibre : fond OpenStreetMap (OpenFreeMap), tracés des lignes, pôles d'arrêt, position, itinéraire.
// En production : tuiles PMTiles auto-hébergées (ADR-005). Ici, OpenFreeMap pour aller vite.
import { Map as MLMap, LngLatBounds, type GeoJSONSource, type LngLatBoundsLike, type MapLayerMouseEvent } from 'maplibre-gl'
import type * as GeoJSON from 'geojson'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useEffect, useRef } from 'preact/hooks'
import type { Network } from './net'
import type { Journey } from './router'

export interface MapProps {
  net: Network
  user: { lat: number; lon: number; simulated: boolean } | null
  highlightRoute: number | null
  journey: Journey | null
  focus: { lat: number; lon: number; zoom?: number; key: number } | null
  padding: { top: number; bottom: number; left: number }
  onPlace: (i: number) => void
}

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

export function MapView(props: MapProps) {
  const el = useRef<HTMLDivElement>(null)
  const map = useRef<MLMap | null>(null)
  const ready = useRef(false)
  const pending = useRef<(() => void)[]>([])
  const onPlace = useRef(props.onPlace)
  onPlace.current = props.onPlace

  const whenReady = (fn: () => void) => (ready.current ? fn() : pending.current.push(fn))

  useEffect(() => {
    const { net } = props
    const m = new MLMap({
      container: el.current!,
      style: 'https://tiles.openfreemap.org/styles/positron',
      center: net.tenant.center,
      zoom: 13.2,
      // Sécurité : le contrôle d'attribution natif passe le HTML fourni par la source de tuiles
      // (tierce) dans DOM.sanitize, vulnérable jusqu'à MapLibre 6.4 (GHSA-jrc7-96c5-q579).
      // On le désactive et on affiche nous-mêmes les crédits, en texte échappé (voir plus bas).
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
    })
    m.touchZoomRotate.disableRotation()
    map.current = m
    if (import.meta.env.DEV) (window as any).__map = m
    m.on('load', () => {
      m.addSource('lines', { type: 'geojson', data: `${import.meta.env.BASE_URL}data/lines.geojson` })
      m.addSource('places', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: net.places.filter(p => p.routes.length).map(p => ({
            type: 'Feature',
            properties: { i: p.i, name: p.name, core: p.feeds.some(f => f === 'urbain' || f === 'tad') ? 1 : 0, n: p.routes.length },
            geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
          })),
        },
      })
      m.addSource('journey', { type: 'geojson', data: EMPTY })
      m.addSource('user', { type: 'geojson', data: EMPTY })

      m.addLayer({ id: 'lines-casing', type: 'line', source: 'lines', layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2, 15, 7], 'line-opacity': 0.9 } })
      m.addLayer({ id: 'lines', type: 'line', source: 'lines', layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.2, 15, 4],
          'line-opacity': ['match', ['get', 'kind'], 'scolaire', 0.3, 'region', 0.35, 0.9],
          'line-dasharray': ['match', ['get', 'kind'], 'tad', ['literal', [1, 1.5]], ['literal', [1, 0]]],
        } })
      m.addLayer({ id: 'places', type: 'circle', source: 'places', minzoom: 11,
        filter: ['any', ['>=', ['zoom'], 13.5], ['==', ['get', 'core'], 1]],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 2, 14, 4.5, 17, 7],
          'circle-color': '#ffffff',
          'circle-stroke-color': '#16302f',
          'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 11, 1, 15, 2],
        } })
      m.addLayer({ id: 'places-label', type: 'symbol', source: 'places', minzoom: 15,
        layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true },
        paint: { 'text-color': '#16302f', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } })
      m.addLayer({ id: 'journey-walk', type: 'line', source: 'journey', filter: ['==', ['get', 'type'], 'walk'],
        layout: { 'line-cap': 'round' }, paint: { 'line-color': '#4b5563', 'line-width': 4, 'line-dasharray': [0.1, 2] } })
      m.addLayer({ id: 'journey-ride-casing', type: 'line', source: 'journey', filter: ['==', ['get', 'type'], 'ride'],
        layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 10 } })
      m.addLayer({ id: 'journey-ride', type: 'line', source: 'journey', filter: ['==', ['get', 'type'], 'ride'],
        layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 6 } })
      m.addLayer({ id: 'journey-stops', type: 'circle', source: 'journey', filter: ['==', ['geometry-type'], 'Point'],
        paint: { 'circle-radius': 6, 'circle-color': '#ffffff', 'circle-stroke-width': 3, 'circle-stroke-color': ['get', 'color'] } })
      m.addLayer({ id: 'user-halo', type: 'circle', source: 'user', paint: { 'circle-radius': 18, 'circle-color': '#2563eb', 'circle-opacity': 0.15 } })
      m.addLayer({ id: 'user', type: 'circle', source: 'user',
        paint: { 'circle-radius': 7, 'circle-color': ['case', ['get', 'simulated'], '#9ca3af', '#2563eb'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2.5 } })

      m.on('click', 'places', (e: MapLayerMouseEvent) => {
        const f = e.features?.[0]
        if (f) onPlace.current(f.properties!.i as number)
      })
      m.on('mouseenter', 'places', () => { m.getCanvas().style.cursor = 'pointer' })
      m.on('mouseleave', 'places', () => { m.getCanvas().style.cursor = '' })
      ready.current = true
      pending.current.splice(0).forEach(fn => fn())
    })
    return () => { m.remove(); map.current = null; ready.current = false }
  }, [])

  // marges selon la feuille / le panneau
  useEffect(() => {
    whenReady(() => map.current!.setPadding({ top: props.padding.top, bottom: props.padding.bottom, left: props.padding.left, right: 0 }))
  }, [props.padding.top, props.padding.bottom, props.padding.left])

  // position
  useEffect(() => {
    whenReady(() => {
      const src = map.current!.getSource('user') as GeoJSONSource
      src.setData(props.user ? {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: { simulated: props.user.simulated }, geometry: { type: 'Point', coordinates: [props.user.lon, props.user.lat] } }],
      } : EMPTY)
    })
  }, [props.user?.lat, props.user?.lon, props.user?.simulated])

  // mise en évidence d'une ligne, ou atténuation du réseau quand un itinéraire est affiché
  useEffect(() => {
    whenReady(() => {
      const m = map.current!
      const r = props.highlightRoute
      const dim = props.journey != null
      const base: any = ['match', ['get', 'kind'], 'scolaire', 0.3, 'region', 0.35, 0.9]
      const opacity: any = r != null ? ['case', ['==', ['get', 'route'], r], 1, 0.1] : dim ? 0.1 : base
      m.setPaintProperty('lines', 'line-opacity', opacity)
      m.setPaintProperty('lines-casing', 'line-opacity', r != null ? ['case', ['==', ['get', 'route'], r], 1, 0] : dim ? 0 : 0.9)
      m.setPaintProperty('places', 'circle-opacity', dim ? 0.3 : 1)
      m.setPaintProperty('places', 'circle-stroke-opacity', dim ? 0.3 : 1)
      m.setPaintProperty('lines', 'line-width', r == null
        ? ['interpolate', ['linear'], ['zoom'], 10, ['match', ['get', 'kind'], 'region', 0.8, 1.2], 15, ['match', ['get', 'kind'], 'region', 2.5, 4]]
        : ['case', ['==', ['get', 'route'], r], ['interpolate', ['linear'], ['zoom'], 10, 3, 15, 7], 1])
      if (r != null) {
        const b = new LngLatBounds()
        let n = 0
        for (const t of props.net.trips) if (t.route === r) for (const s of t.stops) { b.extend([props.net.stops[s].lon, props.net.stops[s].lat]); n++ }
        if (n) m.fitBounds(b as LngLatBoundsLike, { maxZoom: 14.5, duration: 600 })
      }
    })
  }, [props.highlightRoute, props.journey])

  // itinéraire
  useEffect(() => {
    whenReady(() => {
      const m = map.current!
      const src = m.getSource('journey') as GeoJSONSource
      const j = props.journey
      if (!j) { src.setData(EMPTY); return }
      const { net } = props
      const features: GeoJSON.Feature[] = []
      const b = new LngLatBounds()
      for (const l of j.legs) {
        let coords: [number, number][]
        let color = '#4b5563'
        if (l.type === 'walk') coords = [[l.from.lon, l.from.lat], [l.to.lon, l.to.lat]]
        else {
          coords = l.trip.stops.slice(l.fromPos, l.toPos + 1).map(s => [net.stops[s].lon, net.stops[s].lat])
          color = net.routes[l.trip.route].color
          features.push({ type: 'Feature', properties: { color }, geometry: { type: 'Point', coordinates: coords[0] } })
          features.push({ type: 'Feature', properties: { color }, geometry: { type: 'Point', coordinates: coords[coords.length - 1] } })
        }
        coords.forEach(c => b.extend(c))
        features.unshift({ type: 'Feature', properties: { type: l.type, color }, geometry: { type: 'LineString', coordinates: coords } })
      }
      src.setData({ type: 'FeatureCollection', features })
      m.fitBounds(b as LngLatBoundsLike, { maxZoom: 16, duration: 600 })
    })
  }, [props.journey])

  // recentrage
  useEffect(() => {
    if (!props.focus) return
    whenReady(() => map.current!.easeTo({ center: [props.focus!.lon, props.focus!.lat], zoom: props.focus!.zoom ?? Math.max(map.current!.getZoom(), 15), duration: 600 }))
  }, [props.focus?.key])

  return (
    <>
      <div ref={el} class="map" role="region" aria-label="Carte du réseau" />
      <div class="map-credits">
        © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">contributeurs OpenStreetMap</a> ·{' '}
        <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> ·{' '}
        <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a>
      </div>
    </>
  )
}
