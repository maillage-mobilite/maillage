// Onglet Itinéraire : saisie, résultats, détail, réservation TAD (démonstration).
import { useEffect, useRef, useState } from 'preact/hooks'
import { Fares, Network, fmtHM, fmtDuration, fmtDay, addDays, fmtEur } from '../net'
import { Journey, Leg, PlanResult, Point, plan, tadBookable } from '../router'
import { Suggestion, searchAddress, searchLocal } from '../search'
import { Empty, Header, Icon, Pill, TheoNotice } from '../ui'
import { TrainRowView, connectingTrains } from '../trains'
import { distance, stationLabel } from '../net'

type Now = { date: string; sec: number }

export interface TripState {
  from: Point | null // null = ma position
  to: Point | null
  when: { date: string; sec: number } | null // null = maintenant
  scolaire: boolean
  tad: boolean
  result: PlanResult | null
  searchedAt: { date: string; sec: number } | null
  selected: number | null
  booking: number | null
  focusTo: number // incrémenté pour donner le focus au champ destination
}

export const initialTrip: TripState = { from: null, to: null, when: null, scolaire: false, tad: true, result: null, searchedAt: null, selected: null, booking: null, focusTo: 0 }

function PlaceInput({ net, label, value, placeholder, onPick, near, autoFocusKey, allowMyPos }: {
  net: Network; label: string; value: Point | null; placeholder: string; onPick: (p: Point | null) => void
  near: { lat: number; lon: number }; autoFocusKey?: number; allowMyPos?: boolean
}) {
  const [q, setQ] = useState(value?.label ?? '')
  const [open, setOpen] = useState(false)
  const [sugg, setSugg] = useState<Suggestion[]>([])
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => setQ(value?.label ?? ''), [value?.label])
  useEffect(() => { if (autoFocusKey) input.current?.focus() }, [autoFocusKey])
  useEffect(() => {
    if (!open) return
    const local = searchLocal(net, q, near).filter(s => s.kind === 'place' || s.kind === 'station')
    setSugg(local)
    const t = setTimeout(async () => {
      const addr = await searchAddress(q, near)
      setSugg([...local.slice(0, 4), ...addr])
    }, 250)
    return () => clearTimeout(t)
  }, [q, open])
  const pick = (s: Suggestion) => {
    onPick({ lat: s.lat!, lon: s.lon!, label: s.kind === 'address' ? `${s.label}, ${s.detail}` : s.label })
    setOpen(false)
    input.current?.blur()
  }
  const id = `in-${label}`
  return (
    <div class="place-input">
      <label for={id}>{label}</label>
      <input id={id} ref={input} value={q} placeholder={placeholder} autocomplete="off" role="combobox" aria-expanded={open}
        onInput={e => { setQ((e.target as HTMLInputElement).value); setOpen(true) }}
        onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 200)} />
      {open && (
        <ul class="suggest" role="listbox">
          {allowMyPos && <li><button onMouseDown={e => e.preventDefault()} onClick={() => { onPick(null); setQ(''); setOpen(false) }}><Icon name="locate" size={16} /> Ma position</button></li>}
          {sugg.map((s, k) => (
            <li key={k}><button onMouseDown={e => e.preventDefault()} onClick={() => pick(s)}>
              <Icon name={s.kind === 'address' ? 'map' : s.kind === 'station' ? 'train' : 'bus'} size={16} />
              <span><strong>{s.label}</strong><small>{s.kind === 'address' ? `Adresse · ${s.detail}` : s.detail}</small></span>
            </button></li>
          ))}
          {q.length >= 3 && sugg.length === 0 && <li class="muted small pad">Aucun résultat</li>}
        </ul>
      )}
    </div>
  )
}

