// Onglet Explorer : « autour de moi », fiches arrêt et ligne.
import { Fragment } from 'preact'
import { useMemo, useState } from 'preact/hooks'
import {
  Network, Kind, KIND_LABEL, stationLabel, departures, nearestPlaces, tripsOfRoute, referenceTrip, fmtHM, fmtDay, addDays, distance, inWindow, fmtDuration
} from '../net'
import { Empty, Header, Icon, Pill, TheoNotice, When, usePreview } from '../ui'
import { TrainBoard } from '../trains'
import { plan, type Journey } from '../router'
import { LOCATION_META, type SavedLocation } from '../store'
import type { Favorites } from '../store'

type Now = { date: string; sec: number }
type Pos = { lat: number; lon: number; simulated: boolean; reason?: string }

/** Regroupe les départs par ligne + direction, en gardant les 2 prochains. */
function grouped(net: Network, stops: number[], now: Now, limit = 40) {
  const deps = departures(net, stops, now, { limit, horizonDays: 2 })
  const groups = new Map<string, { route: number; headsign: string; items: typeof deps; booking: boolean }>()
  for (const d of deps) {
    const k = `${d.trip.route}|${d.trip.headsign}`
    const g = groups.get(k) ?? { route: d.trip.route, headsign: d.trip.headsign, items: [], booking: d.trip.booking }
    if (g.items.length < 2) g.items.push(d)
    groups.set(k, g)
  }
  return [...groups.values()].sort((a, b) => a.items[0].abs - b.items[0].abs)
}

function DepLineButton({ route, onRoute, children }: { route: number; onRoute: (i: number) => void; children: any }) {
  const h = usePreview(route)
  return <button class="dep-line" onClick={() => onRoute(route)} {...h}>{children}</button>
}

function PillButton({ net, route, onRoute, label }: { net: Network; route: number; onRoute: (i: number, from?: number) => void; label: string }) {
  const h = usePreview(route)
  return <button class="pill-btn" onClick={() => onRoute(route)} aria-label={label} {...h}><Pill route={net.routes[route]} /></button>
}

function DepRow({ route, children, ...rest }: { route: number; children: any; class?: string }) {
  const h = usePreview(route)
  return <div {...rest} onMouseEnter={h.onMouseEnter} onMouseLeave={h.onMouseLeave}>{children}</div>
}

/** Carte d'un lieu enregistré : meilleur trajet maintenant depuis la position. */
function LocationCard({ net, loc, now, pos, onGo }: { net: Network; loc: SavedLocation; now: Now; pos: Pos; onGo: (l: SavedLocation) => void }) {
  const minute = Math.floor(now.sec / 60)
  const res = useMemo(() => {
    if (distance(pos.lat, pos.lon, loc.lat, loc.lon) < 150) return { here: true as const }
    const r = plan(net, { lat: pos.lat, lon: pos.lon, label: 'Ma position' }, { lat: loc.lat, lon: loc.lon, label: loc.name }, now.date, now.sec,
      { includeScolaire: false, includeTad: true, now })
    const best: Journey | undefined = [...r.journeys].sort((a, b) => a.arr - b.arr)[0]
    return { best, walk: r.directWalk }
  }, [net, loc.id, loc.lat, loc.lon, pos.lat, pos.lon, now.date, minute])
  let body
  if ('here' in res) body = <span class="muted">Vous y êtes</span>
  else if (res.walk && (!res.best || res.walk.arr <= res.best.arr)) body = <span>À pied · <strong>{fmtDuration(res.walk.arr - res.walk.dep)}</strong></span>
  else if (res.best) {
    const inMin = Math.round((res.best.dep - now.sec) / 60)
    const rides = res.best.legs.filter(l => l.type === 'ride') as any[]
    const later = res.best.dep >= 86400
    body = (
      <span class="loc-next">
        <span class={later ? 'muted' : 'leave'}>{later ? `Demain ${fmtHM(res.best.dep)}` : inMin <= 1 ? 'Partez maintenant' : inMin < 60 ? `Partez dans ${inMin} min` : `Départ ${fmtHM(res.best.dep)}`}</span>
        <span class="loc-pills">{rides.slice(0, 3).map((l, k) => <Pill key={k} route={net.routes[l.trip.route]} small />)}</span>
        <span class="muted">arrivée {fmtHM(res.best.arr)}</span>
      </span>
    )
  } else body = <span class="muted">Pas de trajet dans les prochaines heures</span>
  return (
    <button class="card loc-card" onClick={() => onGo(loc)} aria-label={`Itinéraire vers ${loc.name}`}>
      <span class="loc-icon"><Icon name={LOCATION_META[loc.kind].icon} size={20} /></span>
      <span class="loc-body"><strong>{loc.name}</strong>{body}</span>
      <Icon name="route" size={18} />
    </button>
  )
}

