// Petits composants d'interface partagés.
import { BRAND } from './brand'
import { createContext, type ComponentChildren } from 'preact'
import { useContext } from 'preact/hooks'
import { Network, Route, fmtHM, fmtDay, addDays, parisNow, type MairieMessage } from './net'

const PATHS: Record<string, string> = {
  map: 'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Zm0 0v14m6-12v14',
  search: 'm21 21-4.3-4.3M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Z',
  route: 'M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm12-10a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM6 15V9a4 4 0 0 1 4-4h4m-4 14h4a4 4 0 0 0 4-4V9',
  alert: 'M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  star: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9L12 3Z',
  user: 'M20 21a8 8 0 1 0-16 0m8-10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  back: 'M15 18l-6-6 6-6',
  swap: 'M7 4v16m0 0-3-3m3 3 3-3M17 20V4m0 0-3 3m3-3 3 3',
  locate: 'M12 2v3m0 14v3M2 12h3m14 0h3m-10 7a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm0-4a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  walk: 'M13 4a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm-2.5 4.5L8 21m2.5-12.5L14 11l3 1m-6.5-3.5L13 6l-3 1-2 3m5 4 2 7',
  bus: 'M6 17h12M6 17v2m12-2v2M5 6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v11H5V6Zm0 5h14M8 14h.01M16 14h.01',
  phone: 'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z',
  external: 'M14 4h6v6m0-6L10 14M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  clock: 'M12 7v5l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  info: 'M12 16v-4m0-4h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  check: 'M20 6 9 17l-5-5',
  close: 'M18 6 6 18M6 6l12 12',
  data: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Zm0 0v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  ticket: 'M3 8V6a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v2a2 2 0 0 0 0 4v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-2a2 2 0 0 0 0-4Zm10-3v14',
  train: 'M8 3h8a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Zm-3 7h14M9 14h.01M15 14h.01M8 21l2-4m6 4-2-4',
  layers: 'm12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5',
  home: 'M3 11 12 4l9 7M5 10v10h5v-6h4v6h5V10',
  work: 'M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M4 7h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Zm-1 6h18',
  school: 'M2 9l10-5 10 5-10 5L2 9Zm4 2v5c2 2 10 2 12 0v-5M22 9v6',
  pin: 'M12 21s-7-6.2-7-11a7 7 0 1 1 14 0c0 4.8-7 11-7 11Zm0-8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  plus: 'M12 5v14M5 12h14',
  edit: 'M4 20h4L19 9l-4-4L4 16v4Zm11-15 4 4',
  calendar: 'M8 3v4m8-4v4M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z',
}

export function Icon({ name, size = 20, filled = false, label }: { name: keyof typeof PATHS | string; size?: number; filled?: boolean; label?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden={label ? undefined : 'true'} role={label ? 'img' : undefined} aria-label={label}>
      <path d={PATHS[name] ?? ''} />
    </svg>
  )
}

/** Aperçu d'une ligne au survol (souris ou clavier) depuis n'importe quelle liste du panneau. */
export const RoutePreview = createContext<{ enter: (r: number) => void; leave: (r: number) => void }>({ enter: () => {}, leave: () => {} })

/** Gestionnaires à poser sur un élément qui représente une ligne. */
export function usePreview(route: number) {
  const p = useContext(RoutePreview)
  return { onMouseEnter: () => p.enter(route), onMouseLeave: () => p.leave(route), onFocus: () => p.enter(route), onBlur: () => p.leave(route) }
}

export function Pill({ route, small }: { route: Route; small?: boolean }) {
  const p = useContext(RoutePreview)
  return (
    <span class={`pill${small ? ' pill-sm' : ''}${route.kind === 'tad' ? ' pill-tad' : ''}`} style={{ background: route.color, color: route.text }}
      onMouseEnter={() => p.enter(route.i)} onMouseLeave={() => p.leave(route.i)}
      title={`${route.short} · ${route.long}`}>
      {route.short}
    </span>
  )
}

