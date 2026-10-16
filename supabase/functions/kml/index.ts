// Live KML for Google Earth Pro (Add › Network Link): every year, by stage, always up to date.
// Public URL guarded by a secret token that the site admin creates on the web.
import { createClient } from "npm:@supabase/supabase-js@2.117.2";

const COLORS = ["#c1272d", "#2f4fb5", "#006233", "#e3a21a", "#b5532c", "#1b8a8a", "#7a3b8f", "#d9662b", "#4f7f2a", "#8c1d40"];
const abgr = (c: string) => "ff" + c.slice(5, 7) + c.slice(3, 5) + c.slice(1, 3);
const xe = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]!));
const natural = (a: string, b: string) => a.localeCompare(b, "es", { numeric: true });
function orderKey(name: string) {
  const n = name.toUpperCase().trim();
  if (/^(DSS|START|SALIDA|DEPART)/.test(n)) return -1;
  if (/^(ASS|FIN|LLEGADA|ARRIV)/.test(n)) return 1e9;
  const m = n.match(/\d+/);
  return m ? parseInt(m[0], 10) : 5e8;
}

Deno.serve(async (req) => {
  const token = new URL(req.url).searchParams.get("t") ?? "";
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: feed } = await db.from("earth_feed").select("token").maybeSingle();
  if (!token || !feed || feed.token !== token) return new Response("No encontrado", { status: 404 });

  const [{ data: rallies }, { data: wps }] = await Promise.all([
    db.from("rallies").select("id, year, name").order("year", { ascending: false }),
    db.from("waypoints").select("rally_id, stage, name, lat, lon, page, descr, seq"),
  ]);
  let styles = "";
  COLORS.forEach((c, i) => { styles += `<Style id="c${i}"><IconStyle><color>${abgr(c)}</color><Icon><href>http://maps.google.com/mapfiles/kml/paddle/wht-blank.png</href></Icon></IconStyle></Style>\n`; });
  let body = "";
  for (const r of rallies ?? []) {
    const mine = (wps ?? []).filter((w) => w.rally_id === r.id);
    if (!mine.length) continue;
    const stages = [...new Set(mine.map((w) => w.stage ?? ""))].sort((a, b) => Number(a === "") - Number(b === "") || natural(a, b));
    body += `<Folder><name>${xe(r.year + " · " + r.name)}</name>\n`;
    stages.forEach((s, si) => {
      body += `<Folder><name>${xe(s ? "Etapa " + s : "Sin etapa")}</name>\n`;
      mine.filter((w) => (w.stage ?? "") === s)
        .sort((a, b) => orderKey(a.name) - orderKey(b.name) || (a.seq ?? 0) - (b.seq ?? 0))
        .forEach((w) => {
          const desc = [w.page ? "Pág " + w.page : "", w.descr].filter(Boolean).join(" · ");
          body += `<Placemark><name>${xe(w.name)}</name><description>${xe(desc)}</description><styleUrl>#c${si % COLORS.length}</styleUrl><Point><coordinates>${w.lon.toFixed(6)},${w.lat.toFixed(6)},0</coordinates></Point></Placemark>\n`;
        });
      body += `</Folder>\n`;
    });
    body += `</Folder>\n`;
  }
  const kml = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Libro de Rallies</name>\n${styles}${body}</Document></kml>\n`;
  return new Response(kml, {
    headers: { "Content-Type": "application/vnd.google-earth.kml+xml; charset=utf-8", "Cache-Control": "no-store" },
  });
});
