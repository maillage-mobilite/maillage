import { BRAND } from './brand'
// Espace mairie : messages d'info trafic, lieux utiles, statistiques et code de l'encart.
// Parle au serveur mairie/serveur.py (/api/mairie/…). Pas de bibliothèque : DOM et fetch.
import './mairie.css'

type Commune = { slug: string; nom: string; territoire: string }
type Moi = { email: string; nom: string; communes: Commune[] }
type Ligne = { code: string; nom: string; couleur: string; texte: string }
type Contexte = { slug: string; nom: string; territoire: string; reseau: string; bbox: number[]; center: [number, number] | null; lignes: Ligne[]; arrets: string[]; categories: { id: string; label: string }[] }
type Message = { id?: string; titre: string; texte: string; debut: string; fin: string; gravite: 'info' | 'perturbation'; lignes: string[]; arrets: string[]; lien: string; modifie?: string; auteur?: string }
type Lieu = { id?: string; nom: string; cat: string; lat: number; lon: number; adresse: string; horaires: string; tel: string; web: string }
type Osm = { cle: string; nom: string; cat: string; type: string; lat: number; lon: number; masque: boolean }
type Stats = { mois: string; jours: { jour: string; affichages: number }[]; historique: { mois: string; affichages: number; clics: number }[]; formats: [string, number][]; sites: [string, number][]; appareils: [string, number][] }

const app = document.getElementById('m-app')!
const compteEl = document.getElementById('m-compte')!
const statutEl = document.getElementById('m-statut')!
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = app) => root.querySelector(sel) as T
const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = app) => [...root.querySelectorAll(sel)] as T[]
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const auj = () => iso(new Date())
const fmtDate = (s: string) => new Date(s + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'long' })
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']
const fmtMois = (m: string) => { const [y, k] = m.split('-').map(Number); return `${MOIS[k - 1]} ${y}` }

const ICONES: Record<string, string> = {
  alert: 'M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  pin: 'M12 21s-7-6.2-7-11a7 7 0 1 1 14 0c0 4.8-7 11-7 11Zm0-8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  chart: 'M4 20V10m6 10V4m6 16v-7m4 7H3',
  code: 'm9 18-6-6 6-6m6 0 6 6-6 6',
  check: 'M20 6 9 17l-5-5',
  clock: 'M12 7v5l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  bus: 'M6 17h12M6 17v2m12-2v2M5 6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v11H5V6Zm0 5h14M8 14h.01M16 14h.01',
  mail: 'M4 6h16v12H4V6Zm0 0 8 7 8-7',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  click: 'M9 9l11 4-5 2-2 5-4-11ZM5 3v3M3 5h3M3.5 9.5 5 8M9.5 3.5 8 5',
  percent: 'M19 5 5 19M7 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm10 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
  info: 'M12 16v-4m0-4h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
}
const ic = (n: string, cls = '') => `<svg class="ic${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONES[n]}"/></svg>`
const vide = (n: string, t: string) => `<div class="m-empty">${ic(n, 'lg')}<span>${t}</span></div>`

let tStatut = 0
function statut(t: string) {
  statutEl.textContent = t; statutEl.classList.add('on')
  clearTimeout(tStatut); tStatut = window.setTimeout(() => statutEl.classList.remove('on'), 3500)
}

