// Onglet Explorer : « autour de moi », fiches arrêt et ligne.
import { Fragment } from 'preact'
import { useMemo, useState } from 'preact/hooks'
import {
  Network, Kind, KIND_LABEL, stationLabel, departures, nearestPlaces, tripsOfRoute, referenceTrip, fmtHM, fmtDay, addDays, distance, inWindow,
} from '../net'
import { Empty, Header, Icon, Pill, TheoNotice, When } from '../ui'
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

export function Explore({ net, now, pos, fav, onPlace, onRoute, onSearch }: {
  net: Network; now: Now; pos: Pos; fav: Favorites; onPlace: (i: number) => void; onRoute: (i: number) => void; onSearch: () => void
}) {
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
        {(['urbain', 'tad', 'region', 'scolaire'] as Kind[]).map(k => (
          <div class="line-group" key={k}>
            <div class="line-group-label">{KIND_LABEL[k]}{k === 'scolaire' ? ' · ouverture au public à confirmer' : ''}</div>
            <div class="pills-wrap">
              {net.routes.filter(r => r.kind === k).map(r => (
                <button key={r.i} class="pill-btn" onClick={() => onRoute(r.i)} aria-label={`Ligne ${r.short}, ${r.long}`}><Pill route={r} /></button>
              ))}
            </div>
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
        <div class="dep-row" key={g.route + g.headsign}>
          <Pill route={net.routes[g.route]} small />
          <span class="dep-head">{g.headsign}</span>
          {g.booking && <span class="badge-tad" title="Sur réservation">Résa</span>}
          <span class="dep-times">{g.items.map((d, k) => <When key={k} abs={d.abs} now={now} theoretical={k === 0} />)}</span>
        </div>
      ))}
    </button>
  )
}

export function PlaceView({ net, id, now, pos, fav, toggleFav, onBack, onRoute, onGo, onFrom }: {
  net: Network; id: number; now: Now; pos: Pos; fav: Favorites; toggleFav: (k: 'places', key: string) => void
  onBack: () => void; onRoute: (i: number) => void; onGo: (i: number) => void; onFrom: (i: number) => void
}) {
  const p = net.places[id]
  const deps = useMemo(() => departures(net, p.stops, now, { limit: 24, horizonDays: 2 }), [net, id, now.sec, now.date])
  const isFav = fav.places.includes(p.name)
  const d = distance(pos.lat, pos.lon, p.lat, p.lon)
  let lastDay = -1
  return (
    <div class="sheet-body">
      <Header title={p.name} onBack={onBack}
        sub={<>{d < 20000 ? (d < 1000 ? `${Math.round(d / 10) * 10} m` : `${(d / 1000).toFixed(1)} km`) : ''} · Accessibilité : non renseignée</>}
        right={<button class={`icon-btn${isFav ? ' active' : ''}`} onClick={() => toggleFav('places', p.name)} aria-pressed={isFav} aria-label={isFav ? 'Retirer des favoris' : 'Ajouter aux favoris'}><Icon name="star" filled={isFav} /></button>} />
      <div class="pills-wrap">
        {p.routes.map(r => <button key={r} class="pill-btn" onClick={() => onRoute(r)} aria-label={`Ligne ${net.routes[r].short}`}><Pill route={net.routes[r]} /></button>)}
      </div>
      {p.stations.length > 0 && (
        <div class="callout train">
          {p.stations.map(([si, m]) => (
            <div key={si} class="train-row">
              <Icon name="train" size={20} />
              <span><strong>Correspondance train : {stationLabel(net.stations[si].name).replace(/^Gare/, 'gare')}</strong><br />
                <span class="small">{m < 40 ? 'Sur place' : `À ${m} m à pied (≈ ${Math.max(1, Math.round(m * 1.25 / 72))} min)`} · horaires des trains sur SNCF Connect ou TER Auvergne-Rhône-Alpes</span></span>
            </div>
          ))}
        </div>
      )}
      <div class="actions">
        <button class="btn primary" onClick={() => onGo(id)}><Icon name="route" size={18} /> Y aller</button>
        <button class="btn" onClick={() => onFrom(id)}>Partir d'ici</button>
      </div>
      <h3 class="section-title">Prochains départs</h3>
      {deps.length === 0 && <Empty icon="clock" title="Aucun départ dans les 48 prochaines heures" />}
      <ul class="dep-list">
        {deps.map((x, k) => {
          const day = Math.floor(x.abs / 86400)
          const sep = day !== lastDay && day > 0
          lastDay = day
          const r = net.routes[x.trip.route]
          return (
            <Fragment key={k}>
              {sep && <li class="day-sep">{fmtDay(addDays(now.date, day), now.date)}</li>}
              <li>
                <button class="dep-line" onClick={() => onRoute(r.i)}>
                  <Pill route={r} small />
                  <span class="dep-head">{x.trip.headsign}{x.trip.booking && <span class="badge-tad">Sur réservation</span>}</span>
                  <When abs={x.abs} now={now} />
                </button>
              </li>
            </Fragment>
          )
        })}
      </ul>
      {deps.some(x => x.trip.booking) && <p class="notice">Les courses « Sur réservation » (TAD) ne circulent que si elles ont été réservées la veille avant 15 h.</p>}
      <TheoNotice />
    </div>
  )
}

