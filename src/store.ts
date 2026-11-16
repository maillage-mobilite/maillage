// Favoris et lieux enregistrés, stockés sur l'appareil uniquement (pas de compte : ADR-010).
import { useEffect, useState } from 'preact/hooks'
import { storageKey } from './tenant'

export type LocationKind = 'home' | 'work' | 'school' | 'other'

/** Lieu enregistré par l'usager (adresse, arrêt ou gare). */
export interface SavedLocation { id: string; kind: LocationKind; name: string; label: string; lat: number; lon: number }

export interface Favorites { places: string[]; routes: string[]; locations: SavedLocation[] }

export const LOCATION_META: Record<LocationKind, { name: string; icon: string }> = {
  home: { name: 'Domicile', icon: 'home' },
  work: { name: 'Travail', icon: 'work' },
  school: { name: 'École', icon: 'school' },
  other: { name: 'Lieu', icon: 'pin' },
}

const KEY = storageKey('favorites:v1')

function read(): Favorites {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (v && Array.isArray(v.places) && Array.isArray(v.routes)) {
      const locations = Array.isArray(v.locations)
        ? v.locations.filter((l: any) => l && typeof l.lat === 'number' && typeof l.lon === 'number' && l.kind in LOCATION_META)
        : []
      return { places: v.places, routes: v.routes, locations }
    }
  } catch { /* stockage indisponible : on continue sans */ }
  return { places: [], routes: [], locations: [] }
}

export function useFavorites() {
  const [fav, setFav] = useState<Favorites>(read)
  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(fav)) } catch { /* idem */ }
  }, [fav])
  const toggle = (kind: 'places' | 'routes', key: string) =>
    setFav(f => ({ ...f, [kind]: f[kind].includes(key) ? f[kind].filter(k => k !== key) : [...f[kind], key] }))
  /** Domicile / Travail / École sont uniques : en enregistrer un remplace le précédent. */
  const saveLocation = (loc: SavedLocation) =>
    setFav(f => ({
      ...f,
      locations: [...f.locations.filter(l => l.id !== loc.id && (loc.kind === 'other' || l.kind !== loc.kind)), loc]
        .sort((a, b) => Object.keys(LOCATION_META).indexOf(a.kind) - Object.keys(LOCATION_META).indexOf(b.kind)),
    }))
  const removeLocation = (id: string) => setFav(f => ({ ...f, locations: f.locations.filter(l => l.id !== id) }))
  return { fav, toggle, saveLocation, removeLocation }
}