async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const r = await fetch(`/api/mairie${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'), credentials: 'same-origin',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const d = await r.json().catch(() => ({}))
  if (r.status === 401) { connexion(); throw new Error(d.erreur ?? 'non connecté') }
  if (!r.ok) throw new Error(d.erreur ?? `erreur ${r.status}`)
  return d as T
}

// ------------------------------------------------------------------ connexion

function connexion(info?: string) {
  compteEl.innerHTML = ''
  app.innerHTML = `
    <div class="m-login-wrap">
      <div class="m-login-aside">
        <h2>L'information transport de votre commune</h2>
        <ul>
          <li>${ic('alert')}<span><strong>Prévenez vos habitants</strong>Travaux, arrêt déplacé, marché : votre message s'affiche sur votre site et dans l'application.</span></li>
          <li>${ic('pin')}<span><strong>Complétez vos lieux</strong>Mairie, écoles, salles : chacun a son « Comment venir » en bus.</span></li>
          <li>${ic('chart')}<span><strong>Suivez l'usage</strong>Affichages et clics de l'encart, sans cookie ni donnée personnelle.</span></li>
        </ul>
        <div class="m-tiles" aria-hidden="true">${'<i></i>'.repeat(18)}</div>
      </div>
      <section class="m-login" aria-labelledby="t-cnx">
        <h1 id="t-cnx">Espace mairie</h1>
        <p class="m-muted">Connectez-vous avec l'adresse e-mail enregistrée pour votre mairie.</p>
        ${info ? `<p class="m-badge ok" role="status">${esc(info)}</p>` : ''}
        <form id="f-cnx">
          <label class="m-field"><span>Adresse e-mail de la mairie</span><input type="email" name="email" required autocomplete="email" placeholder="accueil@mairie-exemple.fr" /></label>
          <button class="m-btn primary" type="submit">${ic('mail')}Recevoir un lien de connexion</button>
        </form>
        <p class="m-small m-muted">Pas de mot de passe : un lien valable 15 minutes vous est envoyé par e-mail. Votre adresse doit avoir été enregistrée par l'éditeur de ${esc(BRAND.name)}.</p>
      </section>
    </div>`
  $<HTMLFormElement>('#f-cnx').onsubmit = async e => {
    e.preventDefault()
    const email = (new FormData(e.target as HTMLFormElement).get('email') as string).trim()
    try {
      await api('/connexion', { body: { email } })
      app.innerHTML = `<section class="m-card m-login" style="max-width:560px;margin:32px auto"><div class="m-done"><span class="m-done-ic">${ic('mail')}</span><div>
        <h1>Vérifiez votre messagerie</h1>
        <p>Si l'adresse <strong>${esc(email)}</strong> est enregistrée, un lien de connexion vient de lui être envoyé. Il est valable 15 minutes.</p>
        <p class="m-small m-muted">Rien reçu après quelques minutes ? Regardez dans les indésirables, puis <a href="./mairie.html">recommencez</a> ou écrivez à ${esc(BRAND.contact)}.</p></div></div></section>`
    } catch (err) { statut((err as Error).message) }
  }
}

// ------------------------------------------------------------------ espace

let moi: Moi
let commune: Commune
let ctx: Contexte
let onglet: 'messages' | 'lieux' | 'stats' | 'encart' = 'messages'

async function demarrer() {
  const m = location.hash.match(/jeton=([A-Za-z0-9_-]+)/)
  if (m) {
    history.replaceState(null, '', location.pathname) // le jeton ne reste ni dans l'adresse ni dans l'historique
    try { await api('/session', { body: { jeton: m[1] } }) } catch (e) { return connexion((e as Error).message) }
  }
  try { moi = await api<Moi>('/moi') } catch { return }
  if (!moi.communes.length) { app.innerHTML = `<p>Aucune commune n'est rattachée à ce compte. Écrivez à ${esc(BRAND.contact)}.</p>`; return }
  const choix = localStorage.getItem('maillage-mairie-commune')
  commune = moi.communes.find(c => c.slug === choix) ?? moi.communes[0]
  compteEl.innerHTML = `
    ${moi.communes.length > 1 ? `<label><span class="m-sr">Commune</span><select id="m-commune">${moi.communes.map(c => `<option value="${c.slug}"${c.slug === commune.slug ? ' selected' : ''}>${esc(c.nom)}</option>`).join('')}</select></label>` : ''}
    <span class="m-avatar" aria-hidden="true">${esc((moi.nom || moi.email).replace(/^(mairie|ville|commune)\s+(d'|de\s+|du\s+)?/i, '').slice(0, 1).toUpperCase())}</span><span class="m-email">${esc(moi.email)}</span><button class="m-btn small" id="m-deco">Se déconnecter</button>`
  $('#m-deco', compteEl).onclick = async () => { await api('/deconnexion', { body: {} }).catch(() => {}); connexion('Vous êtes déconnecté.') }
  const sel = $<HTMLSelectElement>('#m-commune', compteEl)
  if (sel) sel.onchange = () => { commune = moi.communes.find(c => c.slug === sel.value)!; localStorage.setItem('maillage-mairie-commune', commune.slug); charger() }
  charger()
}

let enCours = 0, affichagesMois = 0
async function charger() {
  ctx = await api<Contexte>(`/communes/${commune.slug}/contexte`)
  const [m, st] = await Promise.all([
    api<{ messages: Message[] }>(`/communes/${commune.slug}/messages`).catch(() => ({ messages: [] as Message[] })),
    api<Stats>(`/communes/${commune.slug}/stats?mois=${auj().slice(0, 7)}`).catch(() => null),
  ])
  enCours = m.messages.filter(x => x.debut <= auj() && x.fin >= auj()).length
  affichagesMois = st ? st.jours.reduce((a, j) => a + j.affichages, 0) : 0
  rendre()
}

