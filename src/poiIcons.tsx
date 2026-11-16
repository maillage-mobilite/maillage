// Pictogrammes des lieux utiles : un par catégorie, identiques sur la carte (image MapLibre),
// dans la légende, les suggestions de recherche et la fiche du lieu. La couleur seule ne suffit pas
// à distinguer les catégories (daltonisme, petits marqueurs) : chaque pastille porte un dessin.

/** Tracés 24 × 24, trait blanc arrondi (même convention que les icônes de ui.tsx). */
export const POI_GLYPHS: Record<string, string> = {
  // bâtiment public à fronton
  services: 'M4 20h16M5 10h14M12 4 4 9h16l-8-5ZM7 10v7m5-7v7m5-7v7',
  // toque / école
  education: 'M2 9l10-5 10 5-10 5L2 9Zm4 2v5c2 2 10 2 12 0v-5',
  // croix
  sante: 'M12 5v14M5 12h14',
  // ballon et note : sport et culture
  loisirs: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-8.5 6.5h17M3.5 14.5h17M12 3c-2.5 2.5-2.5 15.5 0 18m0-18c2.5 2.5 2.5 15.5 0 18',
  // panier
  commerces: 'M5 9h14l-1.5 10h-11L5 9Zm4 0V7a3 3 0 0 1 6 0v2',
  // flèches de recyclage
  dechets: 'M7 19h10M8 19l-2-9h12l-2 9M9 10V7h6v3M4 10h16',
  // avion
  transport: 'M3 13l8-2V5a1 1 0 0 1 2 0v6l8 2v2l-8-1v4l2 2H9l2-2v-4l-8 1v-2Z',
}

export const poiGlyph = (cat: string) => POI_GLYPHS[cat] ?? 'M12 8v8M8 12h8'

/** Pastille ronde colorée avec le pictogramme de la catégorie (légende, listes, fiche). */
export function PoiBadge({ cat, color, size = 22 }: { cat: string; color?: string; size?: number }) {
  return (
    <svg class="poi-badge" width={size} height={size} viewBox="0 0 28 28" aria-hidden="true">
      <circle cx="14" cy="14" r="13" fill={color ?? '#6b7280'} stroke="#fff" stroke-width="2" />
      <g transform="translate(5.6 5.6) scale(0.7)" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
        <path d={poiGlyph(cat)} />
      </g>
    </svg>
  )
}

/** Même pastille en image pour la carte (px = taille réelle, affichée en px / 2 avec pixelRatio 2). */
export function poiImage(cat: string, color: string, px = 56): ImageData {
  const c = document.createElement('canvas')
  c.width = c.height = px
  const g = c.getContext('2d')!
  const r = px / 2
  g.beginPath()
  g.arc(r, r, r - 3, 0, Math.PI * 2)
  g.fillStyle = color
  g.fill()
  g.lineWidth = px * 0.07
  g.strokeStyle = '#ffffff'
  g.stroke()
  g.save()
  const s = (px * 0.62) / 24
  g.translate(r - 12 * s, r - 12 * s)
  g.scale(s, s)
  g.lineWidth = 2.4
  g.lineCap = 'round'
  g.lineJoin = 'round'
  g.strokeStyle = '#ffffff'
  g.stroke(new Path2D(poiGlyph(cat)))
  g.restore()
  return g.getImageData(0, 0, px, px)
}
