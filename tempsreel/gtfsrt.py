"""Lecture minimale du format GTFS-RT (Protocol Buffers), limitée aux mises à jour de courses (TripUpdate).

Bibliothèque standard seulement (pas de dépendance protobuf). Référence : https://gtfs.org/realtime/reference/
Renvoie {"timestamp": int, "trips": [{"trip_id", "start_date", "canceled", "delay", "stops": [...]}]}
où chaque arrêt vaut {"seq", "stop_id", "arr_delay", "arr_time", "dep_delay", "dep_time", "skipped"}.
"""


class _Reader:
    __slots__ = ("b", "pos", "end")

    def __init__(self, b, pos=0, end=None):
        self.b, self.pos, self.end = b, pos, len(b) if end is None else end

    def varint(self):
        r = shift = 0
        while True:
            x = self.b[self.pos]
            self.pos += 1
            r |= (x & 0x7F) << shift
            if x < 0x80:
                return r
            shift += 7

    def int(self):  # int32 / int64 : négatifs en complément à deux sur 64 bits
        v = self.varint()
        return v - (1 << 64) if v >= 1 << 63 else v

    def sub(self):
        n = self.varint()
        r = _Reader(self.b, self.pos, self.pos + n)
        self.pos += n
        return r

    def string(self):
        n = self.varint()
        s = self.b[self.pos:self.pos + n].decode("utf-8", "replace")
        self.pos += n
        return s

    def skip(self, wire):
        if wire == 0:
            self.varint()
        elif wire == 1:
            self.pos += 8
        elif wire == 2:
            n = self.varint()  # (« self.pos += self.varint() » lirait pos avant l'avance)
            self.pos += n
        elif wire == 5:
            self.pos += 4
        else:
            raise ValueError(f"GTFS-RT : type de champ inconnu {wire}")

    def fields(self):
        while self.pos < self.end:
            key = self.varint()
            yield key >> 3, key & 7


def _event(r):
    e = {}
    for f, w in r.fields():
        if f == 1 and w == 0:
            e["delay"] = r.int()
        elif f == 2 and w == 0:
            e["time"] = r.int()
        else:
            r.skip(w)
    return e


def _trip_update(r):
    t = {"trip_id": "", "start_date": None, "canceled": False, "delay": None, "stops": []}
    for f, w in r.fields():
        if f == 1 and w == 2:  # TripDescriptor
            d = r.sub()
            for g, w2 in d.fields():
                if g == 1 and w2 == 2:
                    t["trip_id"] = d.string()
                elif g == 3 and w2 == 2:
                    t["start_date"] = d.string()
                elif g == 4 and w2 == 0:
                    t["canceled"] = d.varint() == 3  # CANCELED
                else:
                    d.skip(w2)
        elif f == 2 and w == 2:  # StopTimeUpdate
            s = r.sub()
            st = {"seq": None, "stop_id": None, "arr_delay": None, "arr_time": None,
                  "dep_delay": None, "dep_time": None, "skipped": False}
            for g, w2 in s.fields():
                if g == 1 and w2 == 0:
                    st["seq"] = s.varint()
                elif g == 2 and w2 == 2:
                    e = _event(s.sub()); st["arr_delay"], st["arr_time"] = e.get("delay"), e.get("time")
                elif g == 3 and w2 == 2:
                    e = _event(s.sub()); st["dep_delay"], st["dep_time"] = e.get("delay"), e.get("time")
                elif g == 4 and w2 == 2:
                    st["stop_id"] = s.string()
                elif g == 5 and w2 == 0:
                    st["skipped"] = s.varint() == 1  # SKIPPED
                else:
                    s.skip(w2)
            t["stops"].append(st)
        elif f == 5 and w == 0:
            t["delay"] = r.int()
        else:
            r.skip(w)
    return t


def decode_trip_updates(buf):
    r = _Reader(memoryview(buf).tobytes() if not isinstance(buf, bytes) else buf)
    feed = {"timestamp": 0, "trips": []}
    for f, w in r.fields():
        if f == 1 and w == 2:  # FeedHeader
            h = r.sub()
            for g, w2 in h.fields():
                if g == 3 and w2 == 0:
                    feed["timestamp"] = h.varint()
                else:
                    h.skip(w2)
        elif f == 2 and w == 2:  # FeedEntity
            e = r.sub()
            for g, w2 in e.fields():
                if g == 3 and w2 == 2:
                    feed["trips"].append(_trip_update(e.sub()))
                else:
                    e.skip(w2)
        else:
            r.skip(w)
    return feed
