// Onglets Info trafic et Mes trajets (favoris, services, sources des données).
import { BRAND } from '../brand'
import { Fares, Network, fmtEur, routeKey } from '../net'
import { useState } from 'preact/hooks'
import { Empty, Header, Icon, Pill } from '../ui'
import { LOCATION_META, type LocationKind, type SavedLocation } from '../store'
import { PlaceInput } from './trip'
import type { Favorites } from '../store'

const FIX_LABELS: Record<string, string> = {
  temps_de_parcours_negatif_corrige: 'temps de parcours négatifs corrigés',
  couleur_ligne_ajoutee: 'couleurs de ligne ajoutées (absentes du flux)',
  nom_de_ligne_ajoute: 'noms de ligne ajoutés (origine – terminus)',
  sequence_dupliquee_supprimee: 'séquences dupliquées supprimées',
  depart_avant_arrivee_corrige: 'départs avant arrivée corrigés',
  contraste_couleur_ligne_corrige: 'couleurs de texte corrigées (contraste)',
  arret_sans_coordonnees_ignore: 'arrêts sans coordonnées ignorés',
  horaire_vide_ignore: 'horaires vides ignorés',
}
const CHECK_LABELS: Record<string, string> = {
  lignes: 'lignes', courses_dans_fenetre: 'courses sur 60 jours', arrets_utilises: 'arrêts desservis', arrets_inutilises_ecartes: 'arrêts inutilisés écartés',
}
const fmtDate = (s: string | null) => (s ? new Date(s + 'T12:00:00Z').toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '—')

export function AlertsView({ net }: { net: Network }) {
  const expiring = net.feeds.filter(f => f.days_left != null && f.days_left < 60)
  const L = net.tenant.links
  const official = [L.website && { href: L.website, label: `Site officiel ${net.tenant.territory}` }, L.operator && { href: L.operator, label: "Site de l'exploitant" }]
    .filter((x): x is { href: string; label: string } => !!x)
  return (
    <div class="sheet-body">
      <Header title="Info trafic" />
      <Empty icon="alert" title="Perturbations : voir le réseau">
        Les travaux, déviations et arrêts déplacés ne sont pas encore repris dans {BRAND.name}. Avant un trajet inhabituel, vérifiez l'info trafic du réseau.
      </Empty>
      {official.map(o => <a key={o.href} class="row-btn" href={o.href} target="_blank" rel="noopener"><Icon name="external" size={18} /> {o.label}</a>)}
      {L.phone && <a class="row-btn" href={`tel:${L.phone.replace(/\s/g, '')}`}><Icon name="phone" size={18} /> Agence mobilité · {L.phone}</a>}
      {expiring.length > 0 && (
        <section>
          <h3 class="section-title">Alertes sur les données</h3>
          {expiring.map(f => (
            <div class="card static alert-card" key={f.id}>
              <Icon name="data" />
              <div><strong>{f.name}</strong><div class="small">Les horaires publiés par le réseau s'arrêtent le {fmtDate(f.end)}, dans {f.days_left} jours. Ils seront prolongés dès que le réseau publiera les suivants.</div></div>
            </div>
          ))}
        </section>
      )}
    </div>
  )
}

/** Éditeur d'un lieu enregistré : recherche d'adresse / d'arrêt (et nom libre pour « Autre »). */
function LocationEditor({ net, kind, current, near, onSave, onCancel }: {
  net: Network; kind: LocationKind; current?: SavedLocation; near: { lat: number; lon: number }
  onSave: (l: SavedLocation) => void; onCancel: () => void
}) {
  const [point, setPoint] = useState<{ lat: number; lon: number; label: string } | null>(current ? { lat: current.lat, lon: current.lon, label: current.label } : null)
  const [name, setName] = useState(current?.name ?? (kind === 'other' ? '' : LOCATION_META[kind].name))
  const ok = !!point && name.trim().length > 0
  return (
    <div class="loc-editor">
      {kind === 'other' && <label class="field"><span>Nom du lieu</span><input value={name} placeholder="Ex. : Mamie, club de foot, marché…" onInput={e => setName((e.target as HTMLInputElement).value)} /></label>}
      <PlaceInput net={net} label="Adresse ou arrêt" value={point} placeholder="Rechercher une adresse, un arrêt…" near={near} autoFocusKey={1}
        onPick={p => p && setPoint(p)} />
      <div class="actions">
        <button class="btn primary" disabled={!ok} onClick={() => point && onSave({ id: current?.id ?? `${kind}-${Date.now()}`, kind, name: name.trim(), label: point.label, lat: point.lat, lon: point.lon })}>Enregistrer</button>
        <button class="btn" onClick={onCancel}>Annuler</button>
      </div>
    </div>
  )
}