/** Heure de passage : relative si proche, absolue sinon, préfixée du jour si ce n'est pas aujourd'hui. */
export function When({ abs, now, theoretical = true }: { abs: number; now: { date: string; sec: number }; theoretical?: boolean }) {
  const diff = Math.round((abs - now.sec) / 60)
  const dayOffset = Math.floor(abs / 86400)
  let text: string
  if (diff <= 0) text = 'maintenant'
  else if (diff < 60) text = `${diff} min`
  else if (dayOffset === 0) text = fmtHM(abs)
  else text = `${fmtDay(addDays(now.date, dayOffset), now.date)} ${fmtHM(abs)}`
  return (
    <span class={`when${diff < 60 && dayOffset === 0 ? ' soon' : ''}`}>
      {theoretical && <span class="dot-theo" title="Horaire théorique" aria-label="horaire théorique">○</span>}
      {text}
    </span>
  )
}

export function Header({ title, onBack, right, sub }: { title: ComponentChildren; onBack?: () => void; right?: ComponentChildren; sub?: ComponentChildren }) {
  return (
    <div class="sheet-header">
      {onBack && <button class="icon-btn" onClick={onBack} aria-label="Retour"><Icon name="back" /></button>}
      <div class="sheet-title">
        <h2>{title}</h2>
        {sub && <div class="sub">{sub}</div>}
      </div>
      {right}
    </div>
  )
}

export function Empty({ icon = 'info', title, children }: { icon?: string; title: string; children?: ComponentChildren }) {
  return (
    <div class="empty">
      <Icon name={icon} size={28} />
      <strong>{title}</strong>
      {children && <div>{children}</div>}
    </div>
  )
}

/** Lien « Signaler un problème » : courriel pré-rempli au réseau (s'il publie une adresse), copie à l'éditeur ; sinon à l'éditeur seul. */
export function ReportLink({ email, subject, context }: { email?: string; subject: string; context: string }) {
  const body = `Bonjour,\n\nJe souhaite signaler un problème :\n\n(décrivez ici : horaire erroné, arrêt déplacé, information manquante…)\n\n---\n${context}\nSignalé depuis ${BRAND.name} le ${new Date().toLocaleString('fr-FR')}.`
  return (
    <a class="report-link" href={`mailto:${email ?? BRAND.contact}?${email ? `cc=${BRAND.contact}&` : ''}subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`}>
      <Icon name="alert" size={16} /> Signaler un problème sur cette fiche
    </a>
  )
}

export function TheoNotice() {
  return (
    <p class="notice">
      <span class="dot-theo">○</span> Horaires théoriques publiés par le réseau, sans les retards : le réseau ne publie pas encore son temps réel en open data.
    </p>
  )
}

export function routeLabel(net: Network, r: number) {
  const route = net.routes[r]
  return `${route.short} — ${route.long}`
}

/** Messages publiés par les mairies (travaux, arrêt déplacé, événement), du plus urgent au moins urgent. */
export function MairieMessages({ messages, title }: { messages: MairieMessage[]; title?: string }) {
  if (!messages.length) return null
  const today = parisNow().date
  const fmt = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', timeZone: 'UTC' })
  const sorted = [...messages].sort((a, b) => (a.debut > today ? 1 : 0) - (b.debut > today ? 1 : 0) || (a.gravite === b.gravite ? a.debut.localeCompare(b.debut) : a.gravite === 'perturbation' ? -1 : 1))
  return (
    <section class="mairie-msgs" aria-label={title ?? 'Messages des mairies'}>
      {title && <h3 class="section-title">{title}</h3>}
      {sorted.map(m => {
        const upcoming = m.debut > today
        return (
          <article key={m.id} class={`card static alert-card mairie-msg${m.gravite === 'perturbation' ? ' warn' : ''}`}>
            <Icon name={m.gravite === 'perturbation' ? 'alert' : 'data'} />
            <div>
              <strong>{m.titre}</strong>
              {m.texte && <div class="small">{m.texte}</div>}
              <div class="small muted">
                {upcoming ? `À partir du ${fmt(m.debut)}` : `Jusqu'au ${fmt(m.fin)}`}{m.lignes.length ? ` · ligne${m.lignes.length > 1 ? 's' : ''} ${m.lignes.join(', ')}` : ''} · Mairie {/^[aeiouyhâéèêîôûAEIOUYHÉÈÊÎÔÛ]/.test(m.commune_nom) ? `d'${m.commune_nom}` : `de ${m.commune_nom}`}
              </div>
              {m.lien && <a class="small" href={m.lien} target="_blank" rel="noopener">En savoir plus ↗</a>}
            </div>
          </article>
        )
      })}
    </section>
  )
}
