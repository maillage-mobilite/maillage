// Fiche d'aperçu d'une ligne, affichée sur la carte au survol d'une ligne dans le panneau.
import { Network, KIND_LABEL, referenceTrip, tripsOfRoute, fmtHM } from './net'
import { Pill } from './ui'

type Now = { date: string; sec: number }

export function RoutePreviewCard({ net, route, now }: { net: Network; route: number; now: Now }) {
  const r = net.routes[route]
  const name = (s: number) => net.places[net.stops[s].place].name
  const dirs = [0, 1].map(d => referenceTrip(net, route, d)).filter((t): t is NonNullable<typeof t> => !!t)
  const today = tripsOfRoute(net, route, now.date).flat().sort((a, b) => a.dep[0] - b.dep[0])
  const next = today.find(t => t.dep[0] >= now.sec)
  return (
    <div class="route-preview" role="status" aria-live="polite">
      <div class="rp-head">
        <Pill route={r} />
        <span class="rp-title"><strong>{r.long}</strong><small>{KIND_LABEL[r.kind]} · {r.agency}</small></span>
      </div>
      <ul class="rp-dirs">
        {dirs.map(t => (
          <li key={t.i}>
            <span class="rp-arrow" style={{ color: r.color }} aria-hidden="true">➜</span>
            <span>{name(t.stops[0])} <span aria-hidden="true">→</span><span class="sr-only"> vers </span> <strong>{name(t.stops[t.stops.length - 1])}</strong>
              <small> · {t.stops.length} arrêts</small></span>
          </li>
        ))}
      </ul>
      <div class="rp-today">
        {today.length
          ? <>Aujourd'hui : <strong>{today.length}</strong> courses · {fmtHM(today[0].dep[0])} – {fmtHM(today[today.length - 1].dep[0])}
              {next ? <> · prochaine à <strong>{fmtHM(next.dep[0])}</strong></> : ' · service terminé'}</>
          : <>Pas de service aujourd'hui</>}
        {r.kind === 'tad' && <> · <em>sur réservation</em></>}
      </div>
    </div>
  )
}