export function TripView({ net, now, pos, state, setState, fares }: {
  net: Network; now: Now; pos: { lat: number; lon: number; simulated: boolean }; fares: Fares | null
  state: TripState; setState: (u: (s: TripState) => TripState) => void
}) {
  const [busy, setBusy] = useState(false)
  const myPos: Point = { lat: pos.lat, lon: pos.lon, label: pos.simulated ? 'Ma position (simulée : gare routière)' : 'Ma position' }

  const run = (s: TripState) => {
    if (!s.to) return
    setBusy(true)
    setTimeout(() => {
      const at = s.when ?? now
      const result = plan(net, s.from ?? myPos, s.to!, at.date, at.sec, { includeScolaire: s.scolaire, includeTad: s.tad, now })
      setState(st => ({ ...st, result, searchedAt: at, selected: null, booking: null }))
      setBusy(false)
    }, 10)
  }
  // relance automatique quand les paramètres changent
  useEffect(() => { if (state.to) run(state) }, [state.from?.lat, state.from?.lon, state.to?.lat, state.to?.lon, state.when?.date, state.when?.sec, state.scolaire, state.tad])

  if (state.booking != null && state.result) {
    return <TadBooking net={net} now={now} journey={state.result.journeys[state.booking]} date={state.searchedAt!.date}
      onBack={() => setState(s => ({ ...s, booking: null }))} />
  }
  if (state.selected != null && state.result) {
    const j = state.selected === -1 ? state.result.directWalk! : state.result.journeys[state.selected]
    return <JourneyDetail net={net} now={now} journey={j} date={state.searchedAt!.date} fares={fares}
      onBack={() => setState(s => ({ ...s, selected: null }))} onBook={() => setState(s => ({ ...s, booking: s.selected }))} />
  }

  const whenValue = state.when ? `${state.when.date}T${fmtHM(state.when.sec)}` : ''
  return (
    <div class="sheet-body">
      <div class="trip-form">
        <PlaceInput net={net} label="Départ" value={state.from ?? { ...myPos }} placeholder="Ma position" near={pos} allowMyPos
          onPick={p => setState(s => ({ ...s, from: p }))} />
        <button class="icon-btn swap" aria-label="Inverser départ et arrivée"
          onClick={() => setState(s => ({ ...s, from: s.to, to: s.from ?? myPos }))}><Icon name="swap" /></button>
        <PlaceInput net={net} label="Arrivée" value={state.to} placeholder="Adresse, arrêt, lieu…" near={pos} autoFocusKey={state.focusTo}
          onPick={p => setState(s => ({ ...s, to: p }))} />
        <div class="when-row">
          <select aria-label="Moment du départ" value={state.when ? 'at' : 'now'}
            onChange={e => setState(s => ({ ...s, when: (e.target as HTMLSelectElement).value === 'now' ? null : { date: now.date, sec: now.sec - (now.sec % 300) + 300 } }))}>
            <option value="now">Partir maintenant</option>
            <option value="at">Partir à…</option>
          </select>
          {state.when && (
            <input type="datetime-local" aria-label="Date et heure de départ" value={whenValue}
              onChange={e => {
                const v = (e.target as HTMLInputElement).value
                if (!v) return
                const [d, t] = v.split('T'); const [h, m] = t.split(':').map(Number)
                setState(s => ({ ...s, when: { date: d, sec: h * 3600 + m * 60 } }))
              }} />
          )}
        </div>
        <div class="toggles">
          <label class="toggle"><input type="checkbox" checked={state.tad} onChange={e => setState(s => ({ ...s, tad: (e.target as HTMLInputElement).checked }))} /> Transport à la demande</label>
          <label class="toggle"><input type="checkbox" checked={state.scolaire} onChange={e => setState(s => ({ ...s, scolaire: (e.target as HTMLInputElement).checked }))} /> Lignes scolaires <small>(à confirmer)</small></label>
        </div>
      </div>

      {!state.to && <Empty icon="route" title="Où voulez-vous aller ?">Saisissez une adresse, un arrêt ou un lieu. Le calcul combine bus urbains, transport à la demande et cars Région.</Empty>}
      {busy && <p class="muted pad">Calcul en cours…</p>}
      {state.result && !busy && <Results net={net} now={now} res={state.result} at={state.searchedAt!} fares={fares} onOpen={k => setState(s => ({ ...s, selected: k }))} />}
    </div>
  )
}

