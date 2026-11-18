import { defineConfig, type Plugin } from 'vite'
import preact from '@preact/preset-vite'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { resolve } from 'node:path'

/**
 * Éditeur de tracés (editeur.html) : points d'accès du SEUL serveur de développement (`npm run dev`),
 * jamais présents dans le site construit. Ils lisent et écrivent pipeline/tenants/<territoire>-corrections.json,
 * interrogent le moteur OSRM local du territoire et lancent pipeline/apply_corrections.py.
 */
function editeurTraces(): Plugin {
  const root = __dirname
  const tenantFile = (id: string) => resolve(root, 'pipeline/tenants', `${id}.json`)
  const correctionsFile = (id: string) => resolve(root, 'pipeline/tenants', `${id}-corrections.json`)
  const readBody = (req: any) => new Promise<string>((ok, ko) => {
    let s = ''
    req.on('data', (c: Buffer) => { s += c; if (s.length > 5_000_000) ko(new Error('trop gros')) })
    req.on('end', () => ok(s))
  })
  return {
    name: 'editeur-traces',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__editeur', async (req, res) => {
        const send = (code: number, body: unknown) => {
          res.statusCode = code
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify(body))
        }
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const id = url.searchParams.get('reseau') ?? ''
          if (!/^[a-z0-9-]+$/.test(id) || !existsSync(tenantFile(id))) return send(400, { erreur: 'territoire inconnu' })
          const cfg = JSON.parse(readFileSync(tenantFile(id), 'utf8'))
          const osrm: string | undefined = (cfg.match_to_roads?.osrm_url ?? cfg.snap_to_roads?.osrm_url)?.replace(/\/$/, '')

          if (url.pathname === '/corrections' && req.method === 'GET') {
            const f = correctionsFile(id)
            return send(200, existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { version: 1, corrections: [] })
          }
          if (url.pathname === '/corrections' && req.method === 'POST') {
            const doc = JSON.parse(await readBody(req))
            if (!Array.isArray(doc?.corrections)) return send(400, { erreur: 'format' })
            for (const c of doc.corrections) {
              const pt = (p: any) => p && typeof p.lat === 'number' && typeof p.lon === 'number' && typeof p.name === 'string'
              if (typeof c.id !== 'string' || typeof c.route !== 'string' || !pt(c.from) || !pt(c.to) || !Array.isArray(c.coords) || c.coords.length < 2
                || !c.coords.every((x: any) => Array.isArray(x) && x.length === 2 && x.every((v: any) => typeof v === 'number' && Number.isFinite(v)))) {
                return send(400, { erreur: `correction invalide : ${String(c?.id)}` })
              }
            }
            // lisible dans Git : une correction par bloc, chaque point [lon, lat] sur une ligne
            const txt = JSON.stringify({ version: 1, corrections: doc.corrections }, null, 1)
              .replace(/\[\s+(-?[\d.]+),\s+(-?[\d.]+)\s+\]/g, '[$1, $2]')
            writeFileSync(correctionsFile(id), txt + '\n')
            return send(200, { ok: true, n: doc.corrections.length })
          }
          if (url.pathname === '/route' && req.method === 'GET') {
            // itinéraire par la chaussée entre les points donnés (moteur OSRM local du territoire)
            const coords = url.searchParams.get('coords') ?? ''
            if (!osrm || !/^(-?\d+(\.\d+)?,-?\d+(\.\d+)?;){1,24}-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(coords)) return send(400, { erreur: 'points ou moteur absents' })
            const r = await fetch(`${osrm}/route/v1/driving/${coords}?overview=full&geometries=geojson&continue_straight=true`)
            return send(r.status, await r.json())
          }
          if (url.pathname === '/nearest' && req.method === 'POST') {
            // distance de chaque point à la route la plus proche (contrôle des segments droits suspects)
            const pts = JSON.parse(await readBody(req))?.points
            if (!osrm || !Array.isArray(pts) || pts.length > 2000) return send(400, { erreur: 'points ou moteur absents' })
            const out: (number | null)[] = new Array(pts.length).fill(null)
            let next = 0
            await Promise.all(Array.from({ length: 8 }, async () => {
              while (next < pts.length) {
                const k = next++, p = pts[k]
                if (!Array.isArray(p) || !p.every((v: unknown) => typeof v === 'number' && Number.isFinite(v))) continue
                try {
                  const r = await (await fetch(`${osrm}/nearest/v1/driving/${p[0].toFixed(6)},${p[1].toFixed(6)}`)).json()
                  out[k] = r.waypoints?.[0]?.distance ?? null
                } catch { /* moteur indisponible : inconnu */ }
              }
            }))
            return send(200, { distances: out })
          }
          if (url.pathname === '/apply' && req.method === 'POST') {
            execFile('python3', ['-I', 'pipeline/apply_corrections.py', `pipeline/tenants/${id}.json`, '--cache', '.cache', '--out', `public/data/${id}`],
              { cwd: root, timeout: 600_000 }, (err, stdout, stderr) => {
                if (err) return send(500, { erreur: (stderr || err.message).slice(-2000) })
                try { send(200, JSON.parse(stdout.trim().split('\n').pop() ?? '{}')) } catch { send(200, { sortie: stdout }) }
              })
            return
          }
          send(404, { erreur: 'inconnu' })
        } catch (e) {
          send(500, { erreur: String((e as Error).message ?? e) })
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [preact(), editeurTraces()],
  base: './',
  server: { port: 5199, strictPort: true },
  // deux pages publiées : l'application et l'encart « prochains départs » pour les sites des communes
  // (editeur.html, l'éditeur de tracés, n'est servi que par le serveur de développement)
  build: { rollupOptions: { input: { main: 'index.html', widget: 'widget.html' } } },
})