export function RouteView({ net, id, now, fav, toggleFav, onBack, onPlace }: {
  net: Network; id: number; now: Now; fav: Favorites; toggleFav: (k: 'routes', key: string) => void; onBack: () => void; onPlace: (i: number) => void
}) {
  const r = net.routes[id]
  const [dir, setDir] = useState(0)
  const [date, setDate] = useState(now.date)
  const dirs = useMemo(() => tripsOfRoute(net, id, date), [net, id, date])
  const hasDir1 = !!referenceTrip(net, id, 1)
  const trips = dirs[dir]
  const nextIdx = date === now.date ? Math.max(0, trips.findIndex(t => t.dep[0] >= now.sec)) : 0
  const [sel, setSel] = useState<number | null>(null)
  const trip = trips[sel ?? nextIdx] ?? referenceTrip(net, id, dir)
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
      <div class="segmented" role="tablist">
        <button role="tab" aria-selected={dir === 0} class={dir === 0 ? 'on' : ''} onClick={() => { setDir(0); setSel(null) }}>{dirLabel(0) || 'Sens 1'}</button>
        {hasDir1 && <button role="tab" aria-selected={dir === 1} class={dir === 1 ? 'on' : ''} onClick={() => { setDir(1); setSel(null) }}>{dirLabel(1)}</button>}
      </div>
      <div class="date-row">
        <Icon name="calendar" size={16} />
        {[0, 1, 2].map(k => {
          const dd = addDays(now.date, k)
          return <button key={k} class={`chip${dd === date ? ' on' : ''}`} onClick={() => { setDate(dd); setSel(null) }}>{k === 0 ? "Aujourd'hui" : k === 1 ? 'Demain' : fmtDay(dd, now.date)}</button>
        })}
      </div>
      <h3 class="section-title">Départs ({trips.length})</h3>
      {trips.length === 0 && <Empty icon="calendar" title="Pas de service ce jour-là" />}
      <div class="time-chips">
        {trips.map((t, k) => (
          <button key={t.i} class={`chip time${(sel ?? nextIdx) === k ? ' on' : ''}${date === now.date && t.dep[0] < now.sec ? ' past' : ''}`} onClick={() => setSel(k)}>
            {fmtHM(t.dep[0])}
          </button>
        ))}
      </div>
      {trip && (
        <>
          <h3 class="section-title">Parcours {trips.length ? `· départ ${fmtHM(trip.dep[0])}` : ''}</h3>
          <ol class="timeline" style={{ '--route': r.color } as any}>
            {trip.stops.map((s, k) => (
              <li key={k}>
                <span class="tl-time">{trips.length ? fmtHM(trip.dep[k]) : ''}</span>
                <span class="tl-dot" />
                <button class="link tl-name" onClick={() => onPlace(net.stops[s].place)}>{net.places[net.stops[s].place].name}</button>
              </li>
            ))}
          </ol>
        </>
      )}
      <TheoNotice />
    </div>
  )
}
