// Tableau des trains en correspondance (horaires théoriques SNCF).
import { useMemo, useState } from 'preact/hooks'
import { Network, TRAIN_MODE, TrainPass, stationLabel, trainPasses } from './net'
import { Icon, When } from './ui'

type Now = { date: string; sec: number }

export function TrainBadge({ mode }: { mode: string }) {
  const m = TRAIN_MODE[mode] ?? { label: mode, color: '#555' }
  return <span class="train-badge" style={{ background: m.color }}>{m.label}</span>
}

/**
 * Supprime les doublons : même train sur deux calendriers le même jour, ou rames couplées
 * (deux numéros pour un même départ, même heure, même mode, même destination).
 */
function dedupe(list: TrainPass[]) {
  const seen = new Set<string>()
  return list.filter(t => { const k = `${t.abs}|${t.mode}|${t.to}|${t.from}`; if (seen.has(k)) return false; seen.add(k); return true })
}

export function TrainRowView({ t, now, kind }: { t: TrainPass; now: Now; kind: 'dep' | 'arr' }) {
  return (
    <li class="train-row-item">
      <TrainBadge mode={t.mode} />
      <span class="train-dest">
        <strong>{kind === 'dep' ? t.to : t.from}</strong>
        <small>{TRAIN_MODE[t.mode]?.label ?? t.mode} {t.number}{t.line ? ` · ligne ${t.line}` : ''}</small>
      </span>
      <When abs={t.abs} now={now} theoretical />
    </li>
  )
}

export function TrainBoard({ net, station, now, walkMeters }: { net: Network; station: number; now: Now; walkMeters?: number }) {
  const [kind, setKind] = useState<'dep' | 'arr'>('dep')
  const [tgv, setTgv] = useState(true)
  const modes = useMemo(() => new Set(Object.keys(TRAIN_MODE).filter(m => tgv || m === 'Train TER')), [tgv])
  // 24 h d'abord ; si rien (gare à desserte ponctuelle), on cherche sur 7 jours
  const list = useMemo(() => {
    const near = dedupe(trainPasses(net, station, now, { kind, limit: 16, horizonDays: 1, modes }))
    return (near.length ? near : dedupe(trainPasses(net, station, now, { kind, limit: 16, horizonDays: 7, modes }))).slice(0, 8)
  }, [net, station, now.sec, now.date, kind, tgv])
  const st = net.stations[station]
  const hasHighSpeed = (net.trains[station] ?? []).some(r => r.mode !== 'Train TER')
  return (
    <div class="train-board">
      <div class="train-board-head">
        <Icon name="train" size={20} />
        <span><strong>{stationLabel(st.name)}</strong>
          {walkMeters != null && <small>{walkMeters < 40 ? 'sur place' : `à ${walkMeters} m à pied (≈ ${Math.max(1, Math.round(walkMeters * 1.25 / 72))} min)`}</small>}
        </span>
      </div>
      <div class="segmented small-seg" role="tablist">
        <button role="tab" aria-selected={kind === 'dep'} class={kind === 'dep' ? 'on' : ''} onClick={() => setKind('dep')}>Départs</button>
        <button role="tab" aria-selected={kind === 'arr'} class={kind === 'arr' ? 'on' : ''} onClick={() => setKind('arr')}>Arrivées</button>
      </div>
      {hasHighSpeed && (
        <label class="toggle small"><input type="checkbox" checked={tgv} onChange={e => setTgv((e.target as HTMLInputElement).checked)} /> Inclure TGV, OUIGO et Intercités</label>
      )}
      {list.length > 0 && list[0].abs - now.sec > 86400 && <p class="notice warn">Aucun train dans les prochaines 24 h : desserte ponctuelle (travaux, week-end…).</p>}
      {list.length === 0 ? <p class="muted small">Aucun train dans les 7 prochains jours.</p> : (
        <ul class="train-list">{list.map(t => <TrainRowView key={`${t.number}${t.abs}`} t={t} now={now} kind={kind} />)}</ul>
      )}
      <p class="small muted">Horaires théoriques SNCF. Vérifiez votre train et d'éventuels retards sur SNCF Connect.</p>
    </div>
  )
}

/** Trains au départ d'une gare après une arrivée en bus (temps de marche + marge de 5 min). */
export function connectingTrains(net: Network, station: number, date: string, arrivalAbs: number, walkMeters: number, limit = 4) {
  const ready = arrivalAbs + Math.round(walkMeters * 1.25 / 1.2) + 5 * 60
  return dedupe(trainPasses(net, station, { date, sec: ready }, { kind: 'dep', limit: limit * 2, horizonDays: 1 })).slice(0, limit)
}