function legIcons(net: Network, j: Journey) {
  return j.legs.map((l, k) => l.type === 'walk'
    ? (l.meters > 60 ? <span key={k} class="leg-walk"><Icon name="walk" size={16} />{Math.max(1, Math.round((l.arr - l.dep) / 60))}</span> : null)
    : <Pill key={k} route={net.routes[l.trip.route]} small />)
}

function Results({ net, now, res, at, fares, onOpen }: { net: Network; now: Now; res: PlanResult; at: { date: string; sec: number }; fares: Fares | null; onOpen: (k: number) => void }) {
  const isToday = at.date === now.date
  return (
    <section>
      {res.notes.map((n, k) => <p key={k} class="notice">{n}</p>)}
      {res.journeys.length === 0 && !res.directWalk && (
        <Empty icon="clock" title="Aucun trajet trouvé dans les 48 h">
          Essayez d'activer le transport à la demande, ou contactez l'agence au {net.tenant.links.phone}.
        </Empty>
      )}
      <ul class="results">
        {res.journeys.map((j, k) => {
          const inMin = Math.round((j.dep - now.sec) / 60)
          const day = Math.floor(j.dep / 86400)
          return (
            <li key={j.key}>
              <button class="card journey" onClick={() => onOpen(k)}>
                <div class="j-top">
                  <span class="j-times">{fmtHM(j.dep)} → {fmtHM(j.arr)}</span>
                  <span class="j-dur">{fmtDuration(j.arr - j.dep)}</span>
                </div>
                <div class="j-legs">{legIcons(net, j)}</div>
                <div class="j-meta">
                  {day > 0 && <span class="badge">{fmtDay(addDays(at.date, day), now.date)}</span>}
                  {isToday && day === 0 && inMin >= 0 && inMin <= 60 && <span class="leave">Partez dans {inMin} min</span>}
                  <span class="muted">{j.transfers ? `${j.transfers} corresp.` : 'Direct'} · {j.walkMeters} m à pied</span>
                  {j.hasBooking && <span class="badge-tad">Réservation requise</span>}
                  {(() => { const p = fareEstimate(net, fares, j); return p && !p.region ? <span class="muted">· {p.text.split('= ')[1]}</span> : null })()}
                </div>
              </button>
            </li>
          )
        })}
        {res.directWalk && (
          <li>
            <button class="card journey" onClick={() => onOpen(-1)}>
              <div class="j-top"><span class="j-times"><Icon name="walk" size={18} /> À pied</span><span class="j-dur">{fmtDuration(res.directWalk.arr - res.directWalk.dep)}</span></div>
              <div class="j-meta muted">{res.directWalk.walkMeters} m</div>
            </button>
          </li>
        )}
      </ul>
      <TheoNotice />
    </section>
  )
}

function legLabel(net: Network, l: Leg) {
  if (l.type === 'walk') return `Marcher ${l.meters} m jusqu'à ${l.to.label}`
  const r = net.routes[l.trip.route]
  return `${r.short} direction ${l.trip.headsign}`
}

/**
 * Tarif indicatif d'un itinéraire à partir de la grille relevée :
 * ticket unitaire (45 min, 1 correspondance) ou ticket TAD (1 h, valable aussi sur l'urbain).
 * Les cars Région ont leur propre tarification (non intégrée).
 */
export function fareEstimate(net: Network, fares: Fares | null, j: Journey): { text: string; region: boolean } | null {
  if (!fares) return null
  const rides = j.legs.filter(l => l.type === 'ride') as Extract<Leg, { type: 'ride' }>[]
  const local = rides.filter(r => net.routes[r.trip.route].kind !== 'region')
  const region = rides.length > local.length
  if (!local.length) return region ? { text: 'Car Région : tarification Région', region } : null
  const tad = local.some(r => r.booking)
  const fare = fares.fares.find(f => f.name === (tad ? 'Ticket TAD' : 'Ticket unitaire'))
  if (!fare) return null
  const validity = tad ? 3600 : 45 * 60
  let tickets = 0, start = -Infinity, used = 0
  for (const r of local) {
    if (r.dep - start > validity || used >= 2) { tickets++; start = r.dep; used = 0 }
    used++
  }
  const text = `${tickets} × ${fare.name.toLowerCase()} = ${fmtEur(tickets * fare.price_eur)}`
  return { text: region ? `${text} + car Région (tarif Région)` : text, region }
}