function rendre() {
  const tabs: [typeof onglet, string, string][] = [['messages', 'Messages', 'alert'], ['lieux', 'Lieux utiles', 'pin'], ['stats', 'Statistiques', 'chart'], ['encart', 'Encart', 'code']]
  const n = ctx.lignes.length
  app.innerHTML = `
    <section class="m-hero" aria-labelledby="t-commune">
      <div class="m-hero-t">
        <h1 id="t-commune">${esc(ctx.nom)}</h1>
        <p>Réseau ${esc(ctx.reseau)} · ${n} ligne${n > 1 ? 's desservent' : ' dessert'} les arrêts de la commune</p>
        <div class="m-lines" aria-label="Lignes">${ctx.lignes.map(l => `<span class="pill" style="background:${esc(l.couleur)};color:${esc(l.texte)}" title="${esc(l.nom)}">${esc(l.code)}</span>`).join('')}</div>
      </div>
      <div class="m-hero-stats">
        <div class="m-stat${enCours ? ' hot' : ''}"><strong>${enCours}</strong><span>message${enCours > 1 ? 's' : ''} en cours</span></div>
        <div class="m-stat"><strong>${affichagesMois}</strong><span>affichages ce mois-ci</span></div>
      </div>
    </section>
    <div class="m-tabs" role="tablist" aria-label="Rubriques">${tabs.map(([k, l, i]) => `<button role="tab" id="tab-${k}" data-t="${k}" aria-controls="m-vue" aria-selected="${k === onglet}" tabindex="${k === onglet ? 0 : -1}">${ic(i)}${l}</button>`).join('')}</div>
    <div id="m-vue" role="tabpanel" aria-labelledby="tab-${onglet}"></div>`
  const boutons = $$<HTMLButtonElement>('[data-t]')
  const choisir = (k: string, focus = false) => { onglet = k as typeof onglet; rendre(); if (focus) $<HTMLButtonElement>(`#tab-${k}`).focus() }
  boutons.forEach((b, i) => {
    b.onclick = () => choisir(b.dataset.t!)
    b.onkeydown = e => {
      const j = e.key === 'ArrowRight' ? (i + 1) % boutons.length : e.key === 'ArrowLeft' ? (i - 1 + boutons.length) % boutons.length : e.key === 'Home' ? 0 : e.key === 'End' ? boutons.length - 1 : -1
      if (j >= 0) { e.preventDefault(); choisir(boutons[j].dataset.t!, true) }
    }
  })
  const vue = $('#m-vue')
  ;({ messages: vueMessages, lieux: vueLieux, stats: vueStats, encart: vueEncart })[onglet](vue)
}

// ------------------------------------------------------------------ messages

function etatMessage(m: Message) {
  const a = auj()
  return m.fin < a ? ['off', 'Terminé'] : m.debut > a ? ['', 'À venir'] : m.gravite === 'perturbation' ? ['warn', 'En cours'] : ['ok', 'En cours']
}

