// Carte MapLibre : fond OpenStreetMap (OpenFreeMap), tracés des lignes, pôles d'arrêt, position, itinéraire.
// En production : tuiles PMTiles auto-hébergées (ADR-005). Ici, OpenFreeMap pour aller vite.
import { Map as MLMap, LngLatBounds, type GeoJSONSource, type LngLatBoundsLike, type MapMouseEvent } from 'maplibre-gl'
import type * as GeoJSON from 'geojson'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useEffect, useRef, useState } from 'preact/hooks'
import { stationLabel, type Kind, type Network } from './net'
import type { Journey } from './router'
import { Icon, Pill } from './ui'

export interface MapProps {
  net: Network
  user: { lat: number; lon: number; simulated: boolean } | null
  highlightRoute: number | null
  /** Ligne survolée dans le panneau : mise en évidence sans recadrage. */
  previewRoute: number | null
  journey: Journey | null
  focus: { lat: number; lon: number; zoom?: number; key: number } | null
  padding: { top: number; bottom: number; left: number }
  onPlace: (i: number) => void
  onRoute: (i: number) => void
  /** Appelé quand la carte et les couches du réseau sont prêtes. */
  onReady?: () => void
  /** Fond de carte : plan (OSM vectoriel), satellite (IGN) ou vélo (CyclOSM). */
  basemap: Basemap
  /** Types de lignes visibles sur la carte, et 'gares' pour les gares SNCF. */
  kinds: (Kind | 'gares')[]
}

interface HoverItem { route: number; from: string; to: string; both?: boolean }
interface Hover { x: number; y: number; items: HoverItem[]; pinned: boolean; station?: number }

/** Lignes sous le pointeur (tolérance de quelques pixels : les tracés sont fins). */
function linesAt(m: MLMap, x: number, y: number, tol = 7): HoverItem[] {
  const feats = m.queryRenderedFeatures([[x - tol, y - tol], [x + tol, y + tol]], { layers: ['lines'] })
  const seen = new Set<string>()
  const out: HoverItem[] = []
  for (const f of feats) {
    const p = f.properties as any
    const key = `${p.route}|${p.from ?? ''}|${p.to ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ route: p.route, from: p.from ?? '', to: p.to ?? '' })
  }
  // un aller et son retour sur la même ligne → une seule entrée « A ⇄ B »
  const merged: HoverItem[] = []
  for (const it of out) {
    const rev = merged.find(m => m.route === it.route && m.from === it.to && m.to === it.from)
    if (rev) rev.both = true
    else merged.push({ ...it })
  }
  return merged.sort((a, b) => a.route - b.route).slice(0, 5)
}

export type Basemap = 'plan' | 'satellite' | 'velo'

/** Fonds raster ouverts, sans clé d'accès, superposés au plan vectoriel (qui garde les polices). */
const RASTER_BASEMAPS: Record<Exclude<Basemap, 'plan'>, { tiles: string[]; tileSize: number; maxzoom: number }> = {
  // IGN Géoplateforme, orthophotographies (Licence Ouverte)
  satellite: {
    tiles: ['https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/jpeg'],
    tileSize: 256, maxzoom: 19,
  },
  // CyclOSM (OpenStreetMap France) : pistes, bandes, voies vertes, stationnements vélo
  velo: {
    tiles: ['a', 'b', 'c'].map(sub => `https://${sub}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png`),
    tileSize: 256, maxzoom: 19,
  },
}

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

/**
 * Chevron « > » blanc cerné de sombre, orienté vers +x : la couche le fait suivre le sens du tracé.
 * Lisible sur toutes les couleurs de ligne (pas de recoloration SDF, qui dégradait le dessin).
 */
function arrowImage(px = 48) {
  const c = document.createElement('canvas')
  c.width = c.height = px
  const g = c.getContext('2d')!
  const chevron = () => { g.beginPath(); g.moveTo(px * 0.34, px * 0.22); g.lineTo(px * 0.68, px * 0.5); g.lineTo(px * 0.34, px * 0.78); g.stroke() }
  g.lineCap = 'round'
  g.lineJoin = 'round'
  g.strokeStyle = 'rgba(17, 24, 39, 0.85)'
  g.lineWidth = px * 0.24
  chevron()
  g.strokeStyle = '#ffffff'
  g.lineWidth = px * 0.11
  chevron()
  return g.getImageData(0, 0, px, px)
}

