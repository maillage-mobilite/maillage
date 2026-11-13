// Lecture minimale du format GTFS-RT (Protocol Buffers), limitée aux mises à jour de courses
// (TripUpdate) : statut de la course, retards et suppressions par arrêt. Aucune dépendance.
// Référence : https://gtfs.org/realtime/reference/

export interface RtStop {
  stopId: string
  /** Retard en secondes à l'arrivée / au départ (si fourni). */
  arrDelay?: number
  depDelay?: number
  /** Heure absolue (secondes Unix) si fournie à la place du retard. */
  arrTime?: number
  depTime?: number
  skipped: boolean
}

export interface RtTrip {
  tripId: string
  startDate?: string // AAAAMMJJ
  canceled: boolean
  delay?: number
  stops: RtStop[]
}

export interface RtFeed { timestamp: number; trips: RtTrip[] }

class Reader {
  pos = 0
  constructor(private b: Uint8Array, private end = b.length) {}
  get done() { return this.pos >= this.end }
  varint(): bigint {
    let r = 0n, shift = 0n
    for (;;) {
      const x = this.b[this.pos++]
      r |= BigInt(x & 0x7f) << shift
      if (x < 0x80) return r
      shift += 7n
    }
  }
  /** int32 / int64 : les négatifs sont codés sur 10 octets en complément à deux. */
  int(): number { const v = this.varint(); return Number(v >= 1n << 63n ? v - (1n << 64n) : v) }
  uint(): number { return Number(this.varint()) }
  bytes(): Uint8Array { const n = this.uint(); const s = this.b.subarray(this.pos, this.pos + n); this.pos += n; return s }
  string(): string { return new TextDecoder().decode(this.bytes()) }
  sub(): Reader { const n = this.uint(); const r = new Reader(this.b, this.pos + n); r.pos = this.pos; this.pos += n; return r }
  skip(wire: number) {
    if (wire === 0) this.varint()
    else if (wire === 1) this.pos += 8
    else if (wire === 2) { const n = this.uint(); this.pos += n } // (« this.pos += this.uint() » lirait pos avant l'avance)
    else if (wire === 5) this.pos += 4
    else throw new Error(`GTFS-RT : type de champ inconnu ${wire}`)
  }
  /** Parcourt les champs : fn(numéro, type) doit consommer le champ ou renvoyer false pour l'ignorer. */
  fields(fn: (field: number, wire: number) => boolean | void) {
    while (!this.done) {
      const key = this.uint()
      const field = key >>> 3, wire = key & 7
      if (fn(field, wire) === false) this.skip(wire)
    }
  }
}

function stopTimeEvent(r: Reader): { delay?: number; time?: number } {
  const e: { delay?: number; time?: number } = {}
  r.fields((f, w) => {
    if (f === 1 && w === 0) e.delay = r.int()
    else if (f === 2 && w === 0) e.time = r.int()
    else return false
  })
  return e
}

function tripUpdate(r: Reader): RtTrip {
  const t: RtTrip = { tripId: '', canceled: false, stops: [] }
  r.fields((f, w) => {
    if (f === 1 && w === 2) {
      const d = r.sub()
      d.fields((g, w2) => {
        if (g === 1 && w2 === 2) t.tripId = d.string()
        else if (g === 3 && w2 === 2) t.startDate = d.string()
        else if (g === 4 && w2 === 0) t.canceled = d.uint() === 3 // CANCELED
        else return false
      })
    } else if (f === 2 && w === 2) {
      const s = r.sub()
      const st: RtStop = { stopId: '', skipped: false }
      s.fields((g, w2) => {
        if (g === 2 && w2 === 2) { const e = stopTimeEvent(s.sub()); st.arrDelay = e.delay; st.arrTime = e.time }
        else if (g === 3 && w2 === 2) { const e = stopTimeEvent(s.sub()); st.depDelay = e.delay; st.depTime = e.time }
        else if (g === 4 && w2 === 2) st.stopId = s.string()
        else if (g === 5 && w2 === 0) st.skipped = s.uint() === 1 // SKIPPED
        else return false
      })
      t.stops.push(st)
    } else if (f === 5 && w === 0) t.delay = r.int()
    else return false
  })
  return t
}

export function decodeTripUpdates(buf: Uint8Array): RtFeed {
  const r = new Reader(buf)
  const feed: RtFeed = { timestamp: 0, trips: [] }
  r.fields((f, w) => {
    if (f === 1 && w === 2) {
      const h = r.sub()
      h.fields((g, w2) => { if (g === 3 && w2 === 0) feed.timestamp = h.uint(); else return false })
    } else if (f === 2 && w === 2) {
      const e = r.sub()
      e.fields((g, w2) => {
        if (g === 3 && w2 === 2) feed.trips.push(tripUpdate(e.sub()))
        else return false
      })
    } else return false
  })
  return feed
}