async function vueMessages(vue: HTMLElement, edition?: Message) {
  const { messages } = await api<{ messages: Message[] }>(`/communes/${commune.slug}/messages`)
  const actifs = messages.filter(m => m.fin >= auj()), passes = messages.filter(m => m.fin < auj()).slice(0, 10)
  const item = (m: Message) => {
    const [cls, lab] = etatMessage(m)
    return `<li class="m-item"><div class="t"><span class="m-badge ${cls}">${lab}</span>${m.gravite === 'perturbation' ? '<span class="m-badge warn">Perturbation</span>' : ''}
      <strong>${esc(m.titre)}</strong><span class="m-small m-muted">du ${fmtDate(m.debut)} au ${fmtDate(m.fin)}${m.lignes.length ? ` · ligne(s) ${m.lignes.map(esc).join(', ')}` : ''}${m.arrets.length ? ` · ${m.arrets.map(esc).join(', ')}` : ''}</span>
      ${m.texte ? `<div class="m-small">${esc(m.texte)}</div>` : ''}</div>
      <div class="m-actions"><button class="m-btn small" data-edit="${m.id}">Modifier</button>${m.fin >= auj() ? `<button class="m-btn small" data-stop="${m.id}">Terminer aujourd'hui</button>` : ''}<button class="m-btn small danger" data-del="${m.id}">Supprimer</button></div></li>`
  }
  vue.innerHTML = `
    <section class="m-card" aria-labelledby="t-form">
      <h2 id="t-form">${edition?.id ? 'Modifier le message' : 'Nouveau message'}</h2>
      <p class="m-small m-muted">Affiché dans l'encart de votre site, dans l'onglet « Info trafic » de l'application et sur les fiches des lignes et arrêts choisis, du premier au dernier jour inclus.</p>
      <div class="m-compose"><form id="f-msg">
        <label class="m-field"><span>Titre <small>(90 caractères au plus)</small></span><input type="text" name="titre" maxlength="90" required placeholder="Ex. : Arrêt Fruitière déplacé pendant les travaux" /></label>
        <label class="m-field"><span>Détail <small>(facultatif, 600 caractères au plus)</small></span><textarea name="texte" maxlength="600" placeholder="Ex. : l'arrêt provisoire se trouve 50 m plus loin, devant la pharmacie."></textarea></label>
        <fieldset><legend>Type</legend><div class="m-radio">
          <label><input type="radio" name="gravite" value="perturbation" checked /> Perturbation (travaux, déviation, arrêt déplacé)</label>
          <label><input type="radio" name="gravite" value="info" /> Information (marché, événement, nouveauté)</label></div></fieldset>
        <div class="m-row">
          <label class="m-field"><span>Premier jour</span><input type="date" name="debut" required /></label>
          <label class="m-field"><span>Dernier jour</span><input type="date" name="fin" required /></label>
        </div>
        <fieldset><legend>Lignes concernées <small class="m-muted">(facultatif)</small></legend><div class="m-pills">
          ${ctx.lignes.map(l => `<label class="m-check"><input type="checkbox" name="lignes" value="${esc(l.code)}" /><span class="pill" style="background:${esc(l.couleur)};color:${esc(l.texte)}">${esc(l.code)}</span> ${esc(l.nom)}</label>`).join('')}</div></fieldset>
        <fieldset><legend>Arrêts concernés <small class="m-muted">(facultatif)</small></legend><div class="m-pills">
          ${ctx.arrets.map(a => `<label class="m-check"><input type="checkbox" name="arrets" value="${esc(a)}" /> ${esc(a)}</label>`).join('')}</div></fieldset>
        <label class="m-field"><span>Lien vers plus d'informations <small>(facultatif, adresse https://)</small></span><input type="url" name="lien" placeholder="https://…" /></label>
        <div class="m-actions"><button class="m-btn primary" type="submit">${ic('check')}${edition?.id ? 'Enregistrer les modifications' : 'Publier le message'}</button>${edition?.id ? '<button class="m-btn" type="button" id="b-annuler">Annuler</button>' : ''}</div>
      </form>
      <section class="m-apercu" aria-label="Aperçu dans l'encart"><p>Aperçu dans l'encart</p><div id="apercu-msg"></div>
        <div class="w-fake" aria-hidden="true"><b>Prochains départs à ${esc(ctx.nom)}</b>…</div></section></div>
    </section>
    <h2>Messages en cours et à venir <span class="m-count">${actifs.length}</span></h2>
    ${actifs.length ? `<ul class="m-list m-card">${actifs.map(item).join('')}</ul>` : vide('alert', 'Aucun message en cours. Un arrêt déplacé, des travaux, un marché ? Rédigez-le ci-dessus : il s’affichera aussitôt.')}
    ${passes.length ? `<h2>Terminés récemment <span class="m-count">${passes.length}</span></h2><ul class="m-list m-card">${passes.map(item).join('')}</ul>` : ''}`
  const f = $<HTMLFormElement>('#f-msg', vue)
  const e = edition ?? { titre: '', texte: '', debut: auj(), fin: iso(new Date(Date.now() + 7 * 864e5)), gravite: 'perturbation', lignes: [], arrets: [], lien: '' }
  ;(f.titre as unknown as HTMLInputElement).value = e.titre
  f.texte.value = e.texte
  f.debut.value = e.debut; f.fin.value = e.fin; f.lien.value = e.lien
  $$<HTMLInputElement>('input[name=gravite]', f).forEach(i => (i.checked = i.value === e.gravite))
  $$<HTMLInputElement>('input[name=lignes]', f).forEach(i => (i.checked = e.lignes.includes(i.value)))
  $$<HTMLInputElement>('input[name=arrets]', f).forEach(i => (i.checked = e.arrets.includes(i.value)))
  const apercu = () => {
    const fd = new FormData(f)
    const titre = String(fd.get('titre') || '').trim(), texte = String(fd.get('texte') || '').trim()
    $('#apercu-msg', vue).innerHTML = `<div class="w-msg${fd.get('gravite') === 'perturbation' ? ' warn' : ''}"><strong>${esc(titre || 'Titre du message')}</strong>${texte ? `<span>${esc(texte)}</span>` : ''}</div>`
  }
  f.addEventListener('input', apercu); apercu()
  if (edition) f.scrollIntoView({ behavior: 'smooth', block: 'start' })
  const annuler = $('#b-annuler', vue); if (annuler) annuler.onclick = () => vueMessages(vue)
  f.onsubmit = async ev => {
    ev.preventDefault()
    const fd = new FormData(f)
    const body: Message = { titre: String(fd.get('titre')), texte: String(fd.get('texte')), debut: String(fd.get('debut')), fin: String(fd.get('fin')),
      gravite: fd.get('gravite') as Message['gravite'], lignes: fd.getAll('lignes').map(String), arrets: fd.getAll('arrets').map(String), lien: String(fd.get('lien')).trim() }
    try {
      await api(`/communes/${commune.slug}/messages${edition?.id ? '/' + edition.id : ''}`, { method: edition?.id ? 'PUT' : 'POST', body })
      statut(edition?.id ? 'Message modifié : visible dans une minute au plus.' : 'Message publié : visible dans une minute au plus.')
      vueMessages(vue)
    } catch (err) { statut((err as Error).message) }
  }
  $$('[data-edit]', vue).forEach(b => (b.onclick = () => vueMessages(vue, messages.find(m => m.id === b.dataset.edit))))
  $$('[data-stop]', vue).forEach(b => (b.onclick = async () => {
    const m = messages.find(x => x.id === b.dataset.stop)!
    try { await api(`/communes/${commune.slug}/messages/${m.id}`, { method: 'PUT', body: { ...m, fin: auj(), debut: m.debut > auj() ? auj() : m.debut } }); statut('Message terminé ce soir.'); vueMessages(vue) } catch (err) { statut((err as Error).message) }
  }))
  $$('[data-del]', vue).forEach(b => (b.onclick = async () => {
    if (!confirm('Supprimer ce message ?')) return
    try { await api(`/communes/${commune.slug}/messages/${b.dataset.del}`, { method: 'DELETE' }); statut('Message supprimé.'); vueMessages(vue) } catch (err) { statut((err as Error).message) }
  }))
}