export function JourneyDetail({ net, now, journey, date, fares, onBack, onBook }: { net: Network; now: Now; journey: Journey; date: string; fares: Fares | null; onBack: () => void; onBook: () => void }) {
  const price = fareEstimate(net, fares, journey)
  const bookingLeg = journey.legs.find(l => l.type === 'ride' && l.booking) as Extract<Leg, { type: 'ride' }> | undefined
  const tripDate = bookingLeg ? addDays(date, Math.floor(bookingLeg.dep / 86400)) : date
  const bookable = bookingLeg ? tadBookable(net, tripDate, now) : false
  return (
    <div class="sheet-body">
      <Header title={`${fmtHM(journey.dep)} → ${fmtHM(journey.arr)}`} onBack={onBack}
        sub={`${fmtDuration(journey.arr - journey.dep)} · ${journey.transfers ? journey.transfers + ' correspondance(s)' : 'direct'} · ${fmtDay(addDays(date, Math.floor(journey.dep / 86400)), now.date)}`} />
      {price && <p class="fare-line"><Icon name="ticket" size={16} /> <span>Tarif indicatif : <strong>{price.text}</strong> · ou carte bancaire à bord</span></p>}
      {bookingLeg && (
        <div class="callout tad">
          <strong>Ce trajet comprend un transport à la demande</strong>
          <p>Il ne circule que s'il est réservé la veille avant 15 h. {bookable ? '' : 'Le délai est dépassé pour ce jour.'}</p>
          {bookable && <button class="btn primary" onClick={onBook}>Réserver ce trajet</button>}
        </div>
      )}
      <ol class="legs">
        {journey.legs.map((l, k) => {
          if (l.type === 'walk') {
            if (l.meters < 25 && k !== 0) return null
            return (
              <li key={k} class="leg walk">
                <span class="leg-time">{fmtHM(l.dep)}</span>
                <span class="leg-icon"><Icon name="walk" size={18} /></span>
                <div><strong>{k === 0 ? `Départ : ${l.from.label}` : 'À pied'}</strong>{l.meters >= 25 && <div class="muted small">{legLabel(net, l)} · {Math.max(1, Math.round((l.arr - l.dep) / 60))} min</div>}</div>
              </li>
            )
          }
          const r = net.routes[l.trip.route]
          const stops = l.trip.stops.slice(l.fromPos, l.toPos + 1)
          return (
            <li key={k} class="leg ride" style={{ '--route': r.color } as any}>
              <span class="leg-time">{fmtHM(l.dep)}</span>
              <span class="leg-icon"><Pill route={r} small /></span>
              <div>
                <strong>{net.places[net.stops[stops[0]].place].name}</strong>
                <div class="muted small">{legLabel(net, l)} · {stops.length - 1} arrêt(s) · {fmtDuration(l.arr - l.dep)}{l.booking ? ' · sur réservation' : ''}</div>
                <div class="leg-end"><span class="leg-time-inline">{fmtHM(l.arr)}</span> Descendre à <strong>{net.places[net.stops[stops[stops.length - 1]].place].name}</strong></div>
              </div>
            </li>
          )
        })}
        <li class="leg end"><span class="leg-time">{fmtHM(journey.arr)}</span><span class="leg-icon"><Icon name="check" size={18} /></span><div><strong>Arrivée</strong></div></li>
      </ol>
      <ArrivalTrains net={net} now={now} journey={journey} date={date} />
      <TheoNotice />
    </div>
  )
}