export function Explore({ net, now, pos, fav, onPlace, onRoute, onSearch, onGoLocation, onManageLocations }: {
  net: Network; now: Now; pos: Pos; fav: Favorites; onPlace: (i: number) => void; onRoute: (i: number) => void; onSearch: () => void
  onGoLocation: (l: SavedLocation) => void; onManageLocations: () => void
}) {
  const [showTrains, setShowTrains] = useState(false)
  // une pastille par numéro de ligne (le GTFS SNCF a plusieurs « routes » pour un même numéro)
  const uniqueRoutes = (k: Kind) => {
    const seen = new Set<string>()
    return net.routes.filter(r => r.kind === k && (seen.has(r.short) ? false : (seen.add(r.short), true)))
  }
  const near = useMemo(() => nearestPlaces(net, pos.lat, pos.lon, 4, 900), [net, pos.lat, pos.lon])
  const fallback = useMemo(() => (near.length ? [] : nearestPlaces(net, pos.lat, pos.lon, 2, 30000)), [near, pos.lat, pos.lon])
  const favPlaces = net.places.filter(p => fav.places.includes(p.name)).slice(0, 4)
  const outOfData = !inWindow(net, now.date)

  return (
    <div class="sheet-body">
      <button class="search-pill" onClick={onSearch}>
        <Icon name="search" /> <span>Où allez-vous ?</span>
      </button>
      {pos.simulated && <p class="notice"><Icon name="locate" size={16} /> {pos.reason ?? 'Position simulée'} : départ affiché depuis la gare routière d'Annonay.</p>}
      {outOfData && <p class="notice warn">Les données chargées ne couvrent pas la date du jour. Relancez le pipeline (<code>npm run data</code>).</p>}

      {fav.locations.length > 0 ? (
        <section aria-labelledby="myloc-title">
          <h3 class="section-title" id="myloc-title"><Icon name="home" size={16} /> Mes lieux</h3>
          {fav.locations.slice(0, 4).map(l => <LocationCard key={l.id} net={net} loc={l} now={now} pos={pos} onGo={onGoLocation} />)}
        </section>
      ) : (
        <button class="row-btn loc-invite" onClick={onManageLocations}><Icon name="home" size={18} /> Enregistrer domicile, travail ou école pour voir le prochain trajet ici</button>
      )}

      {favPlaces.length > 0 && (
        <section>
          <h3 class="section-title"><Icon name="star" size={16} filled /> Mes arrêts</h3>
          {favPlaces.map(p => <PlaceCard key={p.i} net={net} place={p.i} now={now} onOpen={onPlace} />)}
        </section>
      )}

      <section>
        <h3 class="section-title">Autour de moi</h3>
        {near.map(({ p, d }) => <PlaceCard key={p.i} net={net} place={p.i} now={now} dist={d} onOpen={onPlace} />)}
        {!near.length && (
          <Empty icon="bus" title="Aucun arrêt à moins de 900 m">
            {fallback.length > 0 && <>Le plus proche : <button class="link" onClick={() => onPlace(fallback[0].p.i)}>{fallback[0].p.name}</button> à {(fallback[0].d / 1000).toFixed(1)} km.</>}
          </Empty>
        )}
      </section>

      <section>
        <h3 class="section-title">Toutes les lignes</h3>
        {(['urbain', 'tad', 'region', 'scolaire', 'train'] as Kind[]).filter(k => net.routes.some(r => r.kind === k)).map(k => (
          <div class="line-group" key={k}>
            <div class="line-group-label">{KIND_LABEL[k]}{k === 'scolaire' ? ' · ouverture au public à confirmer' : k === 'train' ? ' · en correspondance (SNCF)' : ''}</div>
            {k === 'train' && !showTrains
              ? <button class="btn ghost" onClick={() => setShowTrains(true)} aria-expanded={false}>Afficher les {uniqueRoutes('train').length} lignes TER</button>
              : <div class="pills-wrap">
              {uniqueRoutes(k).map(r => (
                <PillButton key={r.i} route={r.i} net={net} onRoute={onRoute} label={`Ligne ${r.short}, ${r.long}`} />
              ))}
            </div>}
          </div>
        ))}
      </section>
      <TheoNotice />
    </div>
  )
}

function PlaceCard({ net, place, now, dist, onOpen }: { net: Network; place: number; now: Now; dist?: number; onOpen: (i: number) => void }) {
  const p = net.places[place]
  const groups = useMemo(() => grouped(net, p.stops, now, 30).slice(0, 4), [net, place, now.sec, now.date])
  return (
    <button class="card place-card" onClick={() => onOpen(place)}>
      <div class="card-head">
        <strong>{p.name}</strong>
        {dist != null && <span class="muted">{dist < 1000 ? `${Math.round(dist / 10) * 10} m` : `${(dist / 1000).toFixed(1)} km`}</span>}
      </div>
      {groups.length === 0 && <div class="muted small">Aucun départ dans les 48 h</div>}
      {groups.map(g => (
        <DepRow class="dep-row" key={g.route + g.headsign} route={g.route}>
          <Pill route={net.routes[g.route]} small />
          <span class="dep-head">{g.headsign}</span>
          {g.booking && <span class="badge-tad" title="Sur réservation">Résa</span>}
          <span class="dep-times">{g.items.map((d, k) => <When key={k} abs={d.abs} now={now} theoretical={k === 0} />)}</span>
        </DepRow>
      ))}
    </button>
  )
}

export function PlaceView({ net, id, now, pos, fav, toggleFav, onBack, onRoute, onGo, onFrom }: {
  net: Network; id: number; now: Now; pos: Pos; fav: Favorites; toggleFav: (k: 'places', key: string) => void
  onBack: () => void; onRoute: (i: number, from?: number, dir?: number) => void; onGo: (i: number) => void; onFrom: (i: number) => void
}) {
  const p = net.places[id]
  const [more, setMore] = useState(false)
  const [allLines, setAllLines] = useState(false)
  const deps = useMemo(() => departures(net, p.stops, now, { limit: 30, horizonDays: 2 }), [net, id, now.sec, now.date])
  const shown = more ? deps : deps.slice(0, 8)
  const isFav = fav.places.includes(p.name)
  const d = distance(pos.lat, pos.lon, p.lat, p.lon)
  const LINES_MAX = 8
  const lines = allLines ? p.routes : p.routes.slice(0, LINES_MAX)
  let lastDay = -1
  return (
    <div class="sheet-body">
      <Header title={p.name} onBack={onBack}
        sub={<>{d < 20000 ? (d < 1000 ? `${Math.round(d / 10) * 10} m` : `${(d / 1000).toFixed(1)} km`) : ''} · {p.routes.length} ligne{p.routes.length > 1 ? 's' : ''}</>}
        right={<button class={`icon-btn${isFav ? ' active' : ''}`} onClick={() => toggleFav('places', p.name)} aria-pressed={isFav} aria-label={isFav ? 'Retirer des favoris' : 'Ajouter aux favoris'}><Icon name="star" filled={isFav} /></button>} />
      <div class="actions compact">
        <button class="btn primary" onClick={() => onGo(id)}><Icon name="route" size={18} /> Y aller</button>
        <button class="btn" onClick={() => onFrom(id)}>Partir d'ici</button>
      </div>

      <section aria-labelledby="deps-title">
        <h3 class="section-title" id="deps-title">Prochains départs</h3>
        {deps.length === 0 && <Empty icon="clock" title="Aucun départ dans les 48 prochaines heures" />}
        <ul class="dep-list">
          {shown.map((x, k) => {
            const day = Math.floor(x.abs / 86400)
            const sep = day !== lastDay && day > 0
            lastDay = day
            const r = net.routes[x.trip.route]
            return (
              <Fragment key={k}>
                {sep && <li class="day-sep">{fmtDay(addDays(now.date, day), now.date)}</li>}
                <li>
                  <DepLineButton route={r.i} onRoute={rr => onRoute(rr, id, x.trip.dir)}>
                    <Pill route={r} small />
                    <span class="dep-head">{x.trip.headsign}{x.trip.booking && <span class="badge-tad">Sur réservation</span>}</span>
                    <When abs={x.abs} now={now} />
                  </DepLineButton>
                </li>
              </Fragment>
            )
          })}
        </ul>
        {deps.length > 8 && <button class="btn ghost block" onClick={() => setMore(!more)}>{more ? 'Afficher moins' : `Afficher plus de départs (${deps.length - 8})`}</button>}
        {deps.some(x => x.trip.booking) && <p class="notice">Les courses « Sur réservation » (TAD) ne circulent que si elles ont été réservées la veille avant 15 h.</p>}
      </section>

      {p.stations.map(([si, m]) => <TrainBoard key={si} net={net} station={si} now={now} walkMeters={m} />)}

      <section aria-labelledby="lines-title">
        <h3 class="section-title" id="lines-title">Lignes desservies</h3>
        <div class="pills-wrap">
          {lines.map(r => <PillButton key={r} route={r} net={net} onRoute={rr => onRoute(rr, id)} label={`Ligne ${net.routes[r].short}, ${net.routes[r].long}`} />)}
          {p.routes.length > LINES_MAX && (
            <button class="chip more" onClick={() => setAllLines(!allLines)} aria-expanded={allLines}>
              {allLines ? 'Moins' : `+ ${p.routes.length - LINES_MAX} lignes`}
            </button>
          )}
        </div>
        <p class="small muted">Accessibilité de l'arrêt : non renseignée par le réseau.</p>
      </section>
      <TheoNotice />
    </div>
  )
}

export function RouteView({ net, id, now, fav, toggleFav, onBack, onPlace, fromPlace, fromDir }: {
  net: Network; id: number; now: Now; fav: Favorites; toggleFav: (k: 'routes', key: string) => void; onBack: () => void; onPlace: (i: number) => void
  /** Pôle d'où l'on vient : la grille horaire est donnée à cet arrêt. */
  fromPlace?: number
  /** Sens du départ choisi (depuis une fiche arrêt). */
  fromDir?: number
}) {
  const r = net.routes[id]
  const placeOf = (s: number) => net.stops[s].place
  // sens par défaut : celui qui dessert l'arrêt d'origine (hors terminus)
  const servesFrom = (d: number) => fromPlace != null && !!referenceTrip(net, id, d)?.stops.slice(0, -1).some(s => placeOf(s) === fromPlace)
  const [dir, setDir] = useState(fromDir != null && referenceTrip(net, id, fromDir) ? fromDir : servesFrom(0) || !servesFrom(1) ? 0 : 1)
  const [date, setDate] = useState(now.date)
  const ref = referenceTrip(net, id, dir)
  const stopChoices = useMemo(() => {
    const seen = new Set<number>()
    return (ref?.stops.slice(0, -1) ?? []).map(placeOf).filter(pl => (seen.has(pl) ? false : (seen.add(pl), true)))
  }, [net, id, dir])
  const [atPlace, setAtPlace] = useState<number | null>(null)
  const at = atPlace != null && stopChoices.includes(atPlace) ? atPlace : fromPlace != null && stopChoices.includes(fromPlace) ? fromPlace : stopChoices[0]
  const dirs = useMemo(() => tripsOfRoute(net, id, date), [net, id, date])
  const hasDir1 = !!referenceTrip(net, id, 1)
  // horaires à l'arrêt choisi (courses qui le desservent, hors terminus)
  const rows = useMemo(() => dirs[dir]
    .map(t => { const k = t.stops.slice(0, -1).findIndex(s => placeOf(s) === at); return k < 0 ? null : { t, k, time: t.dep[k] } })
    .filter((x): x is { t: typeof dirs[0][0]; k: number; time: number } => !!x)
    .sort((a, b) => a.time - b.time), [dirs, dir, at])
  const nextIdx = date === now.date ? Math.max(0, rows.findIndex(x => x.time >= now.sec)) : 0
  const [sel, setSel] = useState<number | null>(null)
  const row = rows[sel ?? nextIdx]
  const trip = row?.t ?? ref
  const key = `${r.kind}:${r.short}`
  const isFav = fav.routes.includes(key)
  const booking = r.kind === 'tad' ? net.booking['tad'] : null
  const dirLabel = (d: number) => { const t = referenceTrip(net, id, d); return t ? `vers ${t.headsign}` : '' }

  return (
    <div class="sheet-body">
      <Header title={<span class="route-title"><Pill route={r} /> {r.long}</span>} onBack={onBack}
        sub={`${KIND_LABEL[r.kind]} · ${r.agency}`}
        right={<button class={`icon-btn${isFav ? ' active' : ''}`} onClick={() => toggleFav('routes', key)} aria-pressed={isFav} aria-label={isFav ? 'Retirer des favoris' : 'Ajouter aux favoris'}><Icon name="star" filled={isFav} /></button>} />
      {booking && (
        <div class="callout tad">
          <strong>Transport à la demande</strong>
          <p>Réservation la veille avant {booking.deadline_day_before.replace(':', ' h ')} · confirmation {booking.confirm_window} · {booking.fare}.</p>
          <a class="btn" href={`tel:${booking.phone.replace(/\s/g, '')}`}><Icon name="phone" size={16} /> {booking.phone}</a>
        </div>
      )}
      {r.kind === 'scolaire' && <p class="notice warn">Ligne scolaire : l'ouverture aux voyageurs non scolaires reste à confirmer avec le réseau.</p>}
      <div class="segmented" role="tablist" aria-label="Sens">
        <button role="tab" aria-selected={dir === 0} class={dir === 0 ? 'on' : ''} onClick={() => { setDir(0); setSel(null); setAtPlace(null) }}>{dirLabel(0) || 'Sens 1'}</button>
        {hasDir1 && <button role="tab" aria-selected={dir === 1} class={dir === 1 ? 'on' : ''} onClick={() => { setDir(1); setSel(null); setAtPlace(null) }}>{dirLabel(1)}</button>}
      </div>
      <label class="field">
        <span>À l'arrêt</span>
        <select value={at} onChange={e => { setAtPlace(+(e.target as HTMLSelectElement).value); setSel(null) }}>
          {stopChoices.map(pl => <option key={pl} value={pl}>{net.places[pl].name}</option>)}
        </select>
      </label>
      <div class="date-row">
        <Icon name="calendar" size={16} />
        {[0, 1, 2].map(k => {
          const dd = addDays(now.date, k)
          return <button key={k} class={`chip${dd === date ? ' on' : ''}`} onClick={() => { setDate(dd); setSel(null) }}>{k === 0 ? "Aujourd'hui" : k === 1 ? 'Demain' : fmtDay(dd, now.date)}</button>
        })}
      </div>
      <h3 class="section-title">Passages à {net.places[at]?.name ?? '—'} ({rows.length})</h3>
      {rows.length === 0 && <Empty icon="calendar" title="Pas de passage à cet arrêt ce jour-là" />}
      <div class="time-chips">
        {rows.map((x, k) => (
          <button key={x.t.i} class={`chip time${(sel ?? nextIdx) === k ? ' on' : ''}${date === now.date && x.time < now.sec ? ' past' : ''}`} onClick={() => setSel(k)}>
            {fmtHM(x.time)}
          </button>
        ))}
      </div>
      {trip && (
        <>
          <h3 class="section-title">Parcours {row ? `· passage à ${fmtHM(row.time)}` : ''}</h3>
          <ol class="timeline" style={{ '--route': r.color } as any}>
            {trip.stops.map((s, k) => (
              <li key={k} class={row && k === row.k ? 'here' : row && k < row.k ? 'before' : ''}>
                <span class="tl-time">{rows.length ? fmtHM(trip.dep[k]) : ''}</span>
                <span class="tl-dot" />
                <button class="link tl-name" onClick={() => onPlace(placeOf(s))}>{net.places[placeOf(s)].name}</button>
              </li>
            ))}
          </ol>
        </>
      )}
      <TheoNotice />
    </div>
  )
}