// ------------------------------------------------------------------ lieux utiles

async function vueLieux(vue: HTMLElement, edition?: Lieu) {
  const { ajouts, osm } = await api<{ ajouts: Lieu[]; osm: Osm[] }>(`/communes/${commune.slug}/lieux`)
  const catLabel = (c: string) => ctx.categories.find(x => x.id === c)?.label ?? c
  vue.innerHTML = `
    <p class="m-intro">Les lieux utiles apparaissent sur la carte de l'application, dans sa recherche et dans l'encart « Comment venir ». Ils viennent d'OpenStreetMap ; ajoutez ici ceux qui manquent et masquez ceux qui ne doivent pas apparaître.</p>
    <section class="m-card" aria-labelledby="t-lieu">
      <h2 id="t-lieu">${edition?.id ? 'Modifier le lieu' : 'Ajouter un lieu'}</h2>
      <form id="f-lieu">
        <div class="m-row">
          <label class="m-field"><span>Nom</span><input type="text" name="nom" maxlength="90" required placeholder="Ex. : Marché du samedi" /></label>
          <label class="m-field"><span>Catégorie</span><select name="cat" required>${ctx.categories.map(c => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join('')}</select></label>
        </div>
        <label class="m-field"><span>Adresse <small>(pour trouver la position)</small></span><input type="text" name="adresse" maxlength="160" placeholder="Ex. : place de la Mairie" /></label>
        <div class="m-actions" style="margin-top:0"><button class="m-btn small" type="button" id="b-geo">Trouver la position</button><span id="geo" class="m-geo" aria-live="polite"></span></div>
        <input type="hidden" name="lat" /><input type="hidden" name="lon" />
        <div class="m-row">
          <label class="m-field"><span>Horaires <small>(facultatif)</small></span><input type="text" name="horaires" maxlength="200" placeholder="Ex. : samedi 8 h – 12 h" /></label>
          <label class="m-field"><span>Téléphone <small>(facultatif)</small></span><input type="tel" name="tel" maxlength="30" /></label>
        </div>
        <label class="m-field"><span>Site <small>(facultatif, https://)</small></span><input type="url" name="web" placeholder="https://…" /></label>
        <div class="m-actions"><button class="m-btn primary" type="submit">${edition?.id ? 'Enregistrer' : 'Ajouter le lieu'}</button>${edition?.id ? '<button class="m-btn" type="button" id="b-annuler">Annuler</button>' : ''}</div>
      </form>
    </section>
    <h2>Lieux ajoutés par la mairie <span class="m-count">${ajouts.length}</span></h2>
    ${ajouts.length ? `<ul class="m-list m-card">${ajouts.map(l => `<li class="m-item"><div class="t"><span class="m-badge">${esc(catLabel(l.cat))}</span><strong>${esc(l.nom)}</strong><span class="m-small m-muted">${esc(l.adresse || `${l.lat.toFixed(5)}, ${l.lon.toFixed(5)}`)}${l.horaires ? ' · ' + esc(l.horaires) : ''}</span></div>
      <div class="m-actions"><button class="m-btn small" data-edit="${l.id}">Modifier</button><button class="m-btn small danger" data-del="${l.id}">Supprimer</button></div></li>`).join('')}</ul>` : vide('pin', 'Aucun lieu ajouté pour l’instant. Un marché, une salle, un équipement manque ? Ajoutez-le ci-dessus.')}
    <h2>Lieux issus d'OpenStreetMap <span class="m-count">${osm.length}</span></h2>
    <label class="m-field"><span class="m-sr">Filtrer</span><input type="search" id="q-osm" placeholder="Filtrer : mairie, école, pharmacie…" /></label>
    <ul class="m-list m-card" id="l-osm">${osm.map(p => `<li class="m-item" data-n="${esc(p.nom.toLowerCase() + ' ' + p.type.toLowerCase())}"><div class="t"><span class="m-badge ${p.masque ? 'off' : ''}">${esc(catLabel(p.cat))}</span><strong>${esc(p.nom)}</strong><span class="m-small m-muted">${esc(p.type)}${p.masque ? ' · masqué' : ''}</span></div>
      <div class="m-actions"><button class="m-btn small" data-mask="${esc(p.cle)}" data-v="${p.masque ? '0' : '1'}">${p.masque ? 'Afficher' : 'Masquer'}</button></div></li>`).join('')}</ul>
    <p class="m-small m-muted">Une erreur dans un lieu OpenStreetMap (nom, horaires) se corrige durablement sur openstreetmap.org : elle sera reprise à la mise à jour suivante.</p>`
  const f = $<HTMLFormElement>('#f-lieu', vue)
  const e = edition
  if (e) { for (const k of ['nom', 'cat', 'adresse', 'horaires', 'tel', 'web'] as const) (f.elements.namedItem(k) as HTMLInputElement).value = e[k]; f.lat.value = String(e.lat); f.lon.value = String(e.lon); $('#geo', vue).textContent = `Position : ${e.lat.toFixed(5)}, ${e.lon.toFixed(5)}`; f.scrollIntoView({ behavior: 'smooth' }) }
  const annuler = $('#b-annuler', vue); if (annuler) annuler.onclick = () => vueLieux(vue)
  $('#b-geo', vue).onclick = async () => {
    const q = `${f.adresse.value} ${ctx.nom}`.trim()
    const c = ctx.center ?? [0, 0]
    try {
      const r = await (await fetch(`https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(q)}&limit=1&lat=${c[1]}&lon=${c[0]}`)).json()
      const ft = r.features?.[0]
      if (!ft) { $('#geo', vue).textContent = 'Adresse introuvable : précisez-la.'; return }
      const [lon, lat] = ft.geometry.coordinates
      f.lat.value = String(lat); f.lon.value = String(lon)
      $('#geo', vue).innerHTML = `Trouvé : ${esc(ft.properties.label)} · <a href="https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=18/${lat}/${lon}" target="_blank" rel="noopener">vérifier sur la carte</a>`
    } catch { $('#geo', vue).textContent = 'Service d\'adresses indisponible, réessayez.' }
  }
  f.onsubmit = async ev => {
    ev.preventDefault()
    if (!f.lat.value) { statut('Cliquez d\'abord sur « Trouver la position ».'); return }
    const fd = new FormData(f)
    const body = Object.fromEntries(['nom', 'cat', 'adresse', 'horaires', 'tel', 'web', 'lat', 'lon'].map(k => [k, String(fd.get(k) ?? '').trim()]))
    try {
      await api(`/communes/${commune.slug}/lieux${e?.id ? '/' + e.id : ''}`, { method: e?.id ? 'PUT' : 'POST', body })
      statut(e?.id ? 'Lieu modifié.' : 'Lieu ajouté : visible dans une minute au plus.')
      vueLieux(vue)
    } catch (err) { statut((err as Error).message) }
  }
  $$('[data-edit]', vue).forEach(b => (b.onclick = () => vueLieux(vue, ajouts.find(l => l.id === b.dataset.edit))))
  $$('[data-del]', vue).forEach(b => (b.onclick = async () => {
    if (!confirm('Supprimer ce lieu ?')) return
    try { await api(`/communes/${commune.slug}/lieux/${b.dataset.del}`, { method: 'DELETE' }); statut('Lieu supprimé.'); vueLieux(vue) } catch (err) { statut((err as Error).message) }
  }))
  $$('[data-mask]', vue).forEach(b => (b.onclick = async () => {
    try { await api(`/communes/${commune.slug}/masques`, { body: { cle: b.dataset.mask, masque: b.dataset.v === '1' } }); statut(b.dataset.v === '1' ? 'Lieu masqué.' : 'Lieu affiché.'); vueLieux(vue) } catch (err) { statut((err as Error).message) }
  }))
  const q = $<HTMLInputElement>('#q-osm', vue)
  q.oninput = () => { const v = q.value.toLowerCase().trim(); $$('#l-osm > li', vue).forEach(li => (li.hidden = !!v && !li.dataset.n!.includes(v))) }
}