/** Si l'itinéraire se termine près d'une gare : trains au départ après l'arrivée. */
function ArrivalTrains({ net, now, journey, date }: { net: Network; now: Now; journey: Journey; date: string }) {
  const last = journey.legs[journey.legs.length - 1]
  const end = last.type === 'walk' ? last.to : net.stops[last.trip.stops[last.toPos]]
  let best: { i: number; d: number } | null = null
  for (const st of net.stations) {
    const d = distance(end.lat, end.lon, st.lat, st.lon)
    if (d <= 500 && (!best || d < best.d)) best = { i: st.i, d }
  }
  if (!best || !(net.trains[best.i]?.length)) return null
  const trains = connectingTrains(net, best.i, date, journey.arr, Math.round(best.d))
  return (
    <section class="train-board">
      <div class="train-board-head"><Icon name="train" size={20} /><span><strong>Trains en correspondance · {stationLabel(net.stations[best.i].name)}</strong>
        <small>départs après votre arrivée, marche et 5 min de marge comprises</small></span></div>
      {trains.length === 0 ? <p class="muted small">Aucun train dans les 24 h suivant votre arrivée.</p>
        : <ul class="train-list">{trains.map(t => <TrainRowView key={`${t.number}${t.abs}`} t={{ ...t, abs: t.abs }} now={now} kind="dep" />)}</ul>}
      <p class="small muted">Horaires théoriques SNCF, sans garantie de correspondance : vérifiez sur SNCF Connect.</p>
    </section>
  )
}

function TadBooking({ net, now, journey, date, onBack }: { net: Network; now: Now; journey: Journey; date: string; onBack: () => void }) {
  const leg = journey.legs.find(l => l.type === 'ride' && l.booking) as Extract<Leg, { type: 'ride' }>
  const tripDate = addDays(date, Math.floor(leg.dep / 86400))
  const [n, setN] = useState(1)
  const [name, setName] = useState('')
  const [tel, setTel] = useState('')
  const [sent, setSent] = useState(false)
  const b = net.booking['tad']
  const from = net.places[net.stops[leg.trip.stops[leg.fromPos]].place].name
  const to = net.places[net.stops[leg.trip.stops[leg.toPos]].place].name
  if (sent) {
    return (
      <div class="sheet-body">
        <Header title="Demande enregistrée" onBack={onBack} />
        <div class="callout ok">
          <Icon name="check" size={28} />
          <p><strong>{fmtDay(tripDate, now.date)} · {fmtHM(leg.dep)}</strong> — {from} → {to}, {n} passager(s).</p>
          <p>Vous recevrez la confirmation de l'horaire exact {b?.confirm_window ?? 'la veille'} par notification et SMS.</p>
        </div>
        <p class="notice warn"><strong>Démonstration :</strong> aucune demande n'a été transmise. Pour réserver réellement, appelez le {b?.phone}. En production, cette demande arriverait dans le back-office de la régie, dans la même liste que les réservations téléphoniques.</p>
      </div>
    )
  }
  return (
    <div class="sheet-body">
      <Header title="Réserver le transport à la demande" onBack={onBack} sub={`${fmtDay(tripDate, now.date)} · ${net.routes[leg.trip.route].long}`} />
      <div class="card static">
        <div class="dep-row"><Pill route={net.routes[leg.trip.route]} small /><strong>{fmtHM(leg.dep)}</strong> {from}</div>
        <div class="dep-row"><span class="pill-spacer" /><strong>{fmtHM(leg.arr)}</strong> {to}</div>
        <div class="muted small">Tarif : {b?.fare}</div>
      </div>
      <form class="form" onSubmit={e => { e.preventDefault(); setSent(true) }}>
        <label>Passagers
          <span class="stepper">
            <button type="button" onClick={() => setN(Math.max(1, n - 1))} aria-label="Un passager de moins">−</button>
            <output>{n}</output>
            <button type="button" onClick={() => setN(Math.min(8, n + 1))} aria-label="Un passager de plus">+</button>
          </span>
        </label>
        <label>Nom<input required value={name} onInput={e => setName((e.target as HTMLInputElement).value)} autocomplete="name" /></label>
        <label>Téléphone<input required type="tel" value={tel} onInput={e => setTel((e.target as HTMLInputElement).value)} autocomplete="tel" placeholder="06 …" /></label>
        <p class="notice warn">Démonstrateur : les informations saisies restent dans votre navigateur et ne sont envoyées nulle part.</p>
        <button class="btn primary block" type="submit">Envoyer la demande</button>
      </form>
    </div>
  )
}
