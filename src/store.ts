// Favoris stockés sur l'appareil uniquement (pas de compte : ADR-010).
import { useEffect, useState } from 'preact/hooks'

export interface Favorites { places: string[]; routes: string[] }

const KEY = 'maillage:favorites:v1'

function read(): Favorites {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (v && Array.isArray(v.places) && Array.isArray(v.routes)) return v
  } catch { /* stockage indisponible : on continue sans */ }
  return { places: [], routes: [] }
}

export function useFavorites() {
  const [fav, setFav] = useState<Favorites>(read)
  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(fav)) } catch { /* idem */ }
  }, [fav])
  const toggle = (kind: keyof Favorites, key: string) =>
    setFav(f => ({ ...f, [kind]: f[kind].includes(key) ? f[kind].filter(k => k !== key) : [...f[kind], key] }))
  return { fav, toggle }
}