export function MeView({ net, fav, near, onPlace, onRoute, onSources, onFares, hasFares, saveLocation, removeLocation }: {
  net: Network; fav: Favorites; near: { lat: number; lon: number }; onPlace: (i: number) => void; onRoute: (i: number) => void; onSources: () => void; onFares: () => void; hasFares: boolean
  saveLocation: (l: SavedLocation) => void; removeLocation: (id: string) => void
}) {
  const [editing, setEditing] = useState<{ kind: LocationKind; id?: string } | null>(null)
  const slots: LocationKind[] = ['home', 'work', 'school']
  const others = fav.locations.filter(l => l.kind === 'other')
  const row = (kind: LocationKind, l?: SavedLocation) => {
    const isEditing = editing && editing.kind === kind && editing.id === l?.id
    if (isEditing) {
      return <LocationEditor key={`e-${kind}-${l?.id ?? 'new'}`} net={net} kind={kind} current={l} near={near}
        onSave={x => { saveLocation(x); setEditing(null) }} onCancel={() => setEditing(null)} />
    }
    return (
      <div class="loc-row" key={`${kind}-${l?.id ?? 'empty'}`}>
        <span class={`loc-icon${l ? '' : ' empty'}`}><Icon name={LOCATION_META[kind].icon} size={20} /></span>
        <button class="loc-main" onClick={() => setEditing({ kind, id: l?.id })}>
          <strong>{l?.name ?? LOCATION_META[kind].name}</strong>
          <small>{l ? l.label : 'Définir'}</small>
        </button>
        {l && <button class="icon-btn" aria-label={`Retirer ${l.name}`} onClick={() => removeLocation(l.id)}><Icon name="close" size={18} /></button>}
      </div>
    )
  }
  const places = net.places.filter(p => fav.places.includes(p.name))
  const routes = net.routes.filter(r => fav.routes.includes(routeKey(r)))
  const L = net.tenant.links
  return (
    <div class="sheet-body">
      <Header title="Mes trajets" />
      <section aria-labelledby="loc-title">
        <h3 class="section-title" id="loc-title"><Icon name="home" size={16} /> Mes lieux</h3>
        {slots.map(k => row(k, fav.locations.find(l => l.kind === k)))}
        {others.map(l => row('other', l))}
        {editing?.kind === 'other' && !editing.id
          ? row('other')
          : <button class="row-btn" onClick={() => setEditing({ kind: 'other' })}><Icon name="plus" size={18} /> Ajouter un autre lieu</button>}
        <p class="small muted">Vos lieux restent sur ce téléphone. Ils apparaissent sur l'accueil avec le prochain trajet, et en raccourci dans l'itinéraire.</p>
      </section>
      <section>
        <h3 class="section-title"><Icon name="star" size={16} filled /> Favoris</h3>
        {!places.length && !routes.length && <p class="muted">Touchez l'étoile d'un arrêt ou d'une ligne pour le retrouver ici. Les favoris restent sur votre téléphone : aucun compte nécessaire.</p>}
        {places.map(p => <button key={p.i} class="row-btn" onClick={() => onPlace(p.i)}><Icon name="bus" size={18} /> {p.name}</button>)}
        {routes.length > 0 && <div class="pills-wrap">{routes.map(r => <button key={r.i} class="pill-btn" onClick={() => onRoute(r.i)}><Pill route={r} /></button>)}</div>}
      </section>
      <section>
        <h3 class="section-title">Services {net.tenant.name}</h3>
        {hasFares && <button class="row-btn" onClick={onFares}><Icon name="ticket" size={18} /> Tarifs et abonnements</button>}
        {L.tickets && <a class="row-btn" href={L.tickets} target="_blank" rel="noopener"><Icon name="ticket" size={18} /> Acheter un titre en ligne <Icon name="external" size={14} /></a>}
        {L.open_payment && <a class="row-btn" href={L.open_payment} target="_blank" rel="noopener"><Icon name="ticket" size={18} /> Payer par carte bancaire à bord (Open Payment) <Icon name="external" size={14} /></a>}
        {L.phone && <a class="row-btn" href={`tel:${L.phone.replace(/\s/g, '')}`}><Icon name="phone" size={18} /> Agence mobilité · {L.phone}</a>}
        {L.agency && <div class="muted small pad">{L.agency}</div>}
        {L.website && <a class="row-btn" href={L.website} target="_blank" rel="noopener"><Icon name="external" size={18} /> Site officiel {net.tenant.territory}</a>}
        {L.operator && <a class="row-btn" href={L.operator} target="_blank" rel="noopener"><Icon name="external" size={18} /> Site de l'exploitant</a>}
      </section>
      <section>
        <h3 class="section-title">Données</h3>
        <button class="row-btn" onClick={onSources}><Icon name="data" size={18} /> Sources et qualité des données</button>
        <a class="row-btn" href="./"><Icon name="pin" size={18} /> Changer de territoire</a>
      </section>
      <section>
        <h3 class="section-title">À propos</h3>
        <a class="row-btn" href={BRAND.about}><Icon name="data" size={18} /> Mentions légales, confidentialité, accessibilité</a>
        <a class="row-btn" href={`mailto:${BRAND.contact}?subject=${encodeURIComponent(`${BRAND.name} · ${net.tenant.name}`)}`}><Icon name="external" size={18} /> Contacter l'éditeur de {BRAND.name}</a>
      </section>
      <p class="notice">{BRAND.disclaimer(net.tenant.territory)}</p>
    </div>
  )
}

export function SourcesView({ net, onBack }: { net: Network; onBack: () => void }) {
  const rc = net.reconciliation
  return (
    <div class="sheet-body">
      <Header title="Sources et qualité" onBack={onBack} sub={`Données générées le ${new Date(net.generatedAt).toLocaleString('fr-FR')}`} />
      <p class="small">Le pipeline télécharge chaque flux déclaré dans la configuration du territoire, le contrôle, corrige ce qui peut l'être automatiquement, puis rapproche les arrêts communs aux différents flux.</p>
      <div class="stats">
        <div><strong>{net.routes.length}</strong><span>lignes</span></div>
        <div><strong>{net.trips.length}</strong><span>courses</span></div>
        <div><strong>{rc.places}</strong><span>pôles d'arrêt</span></div>
        <div><strong>{rc.cross_feed_merges}</strong><span>arrêts rapprochés entre flux</span></div>
      </div>
      {net.shapesQuality && (
        <section>
          <h3 class="section-title">Tracés {net.tenant.name} recalés sur la chaussée</h3>
          <p class="small">Chaque tracé est apparié au réseau routier OpenStreetMap (moteur OSRM local, profil bus, voies réservées comprises).
            L'écart indique de combien l'ancien tracé s'éloignait de la route ; un bloc n'est remplacé que si l'appariement est fiable.</p>
          <table class="quality">
            <thead><tr><th>Ligne</th><th>Écart médian</th><th>p95</th><th>Max</th><th>Blocs gardés</th></tr></thead>
            <tbody>
              {Object.entries(net.shapesQuality).sort((a, b) => b[1].p95_m - a[1].p95_m).map(([ri, q]) => (
                <tr key={ri}>
                  <td><Pill route={net.routes[+ri]} small /></td>
                  <td>{q.median_m} m</td><td>{q.p95_m} m</td><td>{q.max_m} m</td>
                  <td>{q.kept_original}/{q.blocks}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {net.shapes && (
        <p class="small">
          <strong>{net.shapes.snapped_features} tracés recalés sur la voirie.</strong> Les flux TAD et une partie des lignes scolaires et régionales
          ne publient que des lignes droites d'arrêt à arrêt. Le pipeline les fait suivre les routes OpenStreetMap (moteur OSRM) :
          le tracé affiché est une reconstitution et peut différer légèrement du trajet réel.
        </p>
      )}
      {net.stationsSource && (
        <p class="small"><strong>{net.stations.length} gares en correspondance</strong> (à moins de 500 m d'un arrêt desservi) :{' '}
          {net.stations.map(s => s.name).join(', ')}. Source : <a href={net.stationsSource.page} target="_blank" rel="noopener">{net.stationsSource.name}</a> ({net.stationsSource.licence}).</p>
      )}
      {net.trainsSource && (
        <p class="small"><strong>Horaires des trains</strong> en correspondance (TER, TGV, OUIGO, Intercités ; cars TER exclus) :{' '}
          <a href={net.trainsSource.page} target="_blank" rel="noopener">{net.trainsSource.name}</a> ({net.trainsSource.licence}).</p>
      )}
      {net.feeds.map(f => (
        <div class="card static feed" key={f.id}>
          <div class="card-head"><strong>{f.name}</strong><span class={`badge${f.days_left != null && f.days_left < 60 ? ' warn' : ''}`}>{f.days_left != null ? (f.days_left < 0 ? 'expiré' : `${f.days_left} j restants`) : '—'}</span></div>
          <div class="small">Valide du {fmtDate(f.start)} au {fmtDate(f.end)} · {f.licence}</div>
          <div class="small muted">{Object.entries(f.checks).filter(([, v]) => v != null).map(([k, v]) => `${v} ${CHECK_LABELS[k] ?? k.replace(/_/g, ' ')}`).join(' · ')}</div>
          {Object.keys(f.fixes).length > 0 && (
            <ul class="fixes">{Object.entries(f.fixes).map(([k, v]) => <li key={k}>{v} {FIX_LABELS[k] ?? k}</li>)}</ul>
          )}
          <a class="small" href={f.page} target="_blank" rel="noopener">Voir sur {(() => { try { return new URL(f.page).hostname.replace(/^www\./, '') } catch { return 'le site source' } })()} ↗</a>
        </div>
      ))}
      <div class="card static">
        <strong>Non disponibles en open data</strong>
        <ul class="small">{(net.tenant.data_gaps ?? []).map(g => <li key={g}>{g}</li>)}</ul>
      </div>
      <p class="small muted">Fond de carte et lieux utiles (mairies, écoles, santé, équipements) © contributeurs OpenStreetMap, ODbL (OpenFreeMap pour le fond). Adresses : Base Adresse Nationale. {net.tenant.credits}</p>
    </div>
  )
}

export function FaresView({ net, fares, onBack }: { net: Network; fares: Fares; onBack: () => void }) {
  const section = (cat: 'ticket' | 'abonnement', title: string) => (
    <section>
      <h3 class="section-title">{title}</h3>
      <ul class="fares">
        {fares.fares.filter(f => f.category === cat).sort((a, b) => a.price_eur - b.price_eur).map(f => (
          <li key={f.name}>
            <div class="fare-head"><strong>{f.name.charAt(0) + f.name.slice(1).toLowerCase().replace(/\btad\b/g, 'TAD')}</strong><span class="fare-price">{fmtEur(f.price_eur)}</span></div>
            {f.conditions && <div class="small muted">{f.conditions}</div>}
          </li>
        ))}
      </ul>
    </section>
  )
  return (
    <div class="sheet-body">
      <Header title="Tarifs" onBack={onBack} sub={`Réseau ${net.tenant.name} · relevé le ${new Date(fares.retrieved + 'T12:00:00Z').toLocaleDateString('fr-FR')}`} />
      {net.tenant.fares_note && <p class="notice"><Icon name="info" size={16} /> {net.tenant.fares_note}</p>}
      {section('ticket', 'Tickets')}
      {section('abonnement', 'Abonnements')}
      {net.tenant.links.tickets && <a class="btn primary block" href={net.tenant.links.tickets} target="_blank" rel="noopener">Acheter en ligne <Icon name="external" size={14} /></a>}
      <p class="small muted">Source : <a href={fares.source_url} target="_blank" rel="noopener">{fares.source}</a>. {fares.note}</p>
    </div>
  )
}