// ------------------------------------------------------------------ statistiques

async function vueStats(vue: HTMLElement, mois = auj().slice(0, 7)) {
  const s = await api<Stats>(`/communes/${commune.slug}/stats?mois=${mois}`)
  const total = s.jours.reduce((a, j) => a + j.affichages, 0)
  const h = s.historique.find(x => x.mois === mois)
  const max = Math.max(1, ...s.jours.map(j => j.affichages))
  const prev = (() => { const [y, m] = mois.split('-').map(Number); return iso(new Date(y, m - 2, 1)).slice(0, 7) })()
  const next = (() => { const [y, m] = mois.split('-').map(Number); return iso(new Date(y, m, 1)).slice(0, 7) })()
  vue.innerHTML = `
    <div class="m-monthnav" style="margin-top:14px"><button class="m-btn small" id="b-prev">← <span class="m-sr">Mois précédent : </span>${fmtMois(prev)}</button><strong>${fmtMois(mois)}</strong>${next <= auj().slice(0, 7) ? `<button class="m-btn small" id="b-next"><span class="m-sr">Mois suivant : </span>${fmtMois(next)} →</button>` : ''}</div>
    <div class="m-kpis">
      <div class="m-kpi">${ic('eye')}<strong>${total}</strong><span>affichages de l'encart</span></div>
      <div class="m-kpi">${ic('click')}<strong>${h?.clics ?? 0}</strong><span>ouvertures de l'application depuis l'encart</span></div>
      <div class="m-kpi">${ic('percent')}<strong>${total ? (((h?.clics ?? 0) * 100) / total).toFixed(1).replace('.', ',') : '0'} %</strong><span>des affichages suivis d'un clic</span></div>
    </div>
    ${total ? '' : `<div style="margin-top:12px">${vide('chart', 'Pas encore d’affichage ce mois-ci : les chiffres apparaissent dès que l’encart est en place sur votre site.')}</div>`}
    <h2>Par jour</h2>
    <div class="m-bars" role="img" aria-label="Affichages par jour en ${fmtMois(mois)}, de 0 à ${max}">${s.jours.map(j => `<div class="${j.affichages ? '' : 'zero'}" style="height:${(j.affichages / max) * 100}%" title="${fmtDate(j.jour)} : ${j.affichages}"></div>`).join('')}</div>
    <div class="m-axis"><span>1er</span><span>${s.jours.length}</span></div>
    <h2>Six derniers mois</h2>
    <div class="m-card m-table" tabindex="0" role="region" aria-label="Six derniers mois"><table><thead><tr><th>Mois</th><th class="n">Affichages</th><th class="n">Clics vers l'application</th></tr></thead>
      <tbody>${s.historique.slice().reverse().map(x => `<tr><td>${fmtMois(x.mois)}</td><td class="n">${x.affichages}</td><td class="n">${x.clics}</td></tr>`).join('')}</tbody></table></div>
    ${s.formats.length ? `<h2>Où l'encart est vu</h2><div class="m-card m-table" tabindex="0" role="region" aria-label="Où l'encart est vu"><table><tbody>
      ${s.sites.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${v}</td></tr>`).join('')}
      <tr><th colspan="2">Formats</th></tr>${s.formats.map(([k, v]) => `<tr><td>${esc({ complet: 'Complet', compact: 'Compact', venir: 'Comment venir' }[k] ?? k)}</td><td class="n">${v}</td></tr>`).join('')}
      <tr><th colspan="2">Appareils</th></tr>${s.appareils.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${v}</td></tr>`).join('')}</tbody></table></div>` : ''}
    <p class="m-small m-muted">Ce sont des affichages, pas des personnes : le service ne collecte ni adresse IP ni cookie. Les robots sont exclus.</p>`
  $('#b-prev', vue).onclick = () => vueStats(vue, prev)
  const n = $('#b-next', vue); if (n) n.onclick = () => vueStats(vue, next)
}

