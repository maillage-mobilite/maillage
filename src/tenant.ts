// Territoire affiché : choisi par l'adresse (?reseau=paysdegex). Sans paramètre, la page d'accueil
// propose les territoires disponibles (public/data/tenants.json, tenu à jour par le pipeline).
// Chaque territoire a son dossier de données (public/data/<id>/) et ses propres favoris.

export interface TenantEntry { id: string; name: string; territory: string; tagline: string; lines: number; stops: number; updated: string }

const param = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('reseau')
/** Identifiant du territoire choisi, ou null (page d'accueil). */
export const TENANT: string | null = param && /^[a-z0-9-]+$/.test(param) ? param : null

const base = import.meta.env.BASE_URL

/** Adresse d'un fichier de données du territoire courant. */
export const dataUrl = (file: string) => `${base}data/${TENANT}/${file}`

export async function loadTenants(): Promise<TenantEntry[]> {
  const res = await fetch(`${base}data/tenants.json`, { cache: 'no-cache' })
  if (!res.ok) throw new Error(`Liste des territoires indisponible (${res.status})`)
  return res.json()
}

export const tenantHref = (id: string) => `?reseau=${id}`

/**
 * Clé de stockage local propre au territoire (favoris, lieux…). CoqueliGO garde ses anciennes
 * clés pour ne pas perdre les favoris enregistrés avant l'arrivée des autres territoires.
 */
export const storageKey = (key: string) => (TENANT === 'coqueligo' ? `maillage:${key}` : `maillage:${TENANT}:${key}`)