/** Opacité des tracés selon leur type (réutilisée pour les flèches). */
const KIND_OPACITY: any = ['match', ['get', 'kind'], 'scolaire', 0.3, 'region', 0.35, 'train', 0.7, 0.9]

export function MapView(props: MapProps) {
  const el = useRef<HTMLDivElement>(null)
  const map = useRef<MLMap | null>(null)
  const ready = useRef(false)
  const pending = useRef<(() => void)[]>([])
  const onPlace = useRef(props.onPlace)
  onPlace.current = props.onPlace
  const onReady = useRef(props.onReady)
  onReady.current = props.onReady
  const [hover, setHover] = useState<Hover | null>(null)
  const hoverRef = useRef<Hover | null>(null)
  const fittedFor = useRef<number | null>(null)
  hoverRef.current = hover

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
      // portions où l'aller et le retour d'une ligne ne suivent pas le même chemin (calculées par le pipeline)
      m.addSource('oneway', { type: 'geojson', data: `${import.meta.env.BASE_URL}data/oneway.geojson` })
      m.addSource('places', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: net.places.filter(p => p.routes.length).map(p => ({
            type: 'Feature',
            properties: { i: p.i, name: p.name, core: p.feeds.some(f => f === 'urbain' || f === 'tad') ? 1 : 0, n: p.routes.length, feeds: p.feeds.join(',') },
            geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
          })),
        },
      })
      m.addSource('stations', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: net.stations.map(st => ({ type: 'Feature', properties: { i: st.i, label: stationLabel(st.name) }, geometry: { type: 'Point', coordinates: [st.lon, st.lat] } })),
        },
      })
      for (const [id, b] of Object.entries(RASTER_BASEMAPS)) {
        m.addSource(`basemap-${id}`, { type: 'raster', tiles: b.tiles, tileSize: b.tileSize, maxzoom: b.maxzoom })
      }
      m.addSource('journey', { type: 'geojson', data: EMPTY })
      m.addSource('user', { type: 'geojson', data: EMPTY })

      // fonds raster sous les couches du réseau (masqués par défaut)
      for (const id of Object.keys(RASTER_BASEMAPS)) {
        m.addLayer({ id: `basemap-${id}`, type: 'raster', source: `basemap-${id}`, layout: { visibility: 'none' },
          paint: { 'raster-opacity': id === 'velo' ? 0.95 : 1 } })
      }
      m.addLayer({ id: 'lines-casing', type: 'line', source: 'lines', layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2, 15, 7], 'line-opacity': 0.9 } })
      m.addLayer({ id: 'lines', type: 'line', source: 'lines', layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.2, 15, 4],
          'line-opacity': ['match', ['get', 'kind'], 'scolaire', 0.3, 'region', 0.35, 'train', 0.7, 0.9],
          'line-dasharray': ['match', ['get', 'kind'], 'tad', ['literal', [1, 1.5]], 'train', ['literal', [3, 1.5]], ['literal', [1, 0]]],
        } })
      m.addImage('maillage-arrow', arrowImage(), { pixelRatio: 2 }) // nom propre : le fond de carte a déjà une icône « arrow »
      // sens de circulation, uniquement là où l'aller et le retour diffèrent ; discret
      m.addLayer({ id: 'lines-arrows', type: 'symbol', source: 'oneway', minzoom: 13.5,
        layout: {
          'symbol-placement': 'line', 'symbol-spacing': ['interpolate', ['linear'], ['zoom'], 13.5, 260, 17, 180],
          'icon-image': 'maillage-arrow', 'icon-size': ['interpolate', ['linear'], ['zoom'], 13.5, 0.5, 17, 0.72],
          'icon-allow-overlap': false, 'icon-padding': 6, 'icon-rotation-alignment': 'map', 'icon-keep-upright': false,
        },
        paint: { 'icon-opacity': 0.9 } })
      m.addLayer({ id: 'lines-hover', type: 'line', source: 'lines', filter: ['==', ['get', 'route'], -1],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4, 15, 8], 'line-opacity': 1 } })
      // ligne survolée ou sélectionnée : mêmes portions, un peu plus visibles et à tous les zooms
      m.addLayer({ id: 'lines-focus-arrows', type: 'symbol', source: 'oneway', filter: ['==', ['get', 'route'], -1],
        layout: {
          'symbol-placement': 'line', 'symbol-spacing': ['interpolate', ['linear'], ['zoom'], 9, 140, 16, 110],
          'icon-image': 'maillage-arrow', 'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.45, 15, 0.7],
          'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-rotation-alignment': 'map', 'icon-keep-upright': false,
        },
        paint: {} })
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
      m.addLayer({ id: 'stations-halo', type: 'circle', source: 'stations',
        paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 6, 14, 12], 'circle-color': '#ffffff', 'circle-opacity': 0.9 } })
      m.addLayer({ id: 'stations', type: 'circle', source: 'stations',
        paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 4, 14, 8], 'circle-color': '#1e3a8a', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } })
      m.addLayer({ id: 'stations-label', type: 'symbol', source: 'stations', minzoom: 9.5,
        layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 12, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-optional': true },
        paint: { 'text-color': '#1e3a8a', 'text-halo-color': '#ffffff', 'text-halo-width': 1.8 } })
      m.addLayer({ id: 'journey-walk', type: 'line', source: 'journey', filter: ['==', ['get', 'type'], 'walk'],
        layout: { 'line-cap': 'round' }, paint: { 'line-color': '#4b5563', 'line-width': 4, 'line-dasharray': [0.1, 2] } })
      m.addLayer({ id: 'journey-ride-casing', type: 'line', source: 'journey', filter: ['==', ['get', 'type'], 'ride'],
        layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 10 } })
      m.addLayer({ id: 'journey-ride', type: 'line', source: 'journey', filter: ['==', ['get', 'type'], 'ride'],
        layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 6 } })
      m.addLayer({ id: 'journey-arrows', type: 'symbol', source: 'journey', filter: ['==', ['get', 'type'], 'ride'],
        layout: {
          'symbol-placement': 'line', 'symbol-spacing': 160, 'icon-image': 'maillage-arrow',
          'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.45, 15, 0.65],
          'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-rotation-alignment': 'map', 'icon-keep-upright': false,
        },
        paint: {} })
      m.addLayer({ id: 'journey-stops', type: 'circle', source: 'journey', filter: ['==', ['geometry-type'], 'Point'],
        paint: { 'circle-radius': 6, 'circle-color': '#ffffff', 'circle-stroke-width': 3, 'circle-stroke-color': ['get', 'color'] } })
      m.addLayer({ id: 'user-halo', type: 'circle', source: 'user', paint: { 'circle-radius': 18, 'circle-color': '#2563eb', 'circle-opacity': 0.15 } })
      m.addLayer({ id: 'user', type: 'circle', source: 'user',
        paint: { 'circle-radius': 7, 'circle-color': ['case', ['get', 'simulated'], '#9ca3af', '#2563eb'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2.5 } })

      // Clic / toucher : un arrêt est prioritaire ; sinon, une ligne ouvre (et épingle) l'info-bulle.
      m.on('click', (e: MapMouseEvent) => {
        const { x, y } = e.point
        const st = m.getLayer('stations') && m.getLayoutProperty('stations', 'visibility') !== 'none'
          ? m.queryRenderedFeatures([[x - 9, y - 9], [x + 9, y + 9]], { layers: ['stations'] })[0] : undefined
        if (st) { setHover({ x, y, items: [], pinned: true, station: st.properties!.i as number }); return }
        const place = m.queryRenderedFeatures([[x - 6, y - 6], [x + 6, y + 6]], { layers: ['places'] })[0]
        if (place) { setHover(null); onPlace.current(place.properties!.i as number); return }
        const items = linesAt(m, x, y, 10)
        setHover(items.length ? { x, y, items, pinned: true } : null)
      })
      // Survol (souris) : info-bulle non épinglée, mise en évidence des lignes concernées.
      let raf = 0
      m.on('mousemove', (e: MapMouseEvent) => {
        cancelAnimationFrame(raf)
        raf = requestAnimationFrame(() => {
          if (hoverRef.current?.pinned) return
          const { x, y } = e.point
          const st = m.getLayoutProperty('stations', 'visibility') !== 'none'
            ? m.queryRenderedFeatures([[x - 8, y - 8], [x + 8, y + 8]], { layers: ['stations'] })[0] : undefined
          if (st) { m.getCanvas().style.cursor = 'pointer'; setHover({ x, y, items: [], pinned: false, station: st.properties!.i as number }); return }
          const onPlaceHit = m.queryRenderedFeatures([[x - 5, y - 5], [x + 5, y + 5]], { layers: ['places'] }).length > 0
          const items = onPlaceHit ? [] : linesAt(m, x, y)
          m.getCanvas().style.cursor = onPlaceHit || items.length ? 'pointer' : ''
          setHover(items.length ? { x, y, items, pinned: false } : null)
        })
      })
      m.getCanvas().addEventListener('mouseleave', () => { if (!hoverRef.current?.pinned) setHover(null) })
      m.on('movestart', () => { if (!hoverRef.current?.pinned) setHover(null) })
      ready.current = true
      pending.current.splice(0).forEach(fn => fn())
      onReady.current?.()
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
      const r = props.previewRoute ?? props.highlightRoute
      const dim = props.journey != null && props.previewRoute == null
      const base: any = KIND_OPACITY
      const opacity: any = r != null ? ['case', ['==', ['get', 'route'], r], 1, 0.1] : dim ? 0.1 : base
      m.setPaintProperty('lines', 'line-opacity', opacity)
      m.setPaintProperty('lines-arrows', 'icon-opacity', r != null ? ['case', ['==', ['get', 'route'], r], 0.9, 0.15] : dim ? 0.15 : 0.9)
      m.setPaintProperty('lines-casing', 'line-opacity', r != null ? ['case', ['==', ['get', 'route'], r], 1, 0] : dim ? 0 : 0.9)
      m.setPaintProperty('places', 'circle-opacity', dim ? 0.3 : 1)
      m.setPaintProperty('places', 'circle-stroke-opacity', dim ? 0.3 : 1)
      m.setPaintProperty('lines', 'line-width', r == null
        ? ['interpolate', ['linear'], ['zoom'], 10, ['match', ['get', 'kind'], 'region', 0.8, 1.2], 15, ['match', ['get', 'kind'], 'region', 2.5, 4]]
        // le zoom doit rester au premier niveau de l'expression : la condition va dans chaque palier
        : ['interpolate', ['linear'], ['zoom'], 10, ['case', ['==', ['get', 'route'], r], 3, 0.8], 15, ['case', ['==', ['get', 'route'], r], 7, 2]])
      if (props.highlightRoute != null && fittedFor.current !== props.highlightRoute) {
        fittedFor.current = props.highlightRoute
        const r = props.highlightRoute
        const b = new LngLatBounds()
        let n = 0
        for (const t of props.net.trips) if (t.route === r) for (const s of t.stops) { b.extend([props.net.stops[s].lon, props.net.stops[s].lat]); n++ }
        if (n) m.fitBounds(b as LngLatBoundsLike, { maxZoom: 14.5, duration: 600 })
      }
      if (props.highlightRoute == null) fittedFor.current = null
    })
  }, [props.highlightRoute, props.previewRoute, props.journey])

  // filtre par type de ligne (la ligne mise en évidence reste toujours visible)
  useEffect(() => {
    whenReady(() => {
      const m = map.current!
      const r = props.previewRoute ?? props.highlightRoute ?? -1
      // la puce « Trains » ('gares') pilote à la fois les gares et les lignes TER
      const lineKinds = props.kinds.filter((k): k is Kind => k !== 'gares').concat(props.kinds.includes('gares') ? ['train'] : [])
      const kinds = ['literal', lineKinds] as any
      const vis = props.kinds.includes('gares') ? 'visible' : 'none'
      for (const l of ['stations-halo', 'stations', 'stations-label']) m.setLayoutProperty(l, 'visibility', vis)
      const lineFilter: any = ['any', ['in', ['get', 'kind'], kinds], ['==', ['get', 'route'], r]]
      m.setFilter('lines', lineFilter)
      m.setFilter('lines-casing', lineFilter)
      m.setFilter('lines-arrows', lineFilter)
      const served: any = lineKinds.length ? ['any', ...lineKinds.map(k => ['in', k, ['get', 'feeds']])] : false
      m.setFilter('places', ['all', ['any', ['>=', ['zoom'], 13.5], ['==', ['get', 'core'], 1]], served])
      m.setFilter('places-label', served)
      setHover(null)
    })
  }, [props.kinds.join(','), props.highlightRoute, props.previewRoute])

  // lignes survolées mises en évidence
  useEffect(() => {
    whenReady(() => {
      const routes = hover ? [...new Set(hover.items.map(i => i.route))] : []
      map.current!.setFilter('lines-hover', ['in', ['get', 'route'], ['literal', routes.length ? routes : [-1]]])
      const focus = [...routes, ...[props.highlightRoute, props.previewRoute].filter((x): x is number => x != null)]
      map.current!.setFilter('lines-focus-arrows', ['in', ['get', 'route'], ['literal', focus.length ? focus : [-1]]])
    })
  }, [hover, props.highlightRoute, props.previewRoute])

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

  // fond de carte
  useEffect(() => {
    whenReady(() => {
      for (const id of Object.keys(RASTER_BASEMAPS)) map.current!.setLayoutProperty(`basemap-${id}`, 'visibility', id === props.basemap ? 'visible' : 'none')
    })
  }, [props.basemap])

  // recentrage
  useEffect(() => {
    if (!props.focus) return
    whenReady(() => map.current!.easeTo({ center: [props.focus!.lon, props.focus!.lat], zoom: props.focus!.zoom ?? Math.max(map.current!.getZoom(), 15), duration: 600 }))
  }, [props.focus?.key])

  return (
    <>
      <div ref={el} class="map" role="region" aria-label="Carte du réseau" />
      {hover && <LineTooltip net={props.net} hover={hover} onRoute={r => { setHover(null); props.onRoute(r) }} onPlace={pl => { setHover(null); props.onPlace(pl) }} onClose={() => setHover(null)} />}
      <div class="map-credits">
        {props.basemap === 'satellite' && <>© <a href="https://geoservices.ign.fr/" target="_blank" rel="noopener">IGN – orthophotos</a> · </>}
        {props.basemap === 'velo' && <><a href="https://www.cyclosm.org/" target="_blank" rel="noopener">CyclOSM</a> · </>}
        © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">contributeurs OpenStreetMap</a>
        {props.basemap === 'plan' && <> · <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> · <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a></>}
      </div>
    </>
  )
}