// ------------------------------------------------------------------ code de l'encart

async function vueEncart(vue: HTMLElement) {
  const w = await (await fetch(`./data/${commune.territoire}/widget-${commune.slug}.json`, { cache: 'no-cache' })).json().catch(() => ({ lieux: [] }))
  const { ajouts } = await api<{ ajouts: Lieu[] }>(`/communes/${commune.slug}/lieux`)
  const lieux = [...new Set([...(w.lieux ?? []).map((l: any[]) => l[0] as string), ...ajouts.map(a => a.nom)])].sort((a, b) => a.localeCompare(b, 'fr'))
  const origin = location.origin
  vue.innerHTML = `
    <p class="m-intro">Choisissez le format, copiez le code et collez-le dans un bloc « HTML personnalisé » de votre site. L'encart se met à jour tout seul.</p>
    <section class="m-card">
      <fieldset><legend>Format</legend><div class="m-formats">
        <label class="m-format"><input type="radio" name="fmt" value="complet" checked /><span class="m-schema" aria-hidden="true"><i class="b"></i><i></i><i></i><i class="s"></i><i></i></span><strong>Complet</strong><span>Tous les départs des arrêts de la commune, pour la page « Transports ».</span></label>
        <label class="m-format"><input type="radio" name="fmt" value="compact" /><span class="m-schema" aria-hidden="true"><i class="b"></i><i class="s"></i></span><strong>Compact</strong><span>Un bandeau court, pour l'accueil ou une colonne.</span></label>
        <label class="m-format"><input type="radio" name="fmt" value="venir" /><span class="m-schema" aria-hidden="true"><i class="b"></i><i class="s"></i><i></i></span><strong>Comment venir</strong><span>Arrêts à pied et départs vers un lieu, pour sa page.</span></label></div></fieldset>
      <label class="m-field" id="c-lieu" hidden><span>Lieu</span><select name="lieu">${lieux.map(l => `<option>${esc(l)}</option>`).join('')}</select></label>
      <label class="m-field"><span>Couleur de la commune <small>(liens et bouton)</small></span><input type="color" name="couleur" value="#0f3d3e" style="width:80px;min-height:44px" /></label>
    </section>
    <h2>Aperçu</h2>
    <div class="m-preview"><iframe id="apercu" title="Aperçu de l'encart" style="height:420px"></iframe></div>
    <h2>Code à copier</h2>
    <pre class="m-code" id="code"></pre>
    <div class="m-actions"><button class="m-btn primary" id="b-copier">${ic('code')}Copier le code</button></div>
    <p class="m-small m-muted">Plusieurs encarts sur une même page : le script final n'est à coller qu'une fois. Votre site doit être autorisé à afficher l'encart : écrivez à ${BRAND.contact} si l'aperçu fonctionne ici mais pas chez vous.</p>`
  const maj = () => {
    const fmt = ($<HTMLInputElement>('input[name=fmt]:checked', vue)).value
    $('#c-lieu', vue).hidden = fmt !== 'venir'
    const lieu = ($<HTMLSelectElement>('select[name=lieu]', vue)).value
    const couleur = ($<HTMLInputElement>('input[name=couleur]', vue)).value.replace('#', '')
    const id = `${commune.slug}${fmt === 'complet' ? '' : '-' + fmt}${fmt === 'venir' ? '-' + lieu.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) : ''}`
    const p = new URLSearchParams({ reseau: commune.territoire, commune: commune.slug })
    if (fmt !== 'complet') p.set('format', fmt)
    if (fmt === 'venir') p.set('lieu', lieu)
    if (couleur.toLowerCase() !== '0f3d3e') p.set('couleur', couleur)
    p.set('id', id)
    const src = `${origin}/widget.html?${p.toString()}`
    const titre = fmt === 'venir' ? `Venir en bus : ${lieu}` : fmt === 'compact' ? `Prochains bus à ${commune.nom}` : `Prochains départs des bus à ${commune.nom}`
    const hauteur = fmt === 'compact' ? 170 : fmt === 'venir' ? 420 : 560
    const largeur = fmt === 'venir' ? 520 : 720
    $<HTMLIFrameElement>('#apercu', vue).src = src
    $<HTMLIFrameElement>('#apercu', vue).style.height = hauteur + 'px'
    $('#code', vue).textContent = `<iframe
  src="${src.replace(/&/g, '&amp;')}"
  title="${titre.replace(/"/g, '&quot;')}"
  loading="lazy"
  style="width:100%;max-width:${largeur}px;height:${hauteur}px;border:1px solid #e2ded6;display:block"
  data-maillage="${id}"></iframe>

<!-- À coller une seule fois par page : ajuste la hauteur des encarts -->
<script>
  window.addEventListener('message', function (e) {
    if (e.origin !== '${origin}' || !e.data || e.data.type !== 'maillage-widget-height') return;
    var f = document.querySelector('iframe[data-maillage="' + String(e.data.commune).replace(/[^a-z0-9-]/gi, '') + '"]');
    if (f && e.data.height > 40 && e.data.height < 3000) f.style.height = e.data.height + 'px';
  });
</script>`
  }
  window.addEventListener('message', e => {
    if (e.origin === origin && e.data?.type === 'maillage-widget-height') { const f = $<HTMLIFrameElement>('#apercu', vue); if (f && e.data.height > 40 && e.data.height < 3000) f.style.height = e.data.height + 'px' }
  })
  $$('input, select', vue).forEach(i => (i.oninput = maj))
  $('#b-copier', vue).onclick = async () => { try { await navigator.clipboard.writeText($('#code', vue).textContent ?? ''); statut('Code copié.') } catch { statut('Copie impossible : sélectionnez le code à la main.') } }
  maj()
}

// lien ouvert dans un onglet déjà sur l'espace : seul le fragment change, la page ne se recharge pas
window.addEventListener('hashchange', () => { if (/jeton=/.test(location.hash)) demarrer() })
demarrer()
