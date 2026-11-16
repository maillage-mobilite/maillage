// Page d'accueil : choix du territoire (un même démonstrateur, plusieurs réseaux).
import { useEffect, useState } from 'preact/hooks'
import { Icon } from '../ui'
import { loadTenants, tenantHref, type TenantEntry } from '../tenant'

export function TenantPicker() {
  const [list, setList] = useState<TenantEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { loadTenants().then(setList).catch(e => setError(String(e.message ?? e))) }, [])
  // un seul territoire publié : on y va directement
  useEffect(() => { if (list?.length === 1) location.replace(tenantHref(list[0].id)) }, [list])

  return (
    <main class="picker">
      <header class="picker-head">
        <span class="brand"><span class="brand-mark" aria-hidden="true" />Maillage<em>démonstrateur</em></span>
        <h1>Horaires, itinéraires et correspondances de votre territoire</h1>
        <p>Bus, cars Région et trains réunis dans une seule application, construite à partir des données ouvertes des réseaux.</p>
      </header>
      <h2 class="section-title">Choisissez votre territoire</h2>
      {error && <p class="notice">Impossible de charger la liste des territoires : {error}</p>}
      {!list && !error && <div class="spinner" aria-label="Chargement" />}
      <ul class="picker-list">
        {list?.map(t => (
          <li key={t.id}>
            <a class="picker-card" href={tenantHref(t.id)}>
              <span class="picker-name">{t.name}<small>{t.territory}</small></span>
              <span class="picker-tag">{t.tagline}</span>
              <span class="picker-meta">{t.lines} lignes · {t.stops} arrêts</span>
              <Icon name="back" size={18} />
            </a>
          </li>
        ))}
      </ul>
      <p class="small muted">Démonstrateur indépendant et non officiel, construit uniquement à partir de données ouvertes. Il n'est affilié à aucun des réseaux présentés.</p>
    </main>
  )
}
