// Onglets Info trafic et Mes trajets (favoris, services, sources des données).
import { Fares, Network, fmtEur } from '../net'
import { Empty, Header, Icon, Pill } from '../ui'
import type { Favorites } from '../store'

const FIX_LABELS: Record<string, string> = {
  temps_de_parcours_negatif_corrige: 'temps de parcours négatifs corrigés',
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
  return (
    <div class="sheet-body">
      <Header title="Info trafic" />
      <Empty icon="check" title="Aucune perturbation publiée">
        Le réseau ne diffuse pas encore ses perturbations dans un format exploitable (GTFS-RT « Service Alerts »).
        Aujourd'hui, elles passent par un abonnement SMS chez son prestataire.
      </Empty>
      {expiring.length > 0 && (
        <section>
          <h3 class="section-title">Alertes sur les données</h3>
          {expiring.map(f => (
            <div class="card static alert-card" key={f.id}>
              <Icon name="data" />
              <div><strong>{f.name}</strong><div class="small">Les horaires publiés s'arrêtent le {fmtDate(f.end)}, dans {f.days_left} jours. Sans nouvelle publication, l'application n'affichera plus ces bus.</div></div>
            </div>
          ))}
        </section>
      )}
      <section>
        <h3 class="section-title">À quoi cela ressemblera</h3>
        <div class="card static alert-card example" aria-label="Exemple fictif">
          <span class="tag">Exemple fictif</span>
          <Icon name="alert" />
          <div>
            <strong>Ligne 2 : arrêt déplacé</strong>
            <div class="small">Saisi en 2 minutes par la régie dans le back-office, publié ici, sur les fiches de la ligne et des arrêts, envoyé en notification aux voyageurs qui suivent la ligne et diffusé en GTFS-RT vers Google Maps et Transit.</div>
          </div>
        </div>
      </section>
    </div>
  )
}

export function MeView({ net, fav, onPlace, onRoute, onSources, onFares, hasFares }: {
  net: Network; fav: Favorites; onPlace: (i: number) => void; onRoute: (i: number) => void; onSources: () => void; onFares: () => void; hasFares: boolean
}) {
  const places = net.places.filter(p => fav.places.includes(p.name))
  const routes = net.routes.filter(r => fav.routes.includes(`${r.kind}:${r.short}`))
  const L = net.tenant.links
  return (
    <div class="sheet-body">
      <Header title="Mes trajets" />
      <section>
        <h3 class="section-title"><Icon name="star" size={16} filled /> Favoris</h3>
        {!places.length && !routes.length && <p class="muted">Touchez l'étoile d'un arrêt ou d'une ligne pour le retrouver ici. Les favoris restent sur votre téléphone : aucun compte nécessaire.</p>}
        {places.map(p => <button key={p.i} class="row-btn" onClick={() => onPlace(p.i)}><Icon name="bus" size={18} /> {p.name}</button>)}
        {routes.length > 0 && <div class="pills-wrap">{routes.map(r => <button key={r.i} class="pill-btn" onClick={() => onRoute(r.i)}><Pill route={r} /></button>)}</div>}
      </section>
      <section>
        <h3 class="section-title">Services {net.tenant.name}</h3>
        {hasFares && <button class="row-btn" onClick={onFares}><Icon name="ticket" size={18} /> Tarifs et abonnements</button>}
        <a class="row-btn" href={L.tickets} target="_blank" rel="noopener"><Icon name="ticket" size={18} /> Acheter un titre en ligne <Icon name="external" size={14} /></a>
        <a class="row-btn" href={L.open_payment} target="_blank" rel="noopener"><Icon name="ticket" size={18} /> Payer par carte bancaire à bord (Open Payment) <Icon name="external" size={14} /></a>
        <a class="row-btn" href={`tel:${L.phone.replace(/\s/g, '')}`}><Icon name="phone" size={18} /> Agence mobilité · {L.phone}</a>
        <div class="muted small pad">{L.agency}</div>
        <a class="row-btn" href={L.website} target="_blank" rel="noopener"><Icon name="external" size={18} /> Site officiel du réseau</a>
      </section>
      <section>
        <h3 class="section-title">Données</h3>
        <button class="row-btn" onClick={onSources}><Icon name="data" size={18} /> Sources et qualité des données</button>
      </section>
      <p class="notice">Démonstrateur indépendant et non officiel, construit uniquement à partir de données ouvertes. Il n'est pas affilié à {net.tenant.name} ni à {net.tenant.territory}.</p>
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
          le tracé exact reste à confirmer par le réseau.
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
          <a class="small" href={f.page} target="_blank" rel="noopener">Voir sur transport.data.gouv.fr ↗</a>
        </div>
      ))}
      <div class="card static">
        <strong>Non disponibles en open data</strong>
        <ul class="small">
          <li>Temps réel (géolocalisation des bus) : existe chez le prestataire, non publié.</li>
          <li>Perturbations : aucun flux.</li>
          <li>Tarifs : uniquement dans des documents PDF.</li>
          <li>Accessibilité des arrêts : non renseignée.</li>
        </ul>
      </div>
      <p class="small muted">Fond de carte © contributeurs OpenStreetMap (OpenFreeMap). Adresses : Base Adresse Nationale. Cars Région : agrégat Oùra (ODbL). Gares et horaires des trains : SNCF Open Data (ODbL).</p>
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
      <p class="notice"><Icon name="info" size={16} /> Paiement par carte bancaire sans contact possible directement à bord (Open Payment). Les cars Région ont leur propre tarification.</p>
      {section('ticket', 'Tickets')}
      {section('abonnement', 'Abonnements')}
      <a class="btn primary block" href={net.tenant.links.tickets} target="_blank" rel="noopener">Acheter en ligne <Icon name="external" size={14} /></a>
      <p class="small muted">Source : <a href={fares.source_url} target="_blank" rel="noopener">{fares.source}</a>. {fares.note} Les tarifs affichés sur coqueligo.fr (2025) ne sont plus à jour.</p>
    </div>
  )
}
