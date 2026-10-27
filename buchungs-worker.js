// Cloudflare Worker: liest Belegungen aus Apple-Kalendern (öffentliche iCloud-Links) und nimmt Terminanfragen per E-Mail entgegen.
const ALLOWED = ["https://djpax.de", "https://www.djpax.de", "https://djpax1234.github.io"];
const FORMSPREE = "https://formspree.io/f/xgaaowod";
const NAMES = { dj: "DJ Pax", fotobox: "Fotobox", cocktail: "Cocktailmaschine", technik: "Veranstaltungstechnik" };
const SECRET = { dj: "ICS_DJ", fotobox: "ICS_FOTOBOX", cocktail: "ICS_COCKTAIL", technik: "ICS_TECHNIK" };
const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const wall = (d) => { const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; };
const addMin = (w, m) => new Date(Date.UTC(+w.slice(0, 4), +w.slice(5, 7) - 1, +w.slice(8, 10), +w.slice(11, 13), +w.slice(14, 16)) + m * 60000).toISOString().slice(0, 16);
function dt(line) {
  const v = line.slice(line.indexOf(":") + 1).trim();
  if (v.length === 8) return { w: `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T00:00`, a: true };
  if (v.endsWith("Z")) return { w: wall(new Date(Date.UTC(+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8), +v.slice(9, 11), +v.slice(11, 13)))), a: false };
  return { w: `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T${v.slice(9, 11)}:${v.slice(11, 13)}`, a: false };
}
function parse(txt) {
  const out = []; let e = null;
  for (const l of txt.replace(/\r?\n[ \t]/g, "").split(/\r?\n/)) {
    if (l === "BEGIN:VEVENT") e = {};
    else if (l === "END:VEVENT") { if (e && e.s && !e.x) out.push({ s: e.s.w, e: e.e ? e.e.w : addMin(e.s.w, e.s.a ? 1440 : 60), a: e.s.a ? 1 : 0 }); e = null; }
    else if (e) {
      if (l.startsWith("DTSTART")) e.s = dt(l);
      else if (l.startsWith("DTEND")) e.e = dt(l);
      else if (/^STATUS:CANCELLED/i.test(l) || /^TRANSP:TRANSPARENT/i.test(l)) e.x = 1;
    }
  }
  return out;
}
// Belegungen zwischen Datum from und Datum to (einschließlich). null = kein Kalender hinterlegt.
async function busy(env, svc, from, to) {
  const url = env[SECRET[svc]];
  if (!url) return null;
  const r = await fetch(url.replace(/^webcal:/i, "https:"), { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!r.ok) throw new Error("ics " + r.status);
  const a = from + "T00:00", b = addMin(to + "T00:00", 1440);
  return parse(await r.text()).filter((x) => x.s < b && x.e > a);
}
export default {
  async fetch(req, env) {
    const o = req.headers.get("Origin");
    const cors = { "Access-Control-Allow-Origin": ALLOWED.includes(o) ? o : ALLOWED[0], Vary: "Origin", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
    const J = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
    const D = /^\d{4}-\d\d-\d\d$/;
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method === "GET") {
      const q = new URL(req.url).searchParams, svc = q.get("service"), f = q.get("from") || "", t = q.get("to") || "";
      if (!NAMES[svc] || !D.test(f) || !D.test(t)) return J({ error: "bad request" }, 400);
      try { const ev = await busy(env, svc, f, t); return J({ configured: ev !== null, events: ev || [] }); } catch { return J({ error: "calendar" }, 502); }
    }
    if (req.method === "POST") {
      if (!ALLOWED.includes(o)) return J({ error: "forbidden" }, 403);
      let b; try { b = await req.json(); } catch { return J({ error: "bad request" }, 400); }
      if (b._gotcha) return J({ ok: true });
      const c = (v, n) => String(v || "").trim().slice(0, n);
      const svc = b.service, date = c(b.date, 10), start = c(b.start, 5), hours = Math.round(+b.hours), name = c(b.name, 100), email = c(b.email, 120);
      if (!NAMES[svc] || !D.test(date) || !/^\d\d:\d\d$/.test(start) || !(hours >= 1 && hours <= 24) || !name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || b.consent !== true) return J({ error: "bad request" }, 400);
      if (date < wall(new Date()).slice(0, 10)) return J({ error: "past" }, 400);
      const ws = date + "T" + start, we = addMin(ws, hours * 60);
      try { const ev = await busy(env, svc, date, we.slice(0, 10)); if (ev && ev.some((x) => x.s < we && x.e > ws)) return J({ error: "busy" }, 409); } catch {}
      const msg = ["Anfrage über den Buchungskalender", "Leistung: " + NAMES[svc], "Datum: " + date, `Zeit: ${start} Uhr, ${hours} Stunden`, "Eventart: " + c(b.eventType, 40), "Gäste: " + c(b.guests, 10), "Ort: " + c(b.place, 120), "Telefon: " + c(b.phone, 40), "", "Nachricht:", c(b.message, 1500)].join("\n");
      const r = await fetch(FORMSPREE, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ _subject: `Terminanfrage ${NAMES[svc]} am ${date}`, name, email, telefon: c(b.phone, 40), message: msg }) });
      return r.ok ? J({ ok: true }) : J({ error: "mail" }, 502);
    }
    return J({ error: "not allowed" }, 405);
  },
};