function LineTooltip({ net, hover, onRoute, onPlace, onClose }: { net: Network; hover: Hover; onRoute: (r: number) => void; onPlace: (pl: number) => void; onClose: () => void }) {
  const w = 300
  const left = Math.max(8, Math.min(hover.x + 14, window.innerWidth - w - 8))
  const below = hover.y < window.innerHeight * 0.4
  const style = { left: `${left}px`, width: `${w}px`, ...(below ? { top: `${hover.y + 14}px` } : { bottom: `${window.innerHeight - hover.y + 14}px` }) }
  return (
    <div class={`line-tip${hover.pinned ? ' pinned' : ''}`} style={style} role={hover.pinned ? 'dialog' : 'tooltip'} aria-label="Lignes à cet endroit">
      {hover.pinned && <button class="tip-close" onClick={onClose} aria-label="Fermer"><Icon name="close" size={16} /></button>}
      {hover.station != null && (() => {
        const st = net.stations[hover.station]
        return (
          <>
            <div class="tip-station">
              <Icon name="train" size={22} />
              <span class="tip-text"><strong>{stationLabel(st.name)}</strong><span class="tip-od">Gare SNCF · correspondance avec :</span></span>
            </div>
            {st.links.map(([pl, m]) => {
              const body = (
                <>
                  <span class="tip-pills">{net.places[pl].routes.slice(0, 6).map(r => <Pill key={r} route={net.routes[r]} small />)}</span>
                  <span class="tip-text"><span class="tip-od">arrêt {net.places[pl].name} · {m < 40 ? 'sur place' : `${m} m`}</span></span>
                </>
              )
              return hover.pinned
                ? <button key={pl} class="tip-row" onClick={() => onPlace(pl)}>{body}</button>
                : <div key={pl} class="tip-row">{body}</div>
            })}
            {!hover.pinned && <div class="tip-hint">Cliquez pour voir les départs en correspondance</div>}
          </>
        )
      })()}
      {hover.items.map(it => {
        const r = net.routes[it.route]
        const body = (
          <>
            <Pill route={r} small />
            <span class="tip-text">
              <strong>{r.long}</strong>
              <span class="tip-od">{it.from && it.to
                ? <>{it.from} <span aria-hidden="true">{it.both ? '⇄' : '→'}</span><span class="sr-only">{it.both ? ' et retour depuis ' : ' vers '}</span> {it.to}</>
                : r.agency}</span>
            </span>
          </>
        )
        return hover.pinned
          ? <button key={`${it.route}${it.from}${it.to}`} class="tip-row" onClick={() => onRoute(it.route)}>{body}</button>
          : <div key={`${it.route}${it.from}${it.to}`} class="tip-row">{body}</div>
      })}
      {!hover.pinned && hover.items.length > 0 && <div class="tip-hint">Cliquez pour choisir une ligne et ouvrir sa fiche</div>}
    </div>
  )
}
